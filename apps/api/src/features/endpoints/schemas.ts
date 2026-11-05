import {
  DEFAULT_REBIND_VALIDITY_HOURS,
  DEFAULT_RECOVERY_VALIDITY_HOURS,
  ENDPOINT_ARCH,
  ENDPOINT_OS,
  ENDPOINT_PROFILES,
  type EndpointOsName,
  isValidTimeZone,
  MAX_BANDWIDTH_KBPS,
  MAX_BANDWIDTH_WINDOWS,
  MAX_ENDPOINT_QUOTA_GIB,
  MAX_REBIND_VALIDITY_HOURS,
  MAX_RECOVERY_VALIDITY_HOURS,
  noControlChars,
  RECOVERY_LOG_MAX_LINES,
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

/**
 * What the agent says about the machine (agent 0.4.0 and later, #59): container or virtual
 * machine, a desktop. Absent from an earlier agent; anything that does not fit is dropped rather
 * than refused, so the enrollment or heartbeat still counts.
 */
export const machineFactsSchema = z
  .object({
    virtualization: z.enum(["container", "vm", "none"]),
    technology: z
      .string()
      .max(64)
      .transform((value) => value.replace(/[^a-z0-9_-]/gi, "").slice(0, 32)),
    desktop: z.boolean(),
  })
  .optional()
  .catch(undefined);

/**
 * The data folders an agent found (agent 0.4.0 and later): names only; the service keeps those of
 * the fixed list (@restow/core `cleanDataFolderReport`). Null or absent: not reported.
 */
export const dataFoldersSchema = z
  .array(z.string().max(256))
  .max(50)
  .nullish()
  .catch(undefined)
  .transform((value) => value ?? undefined)
  .optional();

export const enrollSchema = z.object({
  token: shortText(200),
  hostname: shortText(253),
  os: shortText(20),
  arch: archSchema,
  agentVersion: shortText(64),
  osVersion: z.string().trim().max(200).default(""),
  // An unknown value is read as "off": the agent decides, the server only shows it.
  hooks: hookPolicySchema.optional().catch("off"),
  machine: machineFactsSchema,
  dataFolders: dataFoldersSchema,
});

/** A code of what a due backup waits for, or "" for nothing. */
export const AGENT_WAITING_CODE = /^(?:[a-z][a-z0-9_]{0,39})?$/;

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
    .transform((names) => names?.filter((name) => HOOK_SCRIPT_NAME.test(name)).slice(0, 50))
    .optional(),
  machine: machineFactsSchema,
  dataFolders: dataFoldersSchema,
  /**
   * What a due backup waits for (agent 0.4.0): a code such as `backup_window`, `update_pause` or
   * `ac_power`; "" when nothing waits; absent from an older agent (unknown). A code that is not
   * plausible counts as absent, so it never costs the agent its heartbeat; a code a later agent
   * may add is kept and shown as "waiting".
   */
  waiting: z.string().regex(AGENT_WAITING_CODE).optional().catch(undefined),
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
      // What restic stored for the new data, compressed (agent 0.4.x and newer).
      dataAddedPacked: z.number().optional(),
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
  // What the backup changed against the previous snapshot (agents from 0.4.0 on): the activity
  // report of the ransomware signals (docs/RANSOMWARE.md), checked and bounded where it is used
  // (@restow/core parseActivityReport). An older agent sends none; a malformed one is dropped.
  activity: z.unknown().optional(),
  // Whether a file system snapshot was used (agents from 0.5.0 on): checked and bounded where it is
  // kept (@restow/core parseRunConsistency); an older agent sends none, a malformed one is dropped.
  consistency: z.unknown().optional(),
  // The layout manifest of a whole machine backup (agents from 0.5.0 on, docs/BAREMETAL.md 4.3):
  // checked where it is stored (@restow/core parseLayoutManifest, at most 512 KiB canonical); a
  // refused one leaves the run as reported and adds the hint `layout_rejected`.
  layout: z.unknown().optional(),
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
    // `none`: no backups (a machine in no job); any other kind only comes from a backup job.
    kind: z.enum(["interval", "daily", "on_connect", "none"]),
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
export const absolutePath = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  .refine((value) => !/[\u0000-\u001f]/.test(value), "contains control characters")
  .refine((value) => /^(\/|[A-Za-z]:[\\/])/.test(value), "must be an absolute path");

export const excludePattern = z
  .string()
  .trim()
  .min(1)
  .max(512)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  .refine((value) => !/[\u0000-\u001f]/.test(value), "contains control characters");

export const hookCommand = z.string().max(4096);

/**
 * A time window of the upload limit (@restow/core backup-jobs/bandwidth.ts): the days it starts
 * on (1 = Monday ... 7 = Sunday), local start and end, the limit in kbit/s (0 = unlimited). The
 * shape is checked here; that windows do not overlap is checked by the service, which names the
 * window.
 */
export const bandwidthWindowSchema = z.object({
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  from: timeOfDay,
  to: timeOfDay,
  kbps: z.number().int().min(0).max(MAX_BANDWIDTH_KBPS),
});

export const bandwidthWindowsSchema = z.array(bandwidthWindowSchema).max(MAX_BANDWIDTH_WINDOWS);

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
        // Time windows with a limit of their own (only for a machine in no job); null or [] removes them.
        bandwidthWindows: bandwidthWindowsSchema.nullable().optional(),
        onlyOnAcPower: z.boolean().optional(),
        // The shadow copy of a Windows machine (VSS); refused for other systems.
        useVss: z.boolean().optional(),
        // File system snapshots of a Linux machine (LVM, btrfs); null returns to the default.
        fsSnapshot: z.enum(["auto", "off"]).nullable().optional(),
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
        // Days without contact before the machine suggests revoking it (#65).
        revokeHintAfterDays: z.number().int().min(1).max(3650).optional(),
        // The storage budget of this endpoint in GiB; null returns to the installation's default.
        quotaGib: z.number().int().min(1).max(MAX_ENDPOINT_QUOTA_GIB).nullable().optional(),
      })
      .optional(),
    // The person of the tenant's protection directory the machine is assigned to; null removes it.
    assignedUserId: uuid.nullable().optional(),
  })
  .refine(
    (value) =>
      value.displayName !== undefined ||
      value.config !== undefined ||
      value.settings !== undefined ||
      value.assignedUserId !== undefined,
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

/** POST /:id/remove (#65): how the backups go, and the hostname typed to confirm. */
export const removeEndpointSchema = z
  .object({
    mode: z.enum(["delete", "expire"]),
    confirmHostname: z.string().max(300),
  })
  .strict();
export const tokenIdParamSchema = z.object({ tokenId: uuid });
export const runParamSchema = z.object({ id: uuid, runId: uuid });
/** A restic snapshot id is the hex SHA-256 of the snapshot file. */
export const snapshotImmutabilityParamSchema = z.object({
  id: uuid,
  snapshotId: z.string().regex(/^[0-9a-f]{64}$/),
});

export const listRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const snapshotId = snapshotIdSchema;
export const snapshotPath = z
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

export const layoutParamSchema = z.object({ id: uuid, layoutId: uuid });

/**
 * A restore folder: its length and no control characters here; the rules of the machine's system
 * (@restow/core restoreTargetIssue: Unix `/...`, Windows `X:\...`) are checked by the service,
 * which knows the machine. The agent checks the same and more (who may change the folders above
 * it).
 */
export const restoreTargetSchema = z
  .string()
  .max(1024)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  .refine((value) => !/[\u0000-\u001f]/.test(value), "contains control characters");

export const createTaskSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("backup_now") }),
  z.object({
    kind: z.literal("restore"),
    snapshotId,
    paths: z.array(snapshotPath).min(1).max(200),
    targetDir: restoreTargetSchema.optional(),
  }),
]);

