import { isIP } from "node:net";
import { z } from "zod";
import { actorSchema } from "../updater/protocol.js";

/**
 * The contract between the mounter process (ROLE=mounter, this directory), the api
 * (features/mounts) and the web UI (Installation, Mounts). docs/MOUNTS.md explains
 * the design.
 *
 * The mounter adds network shares as Docker volumes to the compose project it runs
 * next to: it writes them into the project's compose override file and recreates the
 * api and the worker, which see each share at `/mnt/restow/<name>`. A storage target
 * of kind `local` then points there.
 *
 * Only NFS is implemented. The request and state documents carry a `protocol` field
 * so another protocol (SMB) can join as one more member of {@link mountSpecSchema}
 * without changing the rest of the contract.
 *
 * Nothing here imports the database, the configuration or the secret store: the
 * mounter holds the Docker socket, so it is kept free of every credential the
 * application processes hold (mounter/boundary.test.ts enforces that).
 */

/** Where the mounter listens inside the compose network. */
export const MOUNTER_DEFAULT_PORT = 8091;

/** File name of the shared secret inside the shared volume (`restow-mounter-shared`). */
export const MOUNTER_SECRET_FILE = "secret";

/** Where the api and the worker see every share. */
export const MOUNT_ROOT = "/mnt/restow";

/** The services every share is mounted into. */
export const MOUNT_SERVICES = ["api", "worker"] as const;

/** Prefix of every compose volume the mounter manages (`restow-nfs-<name>-<hash8>`). */
export const MANAGED_VOLUME_PREFIX = "restow-nfs-";

/** The top-level key of the compose override that lists the managed shares. */
export const MANAGED_MOUNTS_KEY = "x-restow-mounts";

/** Label every managed compose volume carries (with the share's name as value). */
export const MANAGED_VOLUME_LABEL = "com.restow.mounter.mount";

/** Label every probe volume and probe container carries, so leftovers can be removed. */
export const PROBE_LABEL = "com.restow.mounter.probe";

/** Implemented protocols. SMB may follow through the same contract. */
export const MOUNT_PROTOCOLS = ["nfs"] as const;
export type MountProtocol = (typeof MOUNT_PROTOCOLS)[number];

export const NFS_VERSIONS = ["3", "4", "4.1", "4.2"] as const;
export type NfsVersion = (typeof NFS_VERSIONS)[number];

/** At most this many shares (each one is a volume in two services). */
export const MAX_MOUNTS = 20;

// ---------------------------------------------------------------------------
// Validation (shared by the api, which checks early, and the mounter, which decides)
// ---------------------------------------------------------------------------

/** 1-32 characters, a-z, 0-9 and `-`, starting and ending with a letter or digit. */
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/** A DNS label (RFC 1123), case-insensitive. */
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
/** Characters an export path may hold: no comma, `=`, `:`, whitespace, quotes or control characters. */
const EXPORT_CHARACTERS = /^\/[A-Za-z0-9._\-/@+~]*$/;

export function isValidMountName(value: string): boolean {
  return NAME_PATTERN.test(value);
}

/**
 * A host name, an IPv4 address or an IPv6 address (with or without brackets). Nothing
 * that could add a mount option: no comma, `=`, whitespace or `%`. Returns the form
 * that goes into `addr=` (IPv6 without brackets), or null.
 */
export function normalizeNfsServer(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > 253 || /[\s,=%]/.test(value)) {
    return null;
  }
  const unbracketed = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (isIP(unbracketed) === 6) {
    return unbracketed.toLowerCase();
  }
  if (unbracketed !== value) {
    return null;
  }
  if (isIP(value) === 4) {
    return value;
  }
  // Not an IP address: a host name. All-numeric dotted names are malformed IPv4, not names.
  if (/^[0-9.]+$/.test(value)) {
    return null;
  }
  const labels = value.replace(/\.$/, "").split(".");
  if (labels.length === 0 || labels.some((label) => !HOST_LABEL.test(label))) {
    return null;
  }
  return value.replace(/\.$/, "").toLowerCase();
}

/** An absolute export path without `..`, commas, `=` or other characters that could alter the mount. */
export function normalizeExportPath(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > 1024 || !EXPORT_CHARACTERS.test(value)) {
    return null;
  }
  const segments = value.split("/");
  if (segments.includes("..") || segments.includes(".")) {
    return null;
  }
  const collapsed = value.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

const nameSchema = z
  .string()
  .trim()
  .refine(isValidMountName, "Use 1 to 32 characters: a-z, 0-9 and '-'.");

const serverSchema = z
  .string()
  .max(255)
  .transform((value, ctx) => {
    const normalized = normalizeNfsServer(value);
    if (normalized === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter a host name, an IPv4 or an IPv6 address.",
      });
      return z.NEVER;
    }
    return normalized;
  });

