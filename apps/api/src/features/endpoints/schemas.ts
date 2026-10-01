import {
  ENDPOINT_ARCH,
  ENDPOINT_OS,
  ENDPOINT_PROFILES,
  type EndpointOsName,
  MAX_ENDPOINT_QUOTA_GIB,
  isValidTimeZone,
} from "@restow/core";
import { z } from "zod";

/**
 * Request schemas of the endpoint feature: the agent contract
 * (`/agent/v1/*`, docs/AGENT.md) and the session API the web app uses.
 * Unknown fields are ignored, so a newer agent can send more than this
 * server reads; every text field has a length limit.
 */

const uuid = z.string().uuid();
const shortText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().max(max).optional();
const isoDate = z
  .string()
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), "not a date");

/**
 * A restic snapshot id or a prefix of one (8 to 64 hex digits). restic prints
 * and matches ids in lower case, and so does the agent (an upper-case id in a
 * task fails there with `invalid_task`): the server takes either case and
 * stores, compares and hands out the lower-case form only.
 */
export const snapshotIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{8,64}$/, "not a restic snapshot id")
  .transform((value) => value.toLowerCase());

export const profileSchema = z.enum(ENDPOINT_PROFILES);
export const osSchema = z.enum(ENDPOINT_OS);
export const archSchema = z.enum(ENDPOINT_ARCH);

// ---------------------------------------------------------------------------
// Agent API
// ---------------------------------------------------------------------------

/** The machine's local hook policy as the agent reports it; absent until it has (agents of earlier pre-release installations do not). */
export const hookPolicySchema = z.enum(["off", "scripts", "any"]);

/** A script name in the hooks folder of a machine (scripts policy): a plain file name. */
export const HOOK_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const enrollSchema = z.object({
  token: shortText(200),
  hostname: shortText(253),
  os: shortText(20),
  arch: archSchema,
  agentVersion: shortText(64),
  osVersion: z.string().trim().max(200).default(""),
  // An unknown value is read as "off": the agent decides, the server only shows it.
  hooks: hookPolicySchema.optional().catch("off"),
});

export const heartbeatSchema = z.object({
  agentVersion: shortText(64),
  osVersion: z.string().trim().max(200).default(""),
  state: z.enum(["idle", "running"]),
  nextRunAt: isoDate.nullish(),
  // A number, or a numeric string (and "" when the agent does not know its version yet).
  configVersion: z
    .union([z.number().int().min(0), z.string().regex(/^\d*$/).max(9)])
    .nullish()
    .transform((value) =>
      value === null || value === undefined || value === "" ? null : Number(value),
    ),
  hooks: hookPolicySchema.optional().catch("off"),
  hookScripts: z
    .array(z.string())
    .max(200)
    .optional()
    .catch(undefined)
    .transform((names) => names?.filter((name) => HOOK_SCRIPT_NAME.test(name)).slice(0, 50)),
});

export const startRunSchema = z.object({
  kind: z.enum(["backup", "restore", "verify_sample"]),
  taskId: uuid.nullish(),
  startedAt: isoDate,
});

export const progressSchema = z.object({
  filesDone: z.number().int().min(0),
  bytesDone: z.number().min(0),
  totalFiles: z.number().int().min(0).optional(),
  totalBytes: z.number().min(0).optional(),
  currentPath: optionalText(4096),
});

const MAX_ERRORS = 200;

/**
 * What a `verify_sample` run observed (agent 0.1.0 and later, docs/AGENT.md):
 * the server judges it (@restow/core `judgeAgentRestoreTest`). A report that
 * does not fit is dropped rather than refused, so the run still ends: without
 * it the test rates nothing and is tried again.
 */
const restoreTestSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(4096),
        sha256: z
          .string()
          .regex(/^[0-9a-fA-F]{64}$/)
          .transform((value) => value.toLowerCase())
          .optional(),
        missing: z.boolean().optional(),
        error: z.string().max(2000).optional(),
      }),
    )
    .max(100)
    .default([]),
  restic: z
    .object({
      exitCode: z.number().int(),
      fatal: z.string().max(4000).default(""),
      errors: z
        .array(z.object({ item: z.string().max(8192).default(""), message: z.string().max(4000) }))
        .max(100)
        .default([]),
    })
    .optional(),
});
export const MAX_LOG_TAIL_BYTES = 64 * 1024;
export const MAX_SAMPLES = 20;

