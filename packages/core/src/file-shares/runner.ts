import type { ShareNfsVersion, SmbVersion } from "./validate.js";

/**
 * The mounter's runner operations as the worker and the api call them
 * (docs/FILESHARES.md 3.1, 8.2). The mounter's own zod schemas
 * (apps/api/src/mounter/runner-protocol.ts) are the authority; these are the same
 * shapes as plain types, pinned by the shared vectors in testdata/specs.json and by
 * runner-client.test.ts, so a caller outside the api (the worker) needs no import from
 * apps/api.
 */

export type ShareSpec =
  | {
      protocol: "smb";
      /** Host name or IP as entered (the UNC name). */
      server: string;
      /** The IP literal the caller resolved, judged (10.1) and pins. */
      address: string;
      share: string;
      subfolder: string;
      username: string;
      password: string;
      domain: string | null;
      smbVersion: SmbVersion;
      seal: boolean;
    }
  | {
      protocol: "nfs";
      server: string;
      address: string;
      export: string;
      subfolder: string;
      nfsVersion: ShareNfsVersion;
    };

export interface RunnerMount {
  role: "source" | "target";
  share: ShareSpec;
  readOnly: boolean;
}

export interface RunnerLimits {
  memoryMiB: number;
  goMemLimitMiB: number;
  /** ISO 8601. */
  deadline: string;
  /** The share id of the restic cache volume. */
  cacheKey: string;
}

export type RunnerExecRequest =
  | { op: "probe"; share: ShareSpec }
  | { op: "list"; share: ShareSpec; path?: string; limit?: number };

export interface RunnerRunRequest {
  runId: string;
  kind: "backup" | "restore";
  /** Backup: one read-only source. Restore: one writable target. */
  mounts: RunnerMount[];
  /** The run credential (5.1): 32 random bytes, base64url. */
  token: string;
  limits: RunnerLimits;
}

export interface RunnerExecResult {
  ok: boolean;
  code: string | null;
  detail: string | null;
  /** restow-share's answer (ProbeOutput or ListOutput), null when it gave none. */
  output?: unknown;
}

/** restow-share's probe and list answer (4.9). */
export interface RunnerListOutput {
  ok: boolean;
  code?: string;
  detail?: string;
  fsType?: string;
  readOnly?: boolean;
  path?: string;
  entries?: {
    name: string;
    type: "dir" | "file" | "symlink" | "other";
    size: number;
    mtime: string;
    invalidName?: boolean;
  }[];
  truncated?: boolean;
  permissions?: { readable: boolean; xattr: string; detail?: string };
  durationMs: number;
}

export interface RunnerRunView {
  runId: string;
  kind: "backup" | "restore";
  state: "running" | "exited";
  startedAt: string;
  deadline: string;
  exitCode: number | null;
  finishedAt: string | null;
  stopReason: "deadline" | "stopped" | null;
}

export interface RunnerRunDetail extends RunnerRunView {
  stderrTail: string | null;
}

export interface RunnerCapabilities {
  ready: boolean;
  blockers: { code: string; detail: string }[];
  protocols: ("smb" | "nfs")[];
  running: number;
  limit: number;
  image: string | null;
}

/** As the mounter's RUNNER_FAILURE_CODES (3.6). */
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

/**
 * The share failure cause of a runner or restow-share code (3.6, 4.8, section 11); every
 * cause has its entry in the failure catalog (../failures/catalog.ts).
 */
export const SHARE_CAUSE_OF: Readonly<Record<string, string>> = {
  "mount.auth_failed": "share.auth_failed",
  "mount.unreachable": "share.unreachable",
  "mount.not_found": "share.not_found",
  "mount.version": "share.version_mismatch",
  "mount.client_missing": "share.client_missing",
  "mount.failed": "share.mount_failed",
  "runner.limit": "share.mounter_unavailable",
  "runner.blocked": "share.mounter_unavailable",
  "runner.image": "share.mounter_unavailable",
  "runner.network": "share.mounter_unavailable",
  "runner.timeout": "share.timeout",
  "runner.failed": "share.runner_failed",
  // restow-share's own codes (agent/internal/share/types.go).
  wrong_filesystem: "share.wrong_filesystem",
  empty_source: "share.empty_source",
  include_missing: "share.include_missing",
  permission_denied: "share.permission_denied",
  unreachable: "share.unreachable",
  not_found: "share.not_found",
  repository_locked: "share.repository_locked",
  repository_damaged: "share.repository_damaged",
  quota_exceeded: "share.quota_exceeded",
  copy_unsafe_target: "share.copy_unsafe_target",
  copy_empty_source: "share.copy_empty_source",
  restore_target: "share.restore_partial",
  restic_failed: "share.runner_failed",
  internal: "share.runner_failed",
};

/** The cause of a code, with `expired` for an expired password (EKEYEXPIRED). */
export function shareCauseOf(
  code: string,
  detail: string | null = null,
): { cause: string; params: Record<string, string> } {
  const cause = SHARE_CAUSE_OF[code] ?? "share.runner_failed";
  const params: Record<string, string> = {};
  if (cause === "share.auth_failed" && detail && /key has expired/i.test(detail)) {
    params.reason = "expired";
  }
  return { cause, params };
}

/**
 * The cause of a runner that ended without a finish report (8.3): past its deadline
 * `share.timeout`, killed by the memory limit (exit 137 without a stop) `share.out_of_memory`,
 * otherwise `share.runner_failed`. A run stopped on request is no failure (null).
 */
export function runnerExitCause(
  run: Pick<RunnerRunView, "exitCode" | "stopReason">,
): string | null {
  if (run.stopReason === "stopped") {
    return null;
  }
  if (run.stopReason === "deadline") {
    return "share.timeout";
  }
  if (run.exitCode === 137) {
    return "share.out_of_memory";
  }
  return "share.runner_failed";
}