/**
 * The tenant's setting for automatic agent updates. `resumeMachines` also lifts the pauses that
 * single machines carry from before the pause became a setting of the tenant.
 */
/**
 * One level of the agent policy (docs/AGENT.md, "Richtlinien"): a key that is present is set at
 * this level, one left out inherits. The service checks the values once more
 * (@restow/core agentPolicyIssues) and refuses what the installation locked.
 */
export const agentPolicyLevelSchema = z
  .object({
    backupWindow: z
      .object({
        days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
        from: timeOfDay,
        to: timeOfDay,
      })
      .strict()
      .nullable()
      .optional(),
    catchUp: z
      .object({
        enabled: z.boolean(),
        mode: z.enum(["asap", "next_window"]),
        maxAgeHours: z
          .number()
          .int()
          .min(1)
          .max(24 * 30)
          .nullable(),
      })
      .strict()
      .optional(),
    bandwidthKbps: z.number().int().min(1).max(10_000_000).nullable().optional(),
    onlyOnAcPower: z.boolean().optional(),
    retries: z.number().int().min(0).max(10).optional(),
    snapshotOnFailure: z.enum(["continue", "fail"]).optional(),
  })
  .strict();

/** A job's level: its upload limit is the job's own field, not part of its policy. */
export const jobAgentPolicySchema = agentPolicyLevelSchema.omit({ bandwidthKbps: true });

