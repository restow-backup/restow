/**
 * The SQL rating of one database on the machine page (W2a, docs/BAREMETAL-WINDOWS.md 5.1.7):
 *
 *   not_protected  no backup of it in the repository;
 *   unverified     backed up, but no check came to a result yet;
 *   green          the last check that came to a result was green, at most 8 days ago;
 *   red            the last check that came to a result was red (with evidence);
 *   overdue        the last green check is more than 8 days old.
 *
 * Incomplete checks rate nothing: they leave the rating where it was.
 */

export type SqlDatabaseRating = "not_protected" | "unverified" | "green" | "red" | "overdue";

export const SQL_GREEN_VALID_MS = 8 * 24 * 60 * 60 * 1000;

export interface SqlRatingInput {
  /** The newest active backup of the database; null when there is none. */
  lastBackupAt: Date | null;
  /** The newest check that came to a result (green or red); null when none did. */
  lastResult: { outcome: "green" | "red"; checkedAt: Date } | null;
  now: Date;
}

export function rateSqlDatabase(input: SqlRatingInput): SqlDatabaseRating {
  if (input.lastBackupAt === null) {
    return "not_protected";
  }
  if (input.lastResult === null) {
    return "unverified";
  }
  if (input.lastResult.outcome === "red") {
    return "red";
  }
  return input.now.getTime() - input.lastResult.checkedAt.getTime() > SQL_GREEN_VALID_MS
    ? "overdue"
    : "green";
}
