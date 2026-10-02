/**
 * The job contract: what goes onto each pg-boss queue.
 *
 * Every payload names the Restow `jobs` row (`jobId`) and the tenant; the
 * worker loads the row, pins Row Level Security to the tenant and dispatches
 * on the queue. Producers (the scheduler, the API for restores and manual
 * runs) and the consumer (apps/worker) all import these types, so the
 * contract lives here in core rather than in either app. apps/scheduler cannot
 * import core (no dependency) and mirrors the payload shapes in its own
 * queues.ts; keep the two in sync.
 */
import type { JobQueue, VerifyKind } from "./types.js";

/** All queues, in the order of the `job_queue` enum in @restow/db. */
export const JOB_QUEUES = [
  "backup",
  "restore",
  "verify",
  "archive",
  "directory",
  "retention",
  "scrub",
  "storage_migration",
  "import",
  "export",
] as const satisfies readonly JobQueue[];

export function isJobQueue(value: string): value is JobQueue {
  return (JOB_QUEUES as readonly string[]).includes(value);
}

/**
 * pg-boss priority per queue (higher runs first). docs/ARCHITECTURE.md fixes
 * restore > verify > backup; the rest rank below so housekeeping never starves
 * user-visible work. `storage_migration` ranks below restore and backup (an
 * admin-initiated background move, not a user waiting on it) and above scrub
 * (a data-moving job still outranks routine integrity checks).
 */
export const JOB_PRIORITY: Record<JobQueue, number> = {
  restore: 100,
  // A person waits for the download link of an export, like for a restore.
  export: 90,
  verify: 80,
  archive: 60,
  // A person brought the files, but reading them is long-running background work.
  import: 50,
  backup: 40,
  directory: 30,
  storage_migration: 25,
  retention: 20,
  scrub: 10,
};

export interface JobPayloadBase {
  /** `jobs.id` of the lifecycle row. */
  readonly jobId: string;
  readonly tenantId: string;
  /** Set when the job was enqueued by a schedule. */
  readonly scheduleId?: string;
  /** Set when the job was queued for a backup job (backup_jobs.id): by the scheduler or "Run now". */
  readonly backupJobId?: string;
}

export interface BackupJobPayload extends JobPayloadBase {
  readonly protectedObjectId: string;
  /** Re-enumerate everything instead of continuing from delta state. */
  readonly full?: boolean;
  /** Queued by "Run now" of a backup job (a person), not planned by the scheduler. */
  readonly runNow?: true;
}

export interface RestoreJobPayload extends JobPayloadBase {
  /** `restore_jobs.id` holding selection, target, mode and actor. */
  readonly restoreJobId: string;
  readonly protectedObjectId: string;
}

export interface VerifyJobPayload extends JobPayloadBase {
  readonly protectedObjectId: string;
  readonly kind: VerifyKind;
  readonly sampleSize?: number;
  /** Queued by the worker right after a backup of the object (not by a person or a schedule). */
  readonly afterBackup?: true;
}

export interface ArchiveJobPayload extends JobPayloadBase {
  /** The mailbox to sync into the archive; omitted for a source-wide pass. */
  readonly protectedObjectId?: string;
  /** The source whose mailboxes are synced when no single object is named. */
  readonly sourceId?: string;
  readonly capture: "graph_sync" | "imap_sync";
}

export interface DirectoryJobPayload extends JobPayloadBase {
  readonly sourceId: string;
}

export interface RetentionJobPayload extends JobPayloadBase {
  /** Report what would be deleted without deleting. */
  readonly dryRun?: boolean;
}

export interface ScrubJobPayload extends JobPayloadBase {
  /** `sample` checks a random subset of packs, `full` every pack. */
  readonly mode: "sample" | "full";
}

/** Moves a tenant's backups from one storage target to another (`storage_migrations` row). */
export interface StorageMigrationJobPayload extends JobPayloadBase {
  readonly migrationId: string;
}

/** Reads mail files into an imported mailbox (`mail_imports` row, docs/IMPORT.md). */
export interface ImportJobPayload extends JobPayloadBase {
  readonly importId: string;
  /** The imported mailbox the new snapshot belongs to. */
  readonly protectedObjectId: string;
}

/** Builds an EML ZIP or MBOX for a download (`mail_exports` row, docs/IMPORT.md). */
export interface ExportJobPayload extends JobPayloadBase {
  readonly exportId: string;
  /** The exported object for snapshot exports; absent for archive exports. */
  readonly protectedObjectId?: string;
}

export interface JobPayloads {
  backup: BackupJobPayload;
  restore: RestoreJobPayload;
  verify: VerifyJobPayload;
  archive: ArchiveJobPayload;
  directory: DirectoryJobPayload;
  retention: RetentionJobPayload;
  scrub: ScrubJobPayload;
  storage_migration: StorageMigrationJobPayload;
  import: ImportJobPayload;
  export: ExportJobPayload;
}

export type JobPayload = JobPayloads[JobQueue];

/**
 * pg-boss singleton key: at most one queued and one active job per key on
 * queues with the `stately` policy. Restores are never deduplicated.
 */
export function singletonKeyFor<Q extends JobQueue>(
  queue: Q,
  payload: JobPayloads[Q],
): string | null {
  switch (queue) {
    case "backup":
    case "verify":
      return `${queue}:${(payload as BackupJobPayload | VerifyJobPayload).protectedObjectId}`;
    case "archive": {
      const archive = payload as ArchiveJobPayload;
      const target = archive.protectedObjectId ?? archive.sourceId ?? "tenant";
      return `archive:${payload.tenantId}:${target}`;
    }
    case "directory":
      return `directory:${(payload as DirectoryJobPayload).sourceId}`;
    case "retention":
    case "scrub":
      return `${queue}:${payload.tenantId}`;
    case "storage_migration":
      return `storage_migration:${(payload as StorageMigrationJobPayload).migrationId}`;
    case "import":
      // One import at a time per imported mailbox: each writes the next snapshot of it,
      // and a second one running side by side would not see the first one's messages.
      return `import:${(payload as ImportJobPayload).protectedObjectId}`;
    case "restore":
    case "export":
      return null;
    default:
      return null;
  }
}