export const finishRunSchema = z.object({
  status: z.enum(["succeeded", "partial", "failed"]),
  finishedAt: isoDate,
  snapshotId: snapshotIdSchema.optional(),
  stats: z
    .object({
      filesNew: z.number().optional(),
      filesChanged: z.number().optional(),
      filesUnmodified: z.number().optional(),
      dataAdded: z.number().optional(),
      totalFilesProcessed: z.number().optional(),
      totalBytesProcessed: z.number().optional(),
    })
    .optional(),
  sample: z
    .array(
      z.object({
        // Exactly as restic names the file: a name may end in a space, and a trimmed path is
        // not in the snapshot (the restore test would rate a sound backup red).
        path: z.string().min(1).max(4096),
        sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
        // An agent leaves the size out for an empty file.
        size: z.number().int().min(0).default(0),
      }),
    )
    .max(MAX_SAMPLES)
    .optional(),
  errors: z
    .array(
      z.object({
        path: optionalText(4096),
        message: z.string().max(2000),
        code: optionalText(100),
      }),
    )
    .max(MAX_ERRORS * 5)
    .default([]),
  // The agent sends its last 200 log lines; the whole body may reach half a megabyte.
  logTail: z
    .string()
    .max(768 * 1024)
    .default(""),
  restoreTest: restoreTestSchema.optional().catch(undefined),
});

export const runIdParamSchema = z.object({ runId: uuid });

// ---------------------------------------------------------------------------
// Configuration (session API)
// ---------------------------------------------------------------------------

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");
const zone = z
  .string()
  .max(64)
  .refine(isValidTimeZone, "not an IANA time zone such as Europe/Berlin");

export const scheduleSchema = z
  .object({
    kind: z.enum(["interval", "daily", "on_connect"]),
    intervalMinutes: z
      .number()
      .int()
      .min(5)
      .max(7 * 24 * 60)
      .optional(),
    timeOfDay: timeOfDay.optional(),
    timeZone: zone,
  })
  .superRefine((value, context) => {
    if (value.kind === "interval" && value.intervalMinutes === undefined) {
      context.addIssue({ code: "custom", path: ["intervalMinutes"], message: "required" });
    }
    if (value.kind === "daily" && value.timeOfDay === undefined) {
      context.addIssue({ code: "custom", path: ["timeOfDay"], message: "required" });
    }
  });

/** Absolute paths only; no control characters. */
const absolutePath = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  .refine((value) => !/[\u0000-\u001f]/.test(value), "contains control characters")
  .refine((value) => /^(\/|[A-Za-z]:[\\/])/.test(value), "must be an absolute path");

const excludePattern = z
  .string()
  .trim()
  .min(1)
  .max(512)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  .refine((value) => !/[\u0000-\u001f]/.test(value), "contains control characters");

const hookCommand = z.string().max(4096);

export const retentionSchema = z.object({
  keepDaily: z.number().int().min(0).max(3650),
  keepWeekly: z.number().int().min(0).max(520),
  keepMonthly: z.number().int().min(0).max(240),
});

export const updateEndpointSchema = z
  .object({
    displayName: z.string().trim().max(200).nullable().optional(),
    config: z
      .object({
        schedule: scheduleSchema.optional(),
        paths: z.array(absolutePath).min(1).max(200).optional(),
        excludes: z.array(excludePattern).max(500).optional(),
        hooks: z.object({ pre: hookCommand.optional(), post: hookCommand.optional() }).optional(),
        bandwidthKbps: z.number().int().min(1).max(10_000_000).nullable().optional(),
        onlyOnAcPower: z.boolean().optional(),
      })
      .optional(),
    settings: z
      .object({
        retention: retentionSchema.optional(),
        staleAfterHours: z
          .number()
          .int()
          .min(1)
          .max(24 * 30)
          .optional(),
        staleAfterDays: z.number().int().min(1).max(365).optional(),
        // The storage budget of this endpoint in GiB; null returns to the installation's default.
        quotaGib: z.number().int().min(1).max(MAX_ENDPOINT_QUOTA_GIB).nullable().optional(),
      })
      .optional(),
  })
  .refine(
    (value) =>
      value.displayName !== undefined || value.config !== undefined || value.settings !== undefined,
    "nothing to change",
  );

