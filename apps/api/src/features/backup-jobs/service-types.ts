import type { HostResolver, RunnerClient } from "@restow/core";

/** Who acts: the signed-in administrator, or the system (the migration). */
export interface JobActor {
  userId: string | null;
  label: string;
  ip: string | null;
}

/** The system as an actor (the migration of an older installation). */
export const SYSTEM_ACTOR: JobActor = { userId: null, label: "system", ip: null };

/** What a change needs besides its input. */
export interface JobContext {
  now: Date;
  /**
   * Called before anything is written when a hook is set or changed (it runs as root on a
   * machine); throws to refuse the whole change (the route passes the recent-sign-in check).
   */
  confirmHookChange?: () => void;
  /** File share copy jobs: the mounter and the name resolution (tests replace them). */
  fileShares?: { runner?: RunnerClient; resolve?: HostResolver };
}

export const BACKUP_JOB_AUDIT_ACTIONS = {
  created: "backup_job.created",
  updated: "backup_job.updated",
  deleted: "backup_job.deleted",
  scopeChanged: "backup_job.scope.changed",
  runRequested: "backup_job.run_requested",
  migrated: "backup_job.migrated",
} as const;
