import {
  MAX_BOOT_TEST_MEMORY_MIB,
  MAX_BOOT_TEST_TIMEOUT_SECONDS,
  MIN_BOOT_TEST_MEMORY_MIB,
  MIN_BOOT_TEST_TIMEOUT_SECONDS,
} from "@restow/core";
import { z } from "zod";
import { MAX_BROWSE_LIMIT, MAX_DOWNLOAD_PATHS, snapshotPath } from "../endpoints/schemas.js";

const uuid = z.string().uuid();
const name = z.string().trim().min(1).max(200);
const device = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const storageId = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);
const vmid = z.number().int().min(100).max(999_999_999);

export const enrollSchema = z.object({
  token: z.string().min(10).max(200),
  clusterName: name,
  clusterFingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "the SHA-256 of the cluster CA certificate"),
  nodeName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/),
  pveVersion: z.string().max(64),
  helperVersion: z.string().max(64),
  fleecingStorage: z.string().max(64).default(""),
});

export const enrollPreflightSchema = z.object({ token: z.string().min(10).max(200) });

/**
 * A PVE API token id: `user@realm!name` (the characters PVE allows for realm and
 * token name; the user part limited to what is safe in the installer's shell).
 */
export const PVE_TOKEN_ID_RE = /^[A-Za-z0-9._-]+@[A-Za-z][A-Za-z0-9._-]+![A-Za-z][A-Za-z0-9._-]+$/;

/** The optional existing PVE API token for an enrollment (docs/PVE.md, onboarding). */
export const createTokenSchema = z.object({
  pveToken: z
    .object({
      id: z.string().trim().max(200).regex(PVE_TOKEN_ID_RE, "user@realm!name"),
      // PVE generates a UUID; any token secret is URL- and shell-safe.
      secret: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9._-]{16,128}$/, "the secret PVE showed when the token was created"),
    })
    .optional(),
});

export const heartbeatSchema = z.object({
  helperVersion: z.string().max(64),
  pveVersion: z.string().max(64).default(""),
  fleecingStorage: z.string().max(64).default(""),
  pluginLoaded: z.boolean().default(false),
  state: z.enum(["idle", "running"]).default("idle"),
  problems: z
    .array(z.string().max(64))
    .max(50)
    .nullish()
    .transform((v) => v ?? []),
  restoresAllowed: z.boolean().default(true),
  /** The backup runs the node works on (restow-pve 0.4.0 and later; older helpers omit it). */
  activeRuns: z.array(z.string().uuid()).max(64).optional(),
  /**
   * The task kinds beyond the original set the node runs (restow-pve with boot tests sends
   * ["boot_test"]); absent from older helpers, which then never get such a task.
   */
  capabilities: z.array(z.string().max(64)).max(32).optional(),
  /**
   * The tasks the node holds (docs/PVE-PROTOCOL.md, "Tasks the node holds"): the one it runs and
   * the ones in its local queue, with those whose result it keeps to send again. Absent from
   * older helpers, whose delivered tasks are then judged by their runs alone.
   */
  heldTasks: z
    .object({
      current: z.string().uuid().nullish(),
      queued: z.array(z.string().uuid()).max(64).default([]),
    })
    .optional(),
});

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const inventorySchema = z.object({
  guests: z
    .array(
      z.object({
        vmid,
        kind: z.enum(["vm", "ct"]),
        name: z.string().max(200).default(""),
        node: z.string().max(64).default(""),
        status: z.string().max(32).default(""),
        template: z.boolean().default(false),
        privileged: z.boolean().default(false),
        tags: z
          .array(z.string().max(64))
          .nullish()
          .transform((v) => v ?? []),
        pool: z.string().max(64).default(""),
        disks: z
          .array(
            z.object({ device, size: z.number().int().min(0), backup: z.boolean().default(true) }),
          )
          .nullish()
          .transform((v) => v ?? []),
        agent: z.boolean().default(false),
        // A VM's SMBIOS UUID (restow-pve from 0.4.2): finds the Restow server's own VM.
        smbiosUuid: z
          .string()
          .max(64)
          .nullish()
          .transform((v) => (v && UUID_TEXT.test(v) ? v.toLowerCase() : null)),
      }),
    )
    .max(10_000)
    .nullish()
    .transform((v) => v ?? []),
  /**
   * Every guest of the cluster with the node it runs on, from /cluster/resources (restow-pve
   * from 0.5.0). Absent from an older node, or null when the node could not read the list: then
   * only the node's own guests count (an older server ignores it).
   */
  clusterGuests: z
    .array(
      z.object({
        vmid,
        node: z.string().min(1).max(64),
        type: z
          .enum(["qemu", "lxc", "vm", "ct"])
          .transform((t) => (t === "qemu" || t === "vm" ? "vm" : "ct")),
      }),
    )
    .max(20_000)
    .nullish()
    .transform((v) => v ?? null),
});

