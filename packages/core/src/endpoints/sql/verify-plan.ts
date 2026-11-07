/**
 * The plan of the SQL checks (W2a, docs/BAREMETAL-WINDOWS.md 5.1.7): once a week at the job's
 * check slot (weekday and time in the zone of the job's schedule), one `sql_verify` task per
 * instance with the newest active full of each database. The worker's monitor plans them
 * (apps/worker endpoints/sql-verify-plan.ts), the "Check now" button of the machine page builds
 * the same task (apps/api features/endpoints/sql.ts). Pure: no database, no clock.
 */
import { localParts, zonedTimeToUtc } from "../../schedule/cron.js";
import type { SqlBackupFile } from "./schemas.js";
import type { SqlVerifySettings } from "./settings.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A `sql_verify` task nobody picked up is stale after a week. */
export const SQL_VERIFY_TASK_TTL_MS = 7 * DAY_MS;

/** At most this many databases in one task; the rest wait for the next slot. */
export const MAX_SQL_VERIFY_DATABASES = 100;

/** Day of the week of a calendar date: 1 = Monday ... 7 = Sunday. */
function isoWeekday(year: number, month: number, day: number): number {
  const sunday0 = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return sunday0 === 0 ? 7 : sunday0;
}

/**
 * The newest start of the check slot at or before `now` (within the last 8 days); null when the
 * slot is malformed. A slot that falls into a daylight-saving gap starts an hour later.
 */
export function latestSqlVerifySlot(
  verify: Pick<SqlVerifySettings, "weekday" | "time">,
  timeZone: string,
  now: Date,
): Date | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(verify.time);
  if (!match || !Number.isInteger(verify.weekday) || verify.weekday < 1 || verify.weekday > 7) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  for (let back = 0; back <= 8; back++) {
    const day = localParts(new Date(now.getTime() - back * DAY_MS), timeZone);
    if (isoWeekday(day.year, day.month, day.day) !== verify.weekday) {
      continue;
    }
    const at =
      zonedTimeToUtc({ year: day.year, month: day.month, day: day.day, hour, minute }, timeZone) ??
      zonedTimeToUtc(
        { year: day.year, month: day.month, day: day.day, hour: hour + 1, minute },
        timeZone,
      );
    if (at && at.getTime() <= now.getTime()) {
      return at;
    }
  }
  return null;
}

/**
 * Whether the check of an instance is due: the slot has begun, and no check of the instance was
 * planned since it began. `lastPlannedAt` is when the newest planned `sql_verify` task of the
 * instance was created (null: never).
 */
export function sqlVerifyDue(
  verify: SqlVerifySettings,
  timeZone: string,
  lastPlannedAt: Date | null,
  now: Date,
): boolean {
  if (!verify.enabled) {
    return false;
  }
  const slot = latestSqlVerifySlot(verify, timeZone, now);
  if (slot === null) {
    return false;
  }
  return lastPlannedAt === null || lastPlannedAt.getTime() < slot.getTime();
}

/** A database to check and its newest active full. */
export interface SqlVerifyCandidate {
  databaseId: string;
  name: string;
  usedBytes: number;
  backup: {
    id: string;
    snapshotId: string;
    pathInSnapshot: string;
    sha256: string;
    bytes: number;
    fileList: SqlBackupFile[];
  };
}

export interface SqlVerifyTaskParams {
  instance: string;
  maxGiB: number;
  physicalOnly: boolean;
  databases: {
    databaseId: string;
    backupId: string;
    name: string;
    snapshotId: string;
    pathInSnapshot: string;
    sha256: string;
    bytes: number;
    usedBytes: number;
    fileList: SqlBackupFile[];
  }[];
}

/** The params of one `sql_verify` task (task-sql-verify.json); null when nothing is to check. */
export function sqlVerifyTaskParams(
  instance: string,
  verify: Pick<SqlVerifySettings, "maxGiB" | "physicalOnly">,
  candidates: readonly SqlVerifyCandidate[],
): SqlVerifyTaskParams | null {
  const databases = [...candidates]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_SQL_VERIFY_DATABASES)
    .map((candidate) => ({
      databaseId: candidate.databaseId,
      backupId: candidate.backup.id,
      name: candidate.name,
      snapshotId: candidate.backup.snapshotId,
      pathInSnapshot: candidate.backup.pathInSnapshot,
      sha256: candidate.backup.sha256,
      bytes: candidate.backup.bytes,
      // The used pages decide PHYSICAL_ONLY; without them, the size of the backup is near enough.
      usedBytes: candidate.usedBytes > 0 ? candidate.usedBytes : candidate.backup.bytes,
      fileList: candidate.backup.fileList,
    }));
  if (databases.length === 0) {
    return null;
  }
  return { instance, maxGiB: verify.maxGiB, physicalOnly: verify.physicalOnly, databases };
}