/** The installation's policy: its settings and the ones it locks. */
export const globalAgentPolicySchema = z
  .object({
    settings: agentPolicyLevelSchema,
    locks: z
      .array(
        z.enum([
          "backupWindow",
          "catchUp",
          "bandwidthKbps",
          "onlyOnAcPower",
          "retries",
          "snapshotOnFailure",
        ]),
      )
      .max(6),
  })
  .strict();

// ---------------------------------------------------------------------------
// Bare metal recovery (docs/BAREMETAL.md 9, 11)
// ---------------------------------------------------------------------------

/** A string the ISO reports: at most `max` characters, no control characters (4.2). */
const isoText = (max: number) =>
  z.string().max(max).refine(noControlChars, "control character in string");
const hex64 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "not 64 hex digits")
  .transform((value) => value.toLowerCase());
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const recoveryHardwareSchema = z.object({
  firmware: z.enum(["uefi", "bios"]),
  secureBoot: z.boolean().nullable(),
  ramBytes: count,
  disks: z
    .array(
      z.object({
        sizeBytes: count,
        logicalSectorSize: z
          .number()
          .int()
          .min(0)
          .max(1 << 20),
        model: isoText(200),
        serial: isoText(200),
        wwn: isoText(200),
        transport: isoText(32),
      }),
    )
    .max(64),
  nics: z.array(z.object({ mac: isoText(200), driver: isoText(200), link: z.boolean() })).max(64),
});

/** POST /agent/v1/recovery/sessions: the ISO exchanges a code (9.3). */
export const recoveryExchangeSchema = z.object({
  codeProof: hex64,
  sessionSecretSha256: hex64,
  recoveryVersion: shortText(64).refine(noControlChars, "control character in string"),
  hardware: recoveryHardwareSchema,
});

export const RECOVERY_PHASES = [
  "connected",
  "waiting_approval",
  "planning",
  "confirmed",
  "partitioning",
  "restoring",
  "configuring",
  "verifying",
  "done",
] as const;

export const recoveryProgressSchema = z.object({
  phase: z.enum(RECOVERY_PHASES),
  step: count,
  stepsTotal: count,
  bytesDone: count,
  totalBytes: count,
  filesDone: count,
  totalFiles: count,
  message: isoText(500).default(""),
  sshHostKeys: z
    .array(z.object({ type: isoText(64), fingerprint: isoText(200) }))
    .max(16)
    .optional(),
});

export const recoveryLogSchema = z.object({
  lines: z.array(z.string().max(4096)).max(RECOVERY_LOG_MAX_LINES),
});

/** What the ISO tells the audit trail: remote access, a key file made anew (10.2, 10.13). */
export const recoveryEventSchema = z.object({
  kind: z.enum(["remote_access_enabled", "keyfile_regenerated"]),
  detail: z
    .record(z.string().max(64), isoText(1024))
    .default({})
    .refine((detail) => JSON.stringify(detail).length <= 4096, "detail larger than 4 KiB"),
});

export const recoveryFinishSchema = z.object({
  status: z.enum(["succeeded", "failed", "cancelled"]),
  verification: z
    .record(z.string(), z.unknown())
    .default({})
    .refine(
      (value) => JSON.stringify(value).length <= 64 * 1024,
      "verification larger than 64 KiB",
    ),
  warnings: z
    .array(z.object({ code: isoText(64), message: isoText(1000) }))
    .max(200)
    .default([]),
  durationSeconds: count.default(0),
});

