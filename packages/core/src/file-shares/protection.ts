/**
 * Whether a file share counts as protected, and the facts every overview derives from it
 * (docs/FILESHARES.md section 13). One rule, pure; the api mirrors it in SQL (Phase C).
 *
 *   protected   not retired and a member of an enabled share job
 *   failed      the newest finished backup run of a protected share failed
 *   overdue     no successful backup for longer than the enabled jobs' schedules allow
 *
 * Copy jobs are never protection.
 */
import { staleBackupHours } from "../backup-jobs/schedule.js";
import type { JobSchedule } from "../backup-jobs/types.js";

export interface ShareProtectionShare {
  id: string;
  retiredAt: Date | null;
  createdAt: Date;
  lastSuccessAt: Date | null;
}

export interface ShareProtectionJob {
  id: string;
  kind: string;
  enabled: boolean;
  schedule: JobSchedule | null;
  createdAt: Date;
}

export interface ShareProtectionMember {
  jobId: string;
  fileShareId: string | null;
  overrides?: { schedule?: JobSchedule | null } | null;
}

/** The enabled share job a share is a member of, or null. */
export function shareJobOf(
  share: Pick<ShareProtectionShare, "id">,
  jobs: readonly ShareProtectionJob[],
  members: readonly ShareProtectionMember[],
): ShareProtectionJob | null {
  const member = members.find((m) => m.fileShareId === share.id);
  if (!member) {
    return null;
  }
  return jobs.find((job) => job.id === member.jobId && job.kind === "share" && job.enabled) ?? null;
}

/** Whether a share is protected: not retired and in an enabled share job. */
export function shareProtected(
  share: Pick<ShareProtectionShare, "id" | "retiredAt">,
  jobs: readonly ShareProtectionJob[],
  members: readonly ShareProtectionMember[],
): boolean {
  return share.retiredAt === null && shareJobOf(share, jobs, members) !== null;
}

/**
 * After how many hours without a successful backup a share reads as overdue: twice the longest
 * planned gap of its job's (or its member's) schedule, two days without one.
 */
export function shareStaleBackupHours(
  share: Pick<ShareProtectionShare, "id">,
  jobs: readonly ShareProtectionJob[],
  members: readonly ShareProtectionMember[],
  now: Date,
): number {
  const job = shareJobOf(share, jobs, members);
  const member = members.find((m) => m.fileShareId === share.id);
  const schedule = member?.overrides?.schedule ?? job?.schedule ?? null;
  return staleBackupHours([schedule], now);
}

/** The time an overdue judgement counts from: the newest success, else when protection began. */
export function shareProtectedSince(
  share: Pick<ShareProtectionShare, "createdAt" | "lastSuccessAt">,
  job: Pick<ShareProtectionJob, "createdAt"> | null,
): Date {
  if (share.lastSuccessAt) {
    return share.lastSuccessAt;
  }
  return job && job.createdAt > share.createdAt ? job.createdAt : share.createdAt;
}