const exportSchema = z
  .string()
  .max(1024)
  .transform((value, ctx) => {
    const normalized = normalizeExportPath(value);
    if (normalized === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter an absolute export path without ',', '=', ':' or '..'.",
      });
      return z.NEVER;
    }
    return normalized;
  });

export const nfsMountSpecSchema = z
  .object({
    protocol: z.literal("nfs"),
    name: nameSchema,
    server: serverSchema,
    export: exportSchema,
    nfsVersion: z.enum(NFS_VERSIONS).default("4.1"),
    readOnly: z.boolean().default(false),
  })
  .strict();
export type NfsMountSpec = z.infer<typeof nfsMountSpecSchema>;

/** One share. A discriminated union on `protocol`, so another protocol can be added. */
export const mountSpecSchema = z.discriminatedUnion("protocol", [nfsMountSpecSchema]);
export type MountSpec = z.infer<typeof mountSpecSchema>;

/** Where a share appears in the api and the worker. */
export function mountPathOf(name: string): string {
  return `${MOUNT_ROOT}/${name}`;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** The steps of an operation, in order. `probe` is skipped when a share is removed. */
export const MOUNT_STEPS = ["validate", "probe", "write", "apply", "health", "cleanup"] as const;
export type MountStepId = (typeof MOUNT_STEPS)[number];

export const MOUNT_STEP_STATUSES = ["pending", "running", "done", "failed", "skipped"] as const;
export type MountStepStatus = (typeof MOUNT_STEP_STATUSES)[number];

export const OPERATION_KINDS = ["add", "remove"] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

/**
 * running          the operation runs
 * succeeded        the share was added or removed; the api and the worker run with it
 * failed           it failed before anything changed (validation, probe)
 * rolled_back      it failed after the override was written; the previous one is back
 * needs_attention  the rollback failed as well: the operator looks at the project (docs/MOUNTS.md)
 */
export const OPERATION_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "rolled_back",
  "needs_attention",
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

/** Machine-readable failure reasons. The web UI translates them; `detail` carries the redacted cause. */
export const MOUNT_FAILURE_CODES = [
  "validate.invalid",
  "validate.exists",
  "validate.not_found",
  "validate.conflict",
  "validate.limit",
  "prepare.compose_missing",
  "prepare.compose_file_variable",
  "prepare.docker_unreachable",
  "probe.mount_failed",
  "probe.not_writable",
  "probe.timeout",
  "probe.failed",
  "write.invalid_override",
  "write.failed",
  "write.config_invalid",
  "apply.failed",
  "health.timeout",
  "health.crashed",
  "interrupted",
] as const;
export type MountFailureCode = (typeof MOUNT_FAILURE_CODES)[number];

const iso = z.string().datetime({ offset: true });

export const mountStepSchema = z.object({
  id: z.enum(MOUNT_STEPS),
  status: z.enum(MOUNT_STEP_STATUSES),
  startedAt: iso.nullable().default(null),
  finishedAt: iso.nullable().default(null),
});
export type MountStep = z.infer<typeof mountStepSchema>;

export const mountFailureSchema = z.object({
  code: z.enum(MOUNT_FAILURE_CODES),
  step: z.enum(MOUNT_STEPS),
  /** Redacted, single line, at most 500 characters. */
  detail: z.string().max(600),
});
export type MountFailure = z.infer<typeof mountFailureSchema>;

export const operationSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(OPERATION_KINDS),
  /** The share the operation is about. */
  name: z.string(),
  /** The share's settings (add only). */
  mount: mountSpecSchema.nullable().default(null),
  status: z.enum(OPERATION_STATUSES),
  steps: z.array(mountStepSchema),
  failure: mountFailureSchema.nullable().default(null),
  /** Problems after success that changed nothing (an old volume that could not be removed). */
  warnings: z.array(z.string().max(600)).max(20).default([]),
  requestedBy: actorSchema,
  startedAt: iso,
  finishedAt: iso.nullable().default(null),
});
export type Operation = z.infer<typeof operationSchema>;

/** Share of the whole operation each step accounts for, in percent. */
export const MOUNT_STEP_WEIGHTS: Readonly<Record<MountStepId, number>> = {
  validate: 5,
  probe: 20,
  write: 10,
  apply: 25,
  health: 30,
  cleanup: 10,
};

export function operationProgress(steps: readonly Pick<MountStep, "id" | "status">[]): number {
  let total = 0;
  for (const step of steps) {
    if (step.status === "done" || step.status === "skipped" || step.status === "failed") {
      total += MOUNT_STEP_WEIGHTS[step.id];
    } else if (step.status === "running") {
      total += MOUNT_STEP_WEIGHTS[step.id] / 2;
    }
  }
  return Math.min(100, Math.round(total));
}

