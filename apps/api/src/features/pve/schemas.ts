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
});

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
      }),
    )
    .max(10_000)
    .nullish()
    .transform((v) => v ?? []),
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
    .record(z.unknown())
    .nullish()
    .transform((v) => v ?? undefined),
});

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
    .record(z.unknown())
    .nullish()
    .transform((v) => v ?? undefined),
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
  kind: z.enum(["daily", "interval"]),
  timeOfDay: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
  intervalMinutes: z
    .number()
    .int()
    .min(60)
    .max(7 * 24 * 60)
    .optional(),
  timeZone: z.string().min(1).max(64),
});

const retention = z.object({
  keepDaily: z.number().int().min(0).max(3650),
  keepWeekly: z.number().int().min(0).max(520),
  keepMonthly: z.number().int().min(0).max(240),
});

export const jobSchema = z.object({
  name,
  scopeAll: z.boolean().default(false),
  schedule: schedule.nullable(),
  enabled: z.boolean().default(true),
  settings: z
    .object({
      mode: z.enum(["snapshot", "suspend", "stop"]).optional(),
      retention: retention.optional(),
      verifyReadEvery: z.number().int().min(1).max(365).optional(),
      restoreTest: z
        .object({ enabled: z.boolean(), targetStorage: storageId.optional() })
        .optional(),
      bandwidthKbps: z.number().int().min(0).nullable().optional(),
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

export const assignJobSchema = z.object({ jobId: uuid.nullable() });

export const backupNowSchema = z.object({ verifyRead: z.boolean().default(false) });

export const restoreSchema = z.object({
  targetNode: z.string().max(64).optional(),
  targetStorage: storageId,
  targetVmid: vmid.optional(),
  start: z.boolean().default(false),
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
