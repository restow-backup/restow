import { z } from "zod";

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

export const taskResultSchema = z.object({
  status: z.enum(["done", "failed"]),
  error: z.string().max(4000).optional(),
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
  resticTotalBytes: z.number().int().min(0).optional(),
  resticRoot: z.string().max(4096).optional(),
  pveVersion: z.string().max(64).optional(),
});

export const finishSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  error: z.string().max(4000).optional(),
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