// ---------------------------------------------------------------------------
// State, requests, errors
// ---------------------------------------------------------------------------

/** A share as the override describes it. */
export const mountViewSchema = z.object({
  mount: mountSpecSchema,
  /** `/mnt/restow/<name>` in the api and the worker. */
  path: z.string(),
  /** The compose volume key (`restow-nfs-<name>-<hash8>`). */
  volume: z.string(),
});
export type MountView = z.infer<typeof mountViewSchema>;

export const MOUNTER_BLOCKER_CODES = [
  "docker_unreachable",
  "docker_cli_missing",
  "compose_missing",
  "compose_file_variable",
  "override_invalid",
] as const;
export type MounterBlockerCode = (typeof MOUNTER_BLOCKER_CODES)[number];

export const mounterBlockerSchema = z.object({
  code: z.enum(MOUNTER_BLOCKER_CODES),
  detail: z.string().max(600),
});
export type MounterBlocker = z.infer<typeof mounterBlockerSchema>;

export const mounterCapabilitiesSchema = z.object({
  ready: z.boolean(),
  blockers: z.array(mounterBlockerSchema),
  runner: z.enum(["cli", "helper"]),
  composeFile: z.string().nullable(),
  overrideFile: z.string(),
  protocols: z.array(z.enum(MOUNT_PROTOCOLS)),
  checkedAt: iso,
});
export type MounterCapabilities = z.infer<typeof mounterCapabilitiesSchema>;

/** Protocols of the runner (file share backup, runner-protocol.ts). */
export const RUNNER_PROTOCOLS = ["smb", "nfs"] as const;

export const RUNNER_BLOCKER_CODES = [
  "docker_unreachable",
  "runner_network_missing",
  "runner_image_unknown",
] as const;
export type RunnerBlockerCode = (typeof RUNNER_BLOCKER_CODES)[number];

/** The runner part of the state (docs/FILESHARES.md 3.1). */
export const runnerCapabilitiesSchema = z.object({
  ready: z.boolean(),
  blockers: z.array(z.object({ code: z.enum(RUNNER_BLOCKER_CODES), detail: z.string().max(600) })),
  protocols: z.array(z.enum(RUNNER_PROTOCOLS)),
  running: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  /** The image runner containers start from (the api container's image id). */
  image: z.string().nullable(),
});
export type RunnerCapabilities = z.infer<typeof runnerCapabilitiesSchema>;

export const mounterStateSchema = z.object({
  mounterVersion: z.string().nullable(),
  mounts: z.array(mountViewSchema),
  /** The operation that runs, or the last one that finished. */
  operation: operationSchema.nullable(),
  /** Earlier operations, newest first. */
  history: z.array(operationSchema),
  capabilities: mounterCapabilitiesSchema,
  /** File share runners; absent from a mounter that predates them. */
  runner: runnerCapabilitiesSchema.optional(),
  serverTime: iso,
});
export type MounterState = z.infer<typeof mounterStateSchema>;

export const addMountRequestSchema = z.object({
  mount: mountSpecSchema,
  requestedBy: actorSchema,
});
export type AddMountRequest = z.infer<typeof addMountRequestSchema>;

export const removeMountRequestSchema = z.object({
  requestedBy: actorSchema,
});
export type RemoveMountRequest = z.infer<typeof removeMountRequestSchema>;

/** Test a share before adding it (`mount`), or one that is configured (`name`). */
export const testMountRequestSchema = z.union([
  z.object({ mount: mountSpecSchema }).strict(),
  z.object({ name: nameSchema }).strict(),
]);
export type TestMountRequest = z.infer<typeof testMountRequestSchema>;

export const testResultSchema = z.object({
  ok: z.boolean(),
  code: z.enum(MOUNT_FAILURE_CODES).nullable(),
  detail: z.string().max(600).nullable(),
  /** The test wrote and removed a file (false for a read-only share, which is only listed). */
  wrote: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});
export type TestResult = z.infer<typeof testResultSchema>;

export const MOUNTER_ERROR_CODES = [
  "unauthorized",
  "invalid_request",
  "busy",
  "blocked",
  "exists",
  "not_found",
  "conflict",
  "limit",
  "internal",
] as const;
export type MounterErrorCode = (typeof MOUNTER_ERROR_CODES)[number];

export const mounterErrorSchema = z.object({
  code: z.enum(MOUNTER_ERROR_CODES),
  message: z.string(),
});
export type MounterError = z.infer<typeof mounterErrorSchema>;
