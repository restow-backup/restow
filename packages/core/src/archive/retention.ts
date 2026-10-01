/**
 * Pure retention math (docs/ARCHIVE.md, the retention and deletion section).
 * No side effects, no storage access: the deletion run (ARCHIVE-JOURNAL)
 * decides what to do with the answer, this module only computes it.
 */

/** When the retention clock starts. */
export type RetentionMode =
  | "from_capture"
  | /** AO §147 Abs. 4: the period starts at the end of the capture year. */ "end_of_year";

/** Selectable retention lengths (docs/ARCHIVE.md); `null` means unlimited. */
export type RetentionYears = 6 | 8 | 10 | null;

export interface RetentionPolicy {
  readonly mode: RetentionMode;
  readonly years: RetentionYears;
}

/**
 * The date an item may be deleted from, or `null` for unlimited retention.
 *
 * - `from_capture`: exactly `years` years after `receivedAt`.
 * - `end_of_year`: the AO §147 Abs. 4 calculation — the clock starts at the
 *   end of the calendar year `receivedAt` falls in, then runs `years` full
 *   calendar years, so the item becomes deletable on 1 January of
 *   `year(receivedAt) + years + 1`. A document captured on 31 December is
 *   treated the same as one captured on 1 January of that year: only the
 *   calendar year matters, not the day within it.
 */
export function retentionUntil(receivedAt: Date, policy: RetentionPolicy): Date | null {
  if (policy.years === null) {
    return null;
  }
  if (policy.mode === "from_capture") {
    const until = new Date(receivedAt.getTime());
    until.setUTCFullYear(until.getUTCFullYear() + policy.years);
    return until;
  }
  const captureYear = receivedAt.getUTCFullYear();
  return new Date(Date.UTC(captureYear + policy.years + 1, 0, 1, 0, 0, 0, 0));
}

/**
 * Whether an item may be deleted right now by a retention run: past its
 * retention date, and not under legal hold. A hold blocks deletion
 * unconditionally, regardless of how far past `retentionUntilDate` the item
 * is (docs/ARCHIVE.md: a legal hold blocks deletion).
 */
export function isDueForDeletion(
  retentionUntilDate: Date | null,
  legalHold: boolean,
  now: Date,
): boolean {
  if (legalHold) {
    return false;
  }
  if (retentionUntilDate === null) {
    return false;
  }
  return now.getTime() >= retentionUntilDate.getTime();
}
