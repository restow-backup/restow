/**
 * The rating of one database (docs/DATABASES.md 2.4): `not_protected`, `unverified`, `green`,
 * `red`, `overdue`. Green only after a real restore check (6); reachability is shown beside the
 * rating and never changes it. Stage D1 has no backups and no checks yet, so every database
 * rates `not_protected` (excluded, or never backed up); the inputs for backups and checks are
 * here so the later stages only feed them.
 */

export const DB_RATINGS = ["red", "overdue", "unverified", "not_protected", "green"] as const;
export type DbRating = (typeof DB_RATINGS)[number];

export interface DbRatingInput {
  /** Left out by the connection's selection, the connection paused, or the database dropped. */
  excluded: boolean;
  lastBackupAt: Date | null;
  lastGreenCheckAt: Date | null;
  /** The newest check was red (another SHA-256, a failed restore, missing objects). */
  lastCheckRed: boolean;
  intervalMinutes: number;
  now: Date;
}

/** A green check older than this makes the database overdue (2.4). */
export const DB_GREEN_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
/** A backup older than three schedules, at least 24 hours, makes it overdue (2.4). */
export const DB_BACKUP_OVERDUE_MIN_MS = 24 * 60 * 60 * 1000;

export function rateDatabase(input: DbRatingInput): DbRating {
  if (input.excluded || input.lastBackupAt === null) {
    return "not_protected";
  }
  if (input.lastCheckRed) {
    return "red";
  }
  const now = input.now.getTime();
  const backupLimit = Math.max(input.intervalMinutes * 3 * 60 * 1000, DB_BACKUP_OVERDUE_MIN_MS);
  if (now - input.lastBackupAt.getTime() > backupLimit) {
    return "overdue";
  }
  if (input.lastGreenCheckAt === null) {
    return "unverified";
  }
  if (now - input.lastGreenCheckAt.getTime() > DB_GREEN_MAX_AGE_MS) {
    return "overdue";
  }
  return "green";
}

/**
 * The order of the list (2.3): red first, then not reachable, overdue, unverified; within a rank
 * by name. `reachable` false puts a database right after the red ones.
 */
export function dbListRank(rating: DbRating, reachable: boolean | null): number {
  if (rating === "red") {
    return 0;
  }
  if (reachable === false) {
    return 1;
  }
  return 2 + DB_RATINGS.indexOf(rating);
}
