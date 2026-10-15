import { isIP } from "node:net";
import { z } from "zod";
import {
  NFS_VERSIONS,
  RUNNER_BLOCKER_CODES,
  RUNNER_PROTOCOLS,
  type RunnerBlockerCode,
  type RunnerCapabilities,
  normalizeExportPath,
  normalizeNfsServer,
  runnerCapabilitiesSchema,
} from "./protocol.js";

export { RUNNER_BLOCKER_CODES, RUNNER_PROTOCOLS, runnerCapabilitiesSchema };
export type { RunnerBlockerCode, RunnerCapabilities };

/**
 * The runner operations of the mounter (docs/FILESHARES.md section 3): file share
 * backups and restores run in short-lived containers from the running Restow image,
 * with the SMB or NFS share mounted through a temporary Docker volume. Nothing here
 * touches the compose override, and nothing restarts.
 *
 *   POST   /v1/runner/exec           test or list a share (synchronous, no network)
 *   POST   /v1/runner/runs           start a backup or restore run (asynchronous)
 *   GET    /v1/runner/runs           the runner containers the mounter knows
 *   GET    /v1/runner/runs/:runId    one of them, with the redacted stderr tail once it exited
 *   DELETE /v1/runner/runs/:runId    stop it and clean up (idempotent)
 *   DELETE /v1/runner/caches/:shareId remove a share's restic cache volume (purge)
 *
 * The validation rules are mirrored, with the same test vectors
 * (packages/core/src/file-shares/testdata/specs.json), by
 * packages/core/src/file-shares/validate.ts, which the api and the worker use to
 * check early. The mounter decides: it never accepts an option string, only these
 * fields, and builds the volume options itself (runner-ops.ts).
 */

/** Labels of everything the runner creates. */
export const RUNNER_LABEL = "com.restow.mounter.runner";
export const RUNNER_KIND_LABEL = "com.restow.mounter.runner.kind";
export const RUNNER_DEADLINE_LABEL = "com.restow.mounter.runner.deadline";
export const RUNNER_SHARE_LABEL = "com.restow.mounter.runner.share";
export const RUNNER_VOLUME_LABEL = "com.restow.mounter.runner.volume";
export const RUNNER_CACHE_LABEL = "com.restow.mounter.runner.cache";

/** The runner binary inside the Restow image. */
export const RUNNER_BINARY = "/usr/local/bin/restow-share";

export type RunnerProtocol = (typeof RUNNER_PROTOCOLS)[number];

/** SMB 1.0 and 2.0 cannot be configured (10.4). */
export const SMB_VERSIONS = ["3.1.1", "3.0", "2.1"] as const;
export type SmbVersion = (typeof SMB_VERSIONS)[number];

/**
 * Failure codes of runner operations (3.6). The worker and the api map them to the
 * share failure causes (docs/FILESHARES.md section 11).
 */
export const RUNNER_FAILURE_CODES = [
  "mount.auth_failed",
  "mount.unreachable",
  "mount.not_found",
  "mount.version",
  "mount.client_missing",
  "mount.failed",
  "runner.limit",
  "runner.blocked",
  "runner.image",
  "runner.network",
  "runner.timeout",
  "runner.failed",
] as const;
export type RunnerFailureCode = (typeof RUNNER_FAILURE_CODES)[number];

// ---------------------------------------------------------------------------
// Field rules (shared regexes; packages/core mirrors them)
// ---------------------------------------------------------------------------

/** Characters a Windows share name cannot hold, plus control characters. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
const SHARE_NAME_FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f\u007f]/;
/** A user name: no `,` `=` `\` `/` and no control characters. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
const USERNAME_FORBIDDEN = /[,=\\/\u0000-\u001f\u007f]/;
/** A NetBIOS or DNS domain name. */
const DOMAIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
const CONTROL = /[\u0000-\u001f\u007f]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 32 random bytes, base64url without padding. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Mount flags the Docker daemon takes out of a volume's `o=` string before it hands
 * the rest to the kernel (moby/sys/mount `parseOptions`). A comma-separated piece of
 * a password that equals one of them would be eaten: such a password is refused.
 * [I] docs/FILESHARES.md 16.3 check 2.
 */