/**
 * An error text from the node: kept, but cut to 4000 characters. A longer one
 * (restic lists every unreadable file) used to be refused with 422, the node
 * only logged that, and the run stayed "running".
 */
const nodeErrorText = z
  .string()
  .max(1024 * 1024)
  .transform((s) => s.slice(0, 4000));

export const taskResultSchema = z.object({
  status: z.enum(["done", "failed"]),
  error: nodeErrorText.optional(),
  result: z
    .record(z.string(), z.unknown())
    .nullish()
    .transform((v) => v ?? undefined),
});

/** A list of short lines from the node; an unreadable one is dropped, never the whole result. */
const lines = (max: number) => z.array(z.string().max(1000)).max(max).optional().catch(undefined);

/**
 * What a restore task's result says beside "done" (docs/PVE-PROTOCOL.md, "Task `restore`"),
 * as the node fills it: each field optional, an unreadable field dropped. A restore or restore
 * check that has any of `warnings`, `skippedLxc`, `omittedMounts`, `keptDevices`, a guest it
 * could not remove (`deleted: false`) or a start that did not happen is shown amber, never
 * green (apps/web pve/run-status.ts).
 */
export const restoreResultSchema = z
  .object({
    vmid: z.number().int().min(0).optional().catch(undefined),
    upid: z.string().max(200).optional().catch(undefined),
    exitStatus: z.string().max(200).optional().catch(undefined),
    /** The restore task ended `WARNINGS: n`: the warning lines of its log. */
    warnings: lines(20),
    /** Raw `lxc.*` lines PVE restores only for root@pam (skipped for the node's token). */
    skippedLxc: lines(64),
    customIdmap: z.boolean().optional().catch(undefined),
    /** Bind and device mount points left out (their data is not in the backup). */
    omittedMounts: lines(64),
    /** A restore into a new guest: the commands that put them back, as root. */
    remountCommands: lines(64),
    /** Host devices (PCI, USB) the copy uses, as the original does. */
    keptDevices: lines(64),
    madeUnprivileged: z.boolean().optional().catch(undefined),
    onbootCleared: z.boolean().optional().catch(undefined),
    restoredAsRoot: z.boolean().optional().catch(undefined),
    /** A check: the disks of the restored guest and whether it was removed again. */
    disks: z.number().int().min(0).optional().catch(undefined),
    deleted: z.boolean().optional().catch(undefined),
    leftoverVmid: z.number().int().min(0).optional().catch(undefined),
    /** "Start after the restore": whether the copy runs, and why not. */
    started: z.boolean().optional().catch(undefined),
    startError: z.string().max(2000).optional().catch(undefined),
    startSkipped: z.string().max(200).optional().catch(undefined),
    /**
     * A restore check the node did not run (no_storage, storage_inactive, storage_content,
     * storage_space, restores_off): not a result about the restore point.
     */
    skipped: z
      .object({
        reason: z.string().max(64),
        message: z.string().max(2000).default(""),
      })
      .optional()
      .catch(undefined),
  })
  .strip();

export type PveRestoreResult = z.infer<typeof restoreResultSchema>;

export const openRunSchema = z.object({
  vmid,
  kind: z.enum(["vm", "ct"]),
  archiveName: z.string().max(80),
  storageId,
  startedAt: z.string().max(40),
  node: z.string().max(64).optional(),
});

export const incrementalSchema = z.object({
  devices: z
    .array(z.object({ device, size: z.number().int().min(1) }))
    .min(1)
    .max(64),
});