/** POST /agent/v1/recovery/sessions/current/rebind (10.19): the enroll facts of the restored system. */
export const recoveryRebindSchema = z.object({
  token: shortText(200),
  hostname: shortText(253),
  os: shortText(20),
  arch: archSchema,
  agentVersion: shortText(64),
  osVersion: z.string().trim().max(200).default(""),
  hooks: hookPolicySchema.optional().catch("off"),
});

/** POST /api/v1/endpoints/:id/recovery-codes (9.2). */
export const issueRecoveryCodeSchema = z
  .object({
    snapshotId: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "not a full restic snapshot id")
      .transform((value) => value.toLowerCase())
      .optional(),
    validityHours: z
      .number()
      .int()
      .min(1)
      .max(MAX_RECOVERY_VALIDITY_HOURS)
      .default(DEFAULT_RECOVERY_VALIDITY_HOURS),
    requireApproval: z.boolean().default(true),
  })
  .strict();

export const extendRecoveryCodeSchema = z
  .object({ validityHours: z.number().int().min(1).max(MAX_RECOVERY_VALIDITY_HOURS) })
  .strict();

export const recoveryCodeParamSchema = z.object({ id: uuid, codeId: uuid });
export const recoveryParamSchema = z.object({ id: uuid, recoveryId: uuid });

export const recoveryLogQuerySchema = z.object({
  logAfter: z.string().max(100).optional(),
  logLimit: z.coerce.number().int().min(1).max(500).default(100),
});

/** The public key types the ISO's SSH server takes (10.2). */
export const SSH_KEY_TYPES = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "ssh-rsa",
] as const;

/** One OpenSSH public key line, its type named inside the key blob as well. */
export function isSshPublicKey(line: string): boolean {
  if (line.length > 16 * 1024 || !noControlChars(line)) {
    return false;
  }
  const [type, blob, ...comment] = line.trim().split(/\s+/);
  if (!type || !blob || !(SSH_KEY_TYPES as readonly string[]).includes(type)) {
    return false;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob) || comment.join(" ").length > 1024) {
    return false;
  }
  const bytes = Buffer.from(blob, "base64");
  if (bytes.length < 4 + type.length) {
    return false;
  }
  const length = bytes.readUInt32BE(0);
  return length === type.length && bytes.subarray(4, 4 + length).toString("latin1") === type;
}

export const recoverySshKeysSchema = z
  .object({
    keys: z
      .array(
        z
          .string()
          .max(16 * 1024)
          .refine(isSshPublicKey, "not an SSH public key"),
      )
      .max(20),
  })
  .strict();

/** POST /api/v1/endpoints/:id/rebind-token (11). */
export const createRebindTokenSchema = z
  .object({
    validityHours: z
      .number()
      .int()
      .min(1)
      .max(MAX_REBIND_VALIDITY_HOURS)
      .default(DEFAULT_REBIND_VALIDITY_HOURS),
    // `mac_setup` comes with macOS (M6).
    purpose: z.enum(["reinstall", "baremetal"]),
    unrevoke: z.boolean().default(false),
  })
  .strict();

export const agentUpdatesSchema = z.object({
  paused: z.boolean(),
  resumeMachines: z.boolean().optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type HookPolicy = z.infer<typeof hookPolicySchema>;
export type CreateDownloadInput = z.infer<typeof createDownloadSchema>;
export type UpdateEndpointInput = z.infer<typeof updateEndpointSchema>;
export type EnrollInput = z.infer<typeof enrollSchema>;
export type HeartbeatInput = z.infer<typeof heartbeatSchema>;
export type FinishRunInput = z.infer<typeof finishRunSchema>;
export type ProgressInput = z.infer<typeof progressSchema>;
export type StartRunInput = z.infer<typeof startRunSchema>;
export type RecoveryExchangeInput = z.infer<typeof recoveryExchangeSchema>;
export type RecoveryProgressInput = z.infer<typeof recoveryProgressSchema>;
export type RecoveryFinishInput = z.infer<typeof recoveryFinishSchema>;
export type RecoveryEventInput = z.infer<typeof recoveryEventSchema>;
export type RecoveryRebindInput = z.infer<typeof recoveryRebindSchema>;
export type IssueRecoveryCodeInput = z.infer<typeof issueRecoveryCodeSchema>;
export type CreateRebindTokenInput = z.infer<typeof createRebindTokenSchema>;
export type { EndpointOsName };
export { MAX_ERRORS };
