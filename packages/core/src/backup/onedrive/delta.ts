/**
 * Page-level walk of a drive's root delta.
 *
 * The generic syncDelta helper hides page URLs; a resumable backup needs them,
 * because the job cursor records "the page I was on and the last item I
 * finished in it". This walker yields every page together with the URL it was
 * fetched from, and applies the docs/MICROSOFT.md rule for 410 Gone: drop the
 * token and enumerate this drive again from scratch (OneDrive names the fresh
 * URL in the `Location` header), signalling `reset` so the caller discards
 * what earlier pages of the same walk produced. Every page asks for sharing
 * changes too ({@link DRIVE_DELTA_HEADERS}).
 *
 * The URL of the `Location` header can answer 410 itself: a delta link stored
 * before 0.5.0, which did not yet send `Prefer: deltashowsharingchanges`, is
 * refused with `resyncRequired`, and so is the resync URL Graph hands out for
 * it. The walk then starts once more from the plain delta URL, which carries no
 * token Graph could refuse. 0.5.0 gave up after the second 410 and kept the old
 * link, so every later run of the drive failed the same way.
 */
import type { GraphClient } from "../../graph/client.js";
import type { DeltaMode } from "../../graph/delta.js";
import { isGone } from "../../graph/errors.js";
import {
  DRIVE_DELTA_HEADERS,
  type DriveDeltaItem,
  driveDeltaUrl,
} from "../../graph/resources/drive.js";

/** Where a walk starts: a stored delta link, a page link from a checkpoint, or nothing (full enumeration). */
export interface DeltaStart {
  readonly url: string | null;
  readonly mode: DeltaMode;
}

export interface DrivePage {
  /** The URL this page came from; resuming from it yields the same items again. */
  readonly url: string;
  readonly mode: DeltaMode;
  readonly items: DriveDeltaItem[];
  readonly nextLink: string | undefined;
  readonly deltaLink: string | undefined;
  /** True on the first page after a 410 forced a restart mid-walk. */
  readonly reset: boolean;
}

export interface DriveWalkOutcome {
  readonly mode: DeltaMode;
  /** The link the next incremental run continues from. */
  readonly deltaLink: string;
  readonly pages: number;
  readonly items: number;
}

export interface DriveWalkOptions {
  readonly client: GraphClient;
  readonly driveId: string;
  readonly start: DeltaStart;
  readonly onResync?: (info: { nextUrl: string; discardedPages: number }) => void;
}

export async function* walkDriveDelta(
  options: DriveWalkOptions,
): AsyncGenerator<DrivePage, DriveWalkOutcome, unknown> {
  const initialUrl = driveDeltaUrl(options.driveId);
  let url = options.start.url ?? initialUrl;
  let mode: DeltaMode = options.start.url === null ? "initial" : options.start.mode;
  let reset = false;
  // At most two restarts per walk: to the Location of the first 410 (or the
  // plain delta URL), and when that answers 410 as well, to the plain delta URL.
  // A checkpointed resync may itself start from a page link that has expired, so
  // the guard counts restarts rather than the mode.
  let restarts = 0;

  for (;;) {
    let pages = 0;
    let items = 0;
    try {
      let pageUrl = url;
      for await (const page of options.client.delta<DriveDeltaItem>(url, {
        ...DRIVE_DELTA_HEADERS,
      })) {
        pages += 1;
        items += page.value.length;
        yield {
          url: pageUrl,
          mode,
          items: page.value,
          nextLink: page.nextLink,
          deltaLink: page.deltaLink,
          reset,
        };
        reset = false;
        if (page.deltaLink) {
          return { mode, deltaLink: page.deltaLink, pages, items };
        }
        if (!page.nextLink) {
          break;
        }
        pageUrl = page.nextLink;
      }
      throw new Error(`delta walk of drive ${options.driveId} ended without a delta link`);
    } catch (error) {
      if (!isGone(error)) {
        throw error;
      }
      let nextUrl: string;
      if (restarts === 0) {
        nextUrl = error.headers.location ?? initialUrl;
      } else if (restarts === 1 && url !== initialUrl) {
        nextUrl = initialUrl;
      } else {
        throw error;
      }
      restarts += 1;
      options.onResync?.({ nextUrl, discardedPages: pages });
      url = nextUrl;
      mode = "resync";
      // Pages of an earlier attempt still need discarding when this one yielded none.
      reset = reset || pages > 0;
    }
  }
}
