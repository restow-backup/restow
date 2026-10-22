import type { StoredUpdateRelease } from "@restow/db";
import { featureHook } from "../../extensions.js";
import type { DbExecutor } from "../../lib/tenant-context.js";

/**
 * Extension point: which releases the installation's licence covers. The core
 * knows no licence; an extension (ee/api, the licence module) answers with the
 * update terms of the installed key (docs/LICENSING.md, "Updates"). Without an
 * answer (the Community build, no key installed) every release is covered.
 *
 * The update check uses it to show which offered release lies outside the
 * update period and to refuse installing such a release; the started release
 * checks the same terms again before it touches the database
 * (ee/api/src/license/startup-check.ts), so the two never disagree as long as
 * both read the same release date (the `released:` line of the notes, the date
 * the image carries).
 */

/** A release as the coverage is decided on: its version and its release date. */
export interface CoveredRelease {
  version: string;
  /** ISO-8601; null when the release names none. */
  releasedAt: string | null;
}

export interface UpdateCoverage {
  /** The last day of the update period (`YYYY-MM-DD`); null for a key without one. */
  readonly coveredUntil: string | null;
  /** The series a key without update period covers (`"1"`: 1.x and every 0.x). */
  readonly series: string | null;
  covers(release: CoveredRelease): boolean;
}

/** Loads the coverage of the installed licence; null when nothing restricts updates. */
export type UpdateCoverageLoader = (db: DbExecutor) => Promise<UpdateCoverage | null>;

declare module "../../extensions.js" {
  interface FeatureHooks {
    updateCoverage: UpdateCoverageLoader;
  }
}

export async function loadUpdateCoverage(db: DbExecutor): Promise<UpdateCoverage | null> {
  const loader = featureHook("updateCoverage");
  return loader ? loader(db) : null;
}

/**
 * The date a release is judged by: the `released:` line it publishes, else (releases
 * before 0.4.5) when it was published, which is never earlier than its images were made.
 */
export function coveredReleaseOf(release: StoredUpdateRelease): CoveredRelease {
  return { version: release.version, releasedAt: release.releasedAt ?? release.publishedAt };
}
