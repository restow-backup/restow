/**
 * Page-level walk of a drive's root delta.
 *
 * The generic syncDelta helper hides page URLs; a resumable backup needs them,
 * because the job cursor records "the page I was on and the last item I
 * finished in it". This walker yields every page together with the URL it was
 * fetched from, and applies the docs/MICROSOFT.md rule for 410 Gone: drop the
 * token and enumerate this drive again from scratch (OneDrive names the fresh
 * URL in the `Location` header), signalling `reset` so the caller discards
 * what earlier pages of the same walk produced.
 */
import type { GraphClient } from "../../graph/client.js";
import type { DeltaMode } from "../../graph/delta.js";
import { isGone } from "../../graph/errors.js";
import { type DriveDeltaItem, driveDeltaUrl } from "../../graph/resources/drive.js";

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
  // One restart per walk. A checkpointed resync may itself start from a page
  // link that has expired, so the guard counts restarts rather than the mode.
  let restarts = 0;

  for (;;) {
    let pages = 0;
    let items = 0;
    try {
      let pageUrl = url;
      for await (const page of options.client.delta<DriveDeltaItem>(url)) {
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
      if (!isGone(error) || restarts >= 1) {
        throw error;
      }
      restarts += 1;
      const nextUrl = error.headers.location ?? initialUrl;
      options.onResync?.({ nextUrl, discardedPages: pages });
      url = nextUrl;
      mode = "resync";
      reset = pages > 0;
    }
  }
}
