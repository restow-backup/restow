/**
 * The pg-boss queues of file share backup (docs/FILESHARES.md 8.1), shaped like the endpoint
 * queues (../endpoints/queues.ts): their own queues next to the tenant queues, created by the
 * worker and the scheduler from these settings. A run itself is a database row and a runner
 * container, never a pg-boss job, so none of them waits for a backup (8.3).
 */
export const FILE_SHARE_QUEUES = {
  /** A due backup of a share: inserts a queued run for the dispatcher. */
  backup: "file-share-backup",
  /** A due copy job: inserts a queued restore run (4.10). */
  copy: "file-share-copy",
  /** The server's processing of a run's finish report (8.3). */
  finish: "file-share-finish",
  /** restic forget and prune with the job's keep rules. */
  retention: "file-share-retention",
  /** restic check of a slice of the data. */
  check: "file-share-check",
  /** The restore check of the newest restore point (its samples read back). */
  verify: "file-share-verify",
  /** The search catalog from `restic diff` (8.5). */
  catalog: "file-share-catalog",
  /** Stale, vanished and late runs, cancellations, overdue alerts. */
  monitor: "file-share-monitor",
  /** Delete a share's backups (8.6). */
  purge: "file-share-purge",
} as const;

export type FileShareQueue = (typeof FILE_SHARE_QUEUES)[keyof typeof FILE_SHARE_QUEUES];

export interface FileShareQueueSettings {
  readonly name: FileShareQueue;
  readonly policy: "stately";
  readonly retryLimit: number;
  readonly retryDelay: number;
  readonly retryBackoff: boolean;
  readonly expireInHours: number;
  readonly retentionDays: number;
}

function settings(
  name: FileShareQueue,
  retryLimit: number,
  retryDelay: number,
  expireInHours: number,
  retentionDays = 14,
  retryBackoff = true,
): FileShareQueueSettings {
  return {
    name,
    policy: "stately",
    retryLimit,
    retryDelay,
    retryBackoff,
    expireInHours,
    retentionDays,
  };
}

export const FILE_SHARE_QUEUE_SETTINGS: Readonly<Record<FileShareQueue, FileShareQueueSettings>> = {
  [FILE_SHARE_QUEUES.backup]: settings(FILE_SHARE_QUEUES.backup, 2, 30, 1, 7),
  [FILE_SHARE_QUEUES.copy]: settings(FILE_SHARE_QUEUES.copy, 2, 30, 1, 7),
  [FILE_SHARE_QUEUES.finish]: settings(FILE_SHARE_QUEUES.finish, 5, 30, 2, 7),
  [FILE_SHARE_QUEUES.retention]: settings(FILE_SHARE_QUEUES.retention, 3, 300, 12),
  [FILE_SHARE_QUEUES.check]: settings(FILE_SHARE_QUEUES.check, 3, 300, 12),
  [FILE_SHARE_QUEUES.verify]: settings(FILE_SHARE_QUEUES.verify, 3, 120, 4),
  [FILE_SHARE_QUEUES.catalog]: settings(FILE_SHARE_QUEUES.catalog, 3, 300, 12),
  [FILE_SHARE_QUEUES.monitor]: settings(FILE_SHARE_QUEUES.monitor, 1, 60, 1, 3, false),
  [FILE_SHARE_QUEUES.purge]: settings(FILE_SHARE_QUEUES.purge, 5, 300, 12),
};

/** `file-share-backup`: one share of a job (or a manual run the api queued). */
export interface FileShareBackupPayload {
  tenantId: string;
  fileShareId: string;
  backupJobId: string | null;
  trigger: "schedule" | "manual" | "retry";
  /** The schedule's interval in minutes: a run that would wait longer is dropped (8.2). */
  intervalMinutes?: number | null;
}

/** `file-share-copy`: one copy job. */
export interface FileShareCopyPayload {
  tenantId: string;
  backupJobId: string;
  /** "Copy anyway" (rule 6 of 4.10). */
  force?: boolean;
}

/** `file-share-finish`: one run whose finish the api recorded. */
export interface FileShareFinishPayload {
  tenantId: string;
  runId: string;
}

/** The maintenance jobs of one share: retention, check, verify, catalog, purge. */
export interface FileShareJobPayload {
  tenantId: string;
  fileShareId: string;
  /** `file-share-check`: the share of the pack files to read, in percent. */
  subsetPercent?: number;
  /** `file-share-verify`: test again although this restore point was tested before. */
  force?: boolean;
  /** `file-share-catalog`: the restore point to catalogue (file_share_snapshots.id). */
  snapshotId?: string;
}

/** pg-boss singleton key: one queued and one active job per share (or job) and kind. */
export function fileShareSingletonKey(queue: FileShareQueue, id: string): string {
  return `${queue}:${id}`;
}

/** How often each maintenance job is due. */
export const FILE_SHARE_JOB_INTERVALS_MS = {
  retention: 24 * 60 * 60 * 1000,
  check: 7 * 24 * 60 * 60 * 1000,
  monitor: 60 * 1000,
} as const;

/** The share of the repository the weekly check reads (8.4). */
export const DEFAULT_SHARE_CHECK_SUBSET_PERCENT = 5;