/** How many unreadable items a container restore point names. */
export const UNREADABLE_PATHS_KEPT = 20;

export const commitSchema = z.object({
  commitId: uuid,
  devices: z
    .array(
      z.object({
        device,
        size: z.number().int().min(1),
        bitmapMode: z.enum(["none", "new", "reuse"]),
        readBytes: z.number().int().min(0).default(0),
        uploadedBytes: z.number().int().min(0).default(0),
        changedBlocks: z.number().int().min(0).default(0),
        zeroBlocks: z.number().int().min(0).default(0),
        hashSkipped: z.number().int().min(0).default(0),
      }),
    )
    .max(64)
    .optional(),
  guestConfig: z
    .string()
    .max(512 * 1024)
    .default(""),
  firewallConfig: z
    .string()
    .max(512 * 1024)
    .nullable()
    .default(null),
  resticSnapshotId: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  resticBytesAdded: z.number().int().min(0).optional(),
  // Container backups, for the ransomware signals (docs/RANSOMWARE.md): restic's file counts and
  // the activity report (nodes from 0.4.0 on; an older node sends none, a malformed one is dropped).
  resticFilesNew: z.number().int().min(0).optional().catch(undefined),
  resticFilesChanged: z.number().int().min(0).optional().catch(undefined),
  resticFilesTotal: z.number().int().min(0).optional().catch(undefined),
  // What restic stored for the new data, compressed (nodes from 0.4.x on), for the compression
  // signal; an older node sends none.
  resticBytesAddedPacked: z.number().int().min(0).optional().catch(undefined),
  activity: z.unknown().optional(),
  resticTotalBytes: z.number().int().min(0).optional(),
  resticRoot: z.string().max(4096).optional(),
  pveVersion: z.string().max(64).optional(),
  /** Container backups: restic could not read this many items (exit 3); the restore point misses them. */
  resticUnreadable: z.number().int().min(0).optional(),
  /** One line on what the restore point misses (the first unreadable item). */
  consistency: z
    .string()
    .max(1024 * 1024)
    .transform((s) => s.slice(0, 2000))
    .optional(),
  /** The first items restic could not read (restow-pve 0.4 and newer), kept for the run. */
  resticUnreadablePaths: z
    .array(z.string().max(4096))
    .max(1000)
    .transform((paths) => paths.slice(0, UNREADABLE_PATHS_KEPT))
    .optional(),
});

/**
 * POST /runs/:runId/progress: how far a running backup is (#51). Bytes read
 * so far, the total to read once known, and what was uploaded (a VM's changed
 * blocks; a container leaves it out).
 */
export const progressSchema = z.object({
  bytesDone: z.number().int().min(0),
  bytesTotal: z.number().int().min(0).nullish(),
  bytesUploaded: z.number().int().min(0).nullish(),
});

export const finishSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  error: nodeErrorText.optional(),
  stats: z
    .record(z.string(), z.unknown())
    .nullish()
    .transform((v) => v ?? undefined),
});

/** The end of a container restore started in the PVE UI (docs/PVE-PROTOCOL.md). */
export const restoreEndSchema = z.object({
  status: z.enum(["succeeded", "warnings", "failed"]),
  exitStatus: z.string().max(2000),
  warnings: z.array(z.string().max(1000)).max(20).optional(),
  error: nodeErrorText.optional(),
});

export const logSchema = z.object({ log: z.string().max(256 * 1024) });

export const runParamSchema = z.object({ runId: uuid });
export const taskParamSchema = z.object({ taskId: uuid });
export const snapshotDiskParamSchema = z.object({ snapshotId: uuid, device });
export const snapshotParamSchema = z.object({ snapshotId: uuid });
export const volnameQuerySchema = z.object({ volname: z.string().max(120) });
export const blocksQuerySchema = z.object({
  from: z.coerce.number().int().min(0),
  count: z.coerce.number().int().min(1).max(16),
});

// --- session API -------------------------------------------------------------

export const idParamSchema = z.object({ id: uuid });