// ---------------------------------------------------------------------------
// Session API
// ---------------------------------------------------------------------------

export const createTokenSchema = z.object({
  profile: profileSchema,
  os: osSchema,
  displayName: z.string().trim().max(200).optional(),
});

export const listEndpointsQuerySchema = z.object({
  profile: profileSchema.optional(),
});

/** `valid` (default): tokens that can still be used; `all`: every state, for a look back. */
export const listTokensQuerySchema = z.object({
  state: z.enum(["valid", "all"]).default("valid"),
});

export const endpointIdParamSchema = z.object({ id: uuid });
export const tokenIdParamSchema = z.object({ tokenId: uuid });
export const runParamSchema = z.object({ id: uuid, runId: uuid });

export const listRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const snapshotId = snapshotIdSchema;
const snapshotPath = z
  .string()
  .min(1)
  .max(4096)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  .refine((value) => !/[\u0000-\u001f]/.test(value), "contains control characters")
  .refine((value) => value.startsWith("/"), "must be an absolute path");

/** Entries a browse page holds at most; a folder with more is read page by page. */
export const MAX_BROWSE_LIMIT = 5000;

export const browseQuerySchema = z.object({
  snapshotId,
  path: snapshotPath.default("/"),
  limit: z.coerce.number().int().min(1).max(MAX_BROWSE_LIMIT).default(1000),
  /** The `nextCursor` of the previous page; absent for the first page. */
  cursor: z.string().min(1).max(2048).optional(),
});

/** Paths one ZIP download takes; the paths travel in the body, not in a URL. */
export const MAX_DOWNLOAD_PATHS = 10_000;
/** The request body of a download: room for the paths above at a normal length. */
export const MAX_DOWNLOAD_BODY_BYTES = 4 * 1024 * 1024;

export const createDownloadSchema = z.object({
  snapshotId,
  paths: z.array(snapshotPath).min(1).max(MAX_DOWNLOAD_PATHS),
});

export const downloadParamSchema = z.object({ id: uuid, downloadId: uuid });

/**
 * A restore folder on a Linux or macOS machine: absolute and in plain form
 * (no "." or ".." segment, no double or trailing slash), never the root. The
 * agent checks the same and more (who may change the folders above it).
 */
export const restoreTargetSchema = z
  .string()
  .max(1024)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  .refine((value) => !/[\u0000-\u001f]/.test(value), "contains control characters")
  .refine((value) => value.startsWith("/") && value !== "/", "must be an absolute path below /")
  .refine(
    (value) =>
      !value.endsWith("/") &&
      value
        .slice(1)
        .split("/")
        .every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    'must be a plain path without ".", ".." or double slashes',
  );

export const createTaskSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("backup_now") }),
  z.object({
    kind: z.literal("restore"),
    snapshotId,
    paths: z.array(snapshotPath).min(1).max(200),
    targetDir: restoreTargetSchema.optional(),
  }),
]);

/** The tenant-wide switch for automatic agent updates. */
export const agentUpdatesSchema = z.object({ paused: z.boolean() });

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type HookPolicy = z.infer<typeof hookPolicySchema>;
export type CreateDownloadInput = z.infer<typeof createDownloadSchema>;
export type UpdateEndpointInput = z.infer<typeof updateEndpointSchema>;
export type EnrollInput = z.infer<typeof enrollSchema>;
export type HeartbeatInput = z.infer<typeof heartbeatSchema>;
export type FinishRunInput = z.infer<typeof finishRunSchema>;
export type ProgressInput = z.infer<typeof progressSchema>;
export type StartRunInput = z.infer<typeof startRunSchema>;
export type { EndpointOsName };
export { MAX_ERRORS };