export const DOCKER_MOUNT_FLAGS: ReadonlySet<string> = new Set([
  "defaults",
  "ro",
  "rw",
  "suid",
  "nosuid",
  "dev",
  "nodev",
  "exec",
  "noexec",
  "sync",
  "async",
  "dirsync",
  "remount",
  "mand",
  "nomand",
  "atime",
  "noatime",
  "diratime",
  "nodiratime",
  "bind",
  "rbind",
  "unbindable",
  "runbindable",
  "private",
  "rprivate",
  "shared",
  "rshared",
  "slave",
  "rslave",
  "relatime",
  "norelatime",
  "strictatime",
  "nostrictatime",
]);

export function isValidShareName(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 80 &&
    !SHARE_NAME_FORBIDDEN.test(value) &&
    value !== "." &&
    value !== ".." &&
    value.trim() === value
  );
}

/** A relative, `/`-separated folder below the share root; "" is the root. */
export function isValidSubfolder(value: string): boolean {
  if (value === "") {
    return true;
  }
  if (value.length > 1024 || value.startsWith("/") || value.endsWith("/")) {
    return false;
  }
  return value
    .split("/")
    .every(
      (segment) =>
        segment.length >= 1 &&
        segment.length <= 255 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.includes("\\") &&
        !CONTROL.test(segment),
    );
}

export function isValidUsername(value: string): boolean {
  return value.length >= 1 && value.length <= 104 && !USERNAME_FORBIDDEN.test(value);
}

export function isValidDomain(value: string): boolean {
  return DOMAIN_PATTERN.test(value);
}

/** 1-256 bytes of UTF-8 without control characters, and nothing Docker would take for a mount flag. */
export function isValidSharePassword(value: string): boolean {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > 256 || CONTROL.test(value) || value.includes("�")) {
    return false;
  }
  return !value.split(",").some((piece) => DOCKER_MOUNT_FLAGS.has(piece));
}