const schedule = z.object({
  kind: z.enum(["daily", "interval", "cron"]),
  // Weekdays, monthly or a custom expression (the mail jobs' cadences); planned by pveNextRunAt.
  cron: z.string().trim().min(9).max(120).optional(),
  timeOfDay: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
  // Every few hours (a backup more often than hourly is not planned), up to a month as for mail.
  intervalMinutes: z
    .number()
    .int()
    .min(60)
    .max(31 * 24 * 60)
    .optional(),
  timeZone: z.string().min(1).max(64),
});

const retention = z.object({
  keepDaily: z.number().int().min(0).max(3650),
  keepWeekly: z.number().int().min(0).max(520),
  keepMonthly: z.number().int().min(0).max(240),
});

/**
 * Job settings an earlier Restow took and stored but never applied: no upload limit reached the
 * node, and its full read stays every 30th backup. Refused with 422 until they work, and left out
 * of every job the API shows, so a job saved with them before can be edited as it is.
 */
export const UNSUPPORTED_PVE_JOB_SETTINGS = ["bandwidthKbps", "verifyReadEvery"] as const;

/** A job's stored settings without {@link UNSUPPORTED_PVE_JOB_SETTINGS}. */
export function supportedJobSettings<T extends object>(settings: T): T {
  const out = { ...settings } as Record<string, unknown>;
  for (const key of UNSUPPORTED_PVE_JOB_SETTINGS) {
    delete out[key];
  }
  return out as T;
}

export const jobSchema = z.object({
  name,
  scopeAll: z.boolean().default(false),
  schedule: schedule.nullable(),
  enabled: z.boolean().default(true),
  settings: z
    .object({
      mode: z.enum(["snapshot", "suspend", "stop"]).optional(),
      retention: retention.optional(),
      restoreTest: z
        .object({ enabled: z.boolean(), targetStorage: storageId.optional() })
        .optional(),
      bootTest: z
        .object({
          schedule: z.enum(["off", "weekly", "after_backup"]),
          maxMemoryMiB: z
            .number()
            .int()
            .min(MIN_BOOT_TEST_MEMORY_MIB)
            .max(MAX_BOOT_TEST_MEMORY_MIB)
            .optional(),
          timeoutSeconds: z
            .number()
            .int()
            .min(MIN_BOOT_TEST_TIMEOUT_SECONDS)
            .max(MAX_BOOT_TEST_TIMEOUT_SECONDS)
            .optional(),
        })
        .optional(),
    })
    .default({}),
});

export const assignJobSchema = z.object({
  jobId: uuid.nullable(),
  /** Put the Restow server's own VM into the job anyway (docs/PVE.md). */
  confirmSelfBackup: z.boolean().optional(),
});

export const restowServerSchema = z.object({ flagged: z.boolean() });

export const guestExcludedSchema = z.object({ excluded: z.boolean() });

export const backupNowSchema = z.object({
  verifyRead: z.boolean().default(false),
  /** Back up the Restow server's own VM anyway (docs/PVE.md). */
  confirmSelfBackup: z.boolean().optional(),
});

/** Reset a container's repository: the guest's name typed as confirmation. */
export const resetRepositorySchema = z.object({ confirmName: z.string().max(200) }).strict();

export const restoreSchema = z.object({
  targetNode: z.string().max(64).optional(),
  targetStorage: storageId,
  targetVmid: vmid.optional(),
  start: z.boolean().default(false),
  /** Use `targetVmid` although a deleted guest Restow keeps had it (409 otherwise). */
  confirmVmidReuse: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// File restore of containers (#62)
// ---------------------------------------------------------------------------

/** One page of a folder of a container restore point (`GET /snapshots/:id/files`). */
export const filesQuerySchema = z.object({
  path: snapshotPath.default("/"),
  limit: z.coerce.number().int().min(1).max(MAX_BROWSE_LIMIT).default(1000),
  /** The `nextCursor` of the previous page; absent for the first page. */
  cursor: z.string().min(1).max(2048).optional(),
});

/** The files and folders of a ZIP download; the restore point is in the path. */
export const createFilesDownloadSchema = z.object({
  paths: z.array(snapshotPath).min(1).max(MAX_DOWNLOAD_PATHS),
});

export const filesDownloadParamSchema = z.object({ id: uuid, downloadId: uuid });

export type FilesQuery = z.infer<typeof filesQuerySchema>;
export type CreateFilesDownloadInput = z.infer<typeof createFilesDownloadSchema>;