/** An IPv4 or IPv6 literal (no brackets, no zone). */
export function isIpLiteral(value: string): boolean {
  return isIP(value) !== 0 && !value.includes("%");
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export function isRunToken(value: string): boolean {
  return TOKEN.test(value);
}

// ---------------------------------------------------------------------------
// Schemas (strict)
// ---------------------------------------------------------------------------

const serverSchema = z
  .string()
  .max(255)
  .transform((value, ctx) => {
    const normalized = normalizeNfsServer(value);
    if (normalized === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Not a host name or IP address." });
      return z.NEVER;
    }
    return normalized;
  });

const addressSchema = z
  .string()
  .max(64)
  .refine(isIpLiteral, "The address must be an IP literal (the caller resolves and pins it).");

const subfolderSchema = z
  .string()
  .max(1024)
  .refine(isValidSubfolder, "The subfolder must be a relative path without '..'.");

export const smbShareSpecSchema = z
  .object({
    protocol: z.literal("smb"),
    server: serverSchema,
    address: addressSchema,
    share: z.string().refine(isValidShareName, "Not a valid share name."),
    subfolder: subfolderSchema,
    username: z.string().refine(isValidUsername, "Not a valid user name."),
    password: z.string().max(1024).refine(isValidSharePassword, "The password cannot be used."),
    domain: z.string().refine(isValidDomain, "Not a valid domain.").nullable(),
    smbVersion: z.enum(SMB_VERSIONS),
    seal: z.boolean(),
  })
  .strict()
  .refine((spec) => !spec.seal || spec.smbVersion !== "2.1", {
    message: "Encryption needs SMB 3.0 or newer.",
    path: ["seal"],
  });
export type SmbShareSpec = z.infer<typeof smbShareSpecSchema>;

export const nfsShareSpecSchema = z
  .object({
    protocol: z.literal("nfs"),
    server: serverSchema,
    address: addressSchema,
    export: z
      .string()
      .max(1024)
      .transform((value, ctx) => {
        const normalized = normalizeExportPath(value);
        if (normalized === null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Not a valid export path." });
          return z.NEVER;
        }
        return normalized;
      }),
    subfolder: subfolderSchema,
    nfsVersion: z.enum(NFS_VERSIONS),
  })
  .strict();
export type NfsShareSpec = z.infer<typeof nfsShareSpecSchema>;

export const shareSpecSchema = z.union([smbShareSpecSchema, nfsShareSpecSchema]);
export type ShareSpec = SmbShareSpec | NfsShareSpec;

export const runnerMountSchema = z
  .object({
    role: z.enum(["source", "target"]),
    share: shareSpecSchema,
    readOnly: z.boolean(),
  })
  .strict();
export type RunnerMount = z.infer<typeof runnerMountSchema>;

const iso = z.string().datetime({ offset: true });

export const runnerLimitsSchema = z
  .object({
    memoryMiB: z.number().int().min(256).max(1_048_576),
    goMemLimitMiB: z.number().int().min(128).max(1_048_576),
    deadline: iso,
    /** The share whose restic cache volume the run uses. */
    cacheKey: z.string().refine(isUuid, "The cache key is a share id."),
  })
  .strict();
export type RunnerLimits = z.infer<typeof runnerLimitsSchema>;

export const RUNNER_EXEC_OPS = ["probe", "list"] as const;

export const runnerExecRequestSchema = z
  .object({
    op: z.enum(RUNNER_EXEC_OPS),
    share: shareSpecSchema,
    path: subfolderSchema.optional(),
    limit: z.number().int().min(1).max(2000).optional(),
  })
  .strict();
export type RunnerExecRequest = z.infer<typeof runnerExecRequestSchema>;

export const RUNNER_RUN_KINDS = ["backup", "restore"] as const;
export type RunnerRunKind = (typeof RUNNER_RUN_KINDS)[number];

export const runnerRunRequestSchema = z
  .object({
    runId: z.string().refine(isUuid, "The run id is a UUID."),
    kind: z.enum(RUNNER_RUN_KINDS),
    mounts: z.array(runnerMountSchema).min(1).max(1),
    token: z.string().refine(isRunToken, "The token is 43 characters of base64url."),
    limits: runnerLimitsSchema,
  })
  .strict()
  .superRefine((request, ctx) => {
    const mount = request.mounts[0];
    if (!mount) {
      return;
    }
    // backup: exactly one source, read-only. restore: exactly one target, read-write.
    if (request.kind === "backup" && (mount.role !== "source" || !mount.readOnly)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A backup mounts exactly one read-only source.",
        path: ["mounts"],
      });
    }
    if (request.kind === "restore" && (mount.role !== "target" || mount.readOnly)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A restore mounts exactly one writable target.",
        path: ["mounts"],
      });
    }
  });
export type RunnerRunRequest = z.infer<typeof runnerRunRequestSchema>;

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export const runnerExecResultSchema = z.object({
  ok: z.boolean(),
  code: z.string().nullable(),
  detail: z.string().max(600).nullable(),
  /** restow-share's JSON answer (probe or list), re-serialised; null when it gave none. */
  output: z.unknown().nullable(),
});
export type RunnerExecResult = z.infer<typeof runnerExecResultSchema>;

export const RUNNER_RUN_STATES = ["running", "exited"] as const;

export const runnerRunViewSchema = z.object({
  runId: z.string(),
  kind: z.enum(RUNNER_RUN_KINDS),
  state: z.enum(RUNNER_RUN_STATES),
  startedAt: iso,
  deadline: iso,
  exitCode: z.number().int().nullable(),
  finishedAt: iso.nullable(),
  /** `deadline`: killed past its deadline; `stopped`: DELETE; null: exited on its own. */
  stopReason: z.enum(["deadline", "stopped"]).nullable(),
});
export type RunnerRunView = z.infer<typeof runnerRunViewSchema>;

export const runnerRunDetailSchema = runnerRunViewSchema.extend({
  /** Redacted, at most 4 KiB; null while it runs. */
  stderrTail: z.string().max(4200).nullable(),
});
export type RunnerRunDetail = z.infer<typeof runnerRunDetailSchema>;

export const runnerStartedSchema = z.object({ runId: z.string(), startedAt: iso });
export type RunnerStarted = z.infer<typeof runnerStartedSchema>;

/** The error answer of a runner route (HTTP 409 or 422). */
export const runnerErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
