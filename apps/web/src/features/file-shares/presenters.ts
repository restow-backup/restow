import type { StatusTone } from "@/components/kit";
import { ApiError } from "@/lib/api";

import {
  type ConnectionInput,
  FILE_SHARE_PROBLEMS,
  type NfsVersion,
  type RestoreDestination,
  type RunKind,
  type RunProgress,
  type RunStatus,
  type RunTrigger,
  type ShareProtocol,
  type ShareReadinessState,
  type ShareStanding,
  type SmbVersion,
} from "./api.js";

/**
 * The file share pages as data (docs/FILESHARES.md 12): how a share and a run stand in words and
 * tones, the add dialog's checks (the API's rules, so a refusal is caught before the request),
 * the restore dialog's defaults, and the error texts. Pure, so it is tested without a browser.
 *
 * Green (`success`) is proof only: a restore check that passed, and a restore that completed
 * (the data is back). A backup that merely completed is neutral.
 */

export interface View {
  /** Key in the `fileshares` namespace. */
  key: string;
  tone: StatusTone;
}

const STANDING_TONE: Readonly<Record<ShareStanding, StatusTone>> = {
  retired: "muted",
  failed: "destructive",
  running: "info",
  overdue: "warning",
  warning: "warning",
  no_job: "warning",
  no_backup: "muted",
  ok: "neutral",
};

export function standingView(standing: ShareStanding): View {
  return { key: `standing.${standing}`, tone: STANDING_TONE[standing] ?? "muted" };
}

const READINESS_TONE: Readonly<Record<ShareReadinessState, StatusTone>> = {
  // A restore check that passed: the one place a share is green.
  green: "success",
  yellow: "warning",
  red: "destructive",
  unverified: "muted",
  no_backup: "muted",
};

export function readinessView(state: ShareReadinessState): View {
  return { key: `readiness.${state}`, tone: READINESS_TONE[state] ?? "muted" };
}

/** A run's status in words; a restore that completed is proof the data is back (green). */
export function runStatusView(run: {
  status: RunStatus;
  kind: RunKind;
  trigger?: RunTrigger;
}): View {
  switch (run.status) {
    case "succeeded":
      return {
        key: run.kind === "restore" ? "runs.status.restored" : "runs.status.succeeded",
        tone: run.kind === "restore" && run.trigger !== "copy" ? "success" : "neutral",
      };
    case "warning":
      return { key: "runs.status.warning", tone: "warning" };
    case "failed":
      return { key: "runs.status.failed", tone: "destructive" };
    case "running":
    case "starting":
      return { key: `runs.status.${run.status}`, tone: "info" };
    case "queued":
      return { key: "runs.status.queued", tone: "muted" };
    default:
      return { key: "runs.status.cancelled", tone: "muted" };
  }
}

/** What a run is: a backup, a restore, or a run of a copy job. */
export function runKindKey(run: { kind: RunKind; trigger: RunTrigger }): string {
  return run.trigger === "copy" ? "runs.kind.copy" : `runs.kind.${run.kind}`;
}

export function isActiveRun(status: RunStatus): boolean {
  return status === "queued" || status === "starting" || status === "running";
}

/** How far a run is, 0..1, from its files (bytes when it has them); null while unknown. */
export function progressRatio(progress: RunProgress | null | undefined): number | null {
  if (!progress) return null;
  if (progress.totalBytes > 0) {
    return Math.min(1, Math.max(0, progress.bytesDone / progress.totalBytes));
  }
  if (progress.totalFiles > 0) {
    return Math.min(1, Math.max(0, progress.filesDone / progress.totalFiles));
  }
  return null;
}

export type PermissionLevel = "full" | "owner" | "dacl" | "nfs" | "none";

/**
 * What the test found out about the permissions (12.2): "Owner and permissions" (with the
 * auditing entries when the account may read them), "Permissions only", or not readable.
 */
export function permissionLevel(
  permissions: { readable: boolean; xattr: string } | null | undefined,
): PermissionLevel {
  if (!permissions?.readable) return "none";
  switch (permissions.xattr) {
    case "system.cifs_ntsd_full":
      return "full";
    case "system.cifs_ntsd":
      return "owner";
    case "system.cifs_acl":
      return "dacl";
    default:
      return permissions.xattr ? "nfs" : "none";
  }
}

// --- Add dialog -------------------------------------------------------------------------

export interface ConnectionDraft {
  protocol: ShareProtocol;
  server: string;
  share: string;
  export: string;
  subfolder: string;
  account: string;
  domain: string;
  password: string;
  smbVersion: SmbVersion;
  seal: boolean;
  nfsVersion: NfsVersion;
}

export function newConnectionDraft(protocol: ShareProtocol = "smb"): ConnectionDraft {
  return {
    protocol,
    server: "",
    share: "",
    export: "",
    subfolder: "",
    account: "",
    domain: "",
    password: "",
    smbVersion: "3.1.1",
    seal: false,
    nfsVersion: "4.1",
  };
}

export type ConnectionField =
  | "server"
  | "share"
  | "export"
  | "subfolder"
  | "account"
  | "domain"
  | "password"
  | "seal";

/** The message keys are `fileshares:add.errors.<code>`. */
export type ConnectionProblems = Partial<Record<ConnectionField, string>>;

const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused.
const CONTROL = /[\u0000-\u001f\u007f]/;

function serverProblem(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return "required";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith("\\\\")) return "serverNoProtocol";
  if (/[\s,=%/\\]/.test(value)) return "serverInvalid";
  const bare = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (bare.includes(":")) return /^[0-9a-f:.]+$/i.test(bare) ? null : "serverInvalid";
  if (/^[0-9.]+$/.test(bare)) {
    const parts = bare.split(".");
    return parts.length === 4 && parts.every((part) => part !== "" && Number(part) <= 255)
      ? null
      : "serverInvalid";
  }
  const labels = bare.replace(/\.$/, "").split(".");
  return labels.every((label) => HOST_LABEL.test(label)) ? null : "serverInvalid";
}

function subfolderProblem(raw: string): string | null {
  const value = raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (value === "") return null;
  if (value.length > 1024) return "subfolderInvalid";
  return value
    .split("/")
    .every(
      (segment) => segment !== "" && segment !== "." && segment !== ".." && !CONTROL.test(segment),
    )
    ? null
    : "subfolderInvalid";
}

/** Mount flags Docker takes out of a volume's options: a password piece that equals one is lost. */
const MOUNT_FLAGS = new Set([
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

export function passwordProblem(value: string): string | null {
  if (value === "") return "required";
  if (new TextEncoder().encode(value).length > 256) return "passwordTooLong";
  if (CONTROL.test(value)) return "passwordControl";
  if (value.split(",").some((piece) => MOUNT_FLAGS.has(piece))) return "passwordMountFlag";
  return null;
}

/** Everything the API would refuse about the connection (3.2), found while typing. */
export function checkConnection(
  draft: ConnectionDraft,
  options: { passwordRequired: boolean } = { passwordRequired: true },
): ConnectionProblems {
  const problems: ConnectionProblems = {};
  const server = serverProblem(draft.server);
  if (server) problems.server = server;
  const subfolder = subfolderProblem(draft.subfolder);
  if (subfolder) problems.subfolder = subfolder;
  if (draft.protocol === "smb") {
    const share = draft.share.trim();
    if (share === "") problems.share = "required";
    else if (share.length > 80 || /[\\/:*?"<>|]/.test(share) || share === "." || share === "..") {
      problems.share = "shareInvalid";
    }
    const account = draft.account.trim();
    if (account === "") problems.account = "required";
    else if (/[,=/]/.test(account.replace(/^[^\\]+\\/, "")) || CONTROL.test(account)) {
      problems.account = "accountInvalid";
    }
    if (
      draft.domain.trim() !== "" &&
      !/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(draft.domain.trim())
    ) {
      problems.domain = "domainInvalid";
    }
    if (options.passwordRequired || draft.password !== "") {
      const password = passwordProblem(draft.password);
      if (password) problems.password = password;
    }
    if (draft.seal && draft.smbVersion === "2.1") problems.seal = "sealNeedsSmb3";
  } else {
    const value = draft.export.trim();
    if (value === "") problems.export = "required";
    else if (
      !/^\/[A-Za-z0-9._\-/@+~]*$/.test(value) ||
      value.split("/").some((part) => part === ".." || part === ".")
    ) {
      problems.export = "exportInvalid";
    }
  }
  return problems;
}

export function cleanSubfolder(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("/");
}

/** The connection as the API takes it. Call `checkConnection` first. */
export function connectionInputOf(draft: ConnectionDraft): ConnectionInput {
  if (draft.protocol === "smb") {
    return {
      protocol: "smb",
      server: draft.server.trim(),
      share: draft.share.trim(),
      subfolder: cleanSubfolder(draft.subfolder),
      account: draft.account.trim(),
      ...(draft.domain.trim() ? { domain: draft.domain.trim() } : {}),
      password: draft.password,
      smbVersion: draft.smbVersion,
      seal: draft.smbVersion === "2.1" ? false : draft.seal,
    };
  }
  return {
    protocol: "nfs",
    server: draft.server.trim(),
    export: draft.export.trim(),
    subfolder: cleanSubfolder(draft.subfolder),
    nfsVersion: draft.nfsVersion,
  };
}

/** Whether the server is written as an address in a loopback or private network (10.1). */
export function looksPrivate(server: string): boolean {
  const value = server
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (value.includes(":")) {
    return value === "::1" || /^f[cd]/.test(value);
  }
  return /\.(lan|local|internal|home|corp|intranet)$/.test(value) || !value.includes(".");
}

/** How the share is written, as the people who set up the server write it. */
export function locationOfDraft(draft: ConnectionDraft): string {
  const sub = cleanSubfolder(draft.subfolder);
  if (draft.protocol === "smb") {
    return [`\\\\${draft.server.trim()}`, draft.share.trim(), ...(sub ? sub.split("/") : [])].join(
      "\\",
    );
  }
  const exportPath = draft.export.trim().replace(/\/$/, "") || "";
  return `${draft.server.trim()}:${[exportPath, ...(sub ? [sub] : [])].join("/") || "/"}`;
}

/** A name for a new share from its location: the share or export's last folder. */
export function suggestedName(draft: ConnectionDraft): string {
  const sub = cleanSubfolder(draft.subfolder).split("/").filter(Boolean);
  if (sub.length > 0) return sub[sub.length - 1] as string;
  if (draft.protocol === "smb") return draft.share.trim();
  return draft.export.trim().split("/").filter(Boolean).pop() ?? draft.server.trim();
}

// --- Restore dialog -------------------------------------------------------------------------

export interface RestoreDefaults {
  restorePermissions: boolean;
  verify: boolean;
}

/**
 * The defaults of 4.7: permissions go back where they came from (original location, a new
 * folder in the same share), not into another share whose server may not know the accounts;
 * restic's verification of written files on NFS targets.
 */
export function restoreDefaults(
  destination: RestoreDestination,
  targetProtocol: ShareProtocol,
): RestoreDefaults {
  return {
    restorePermissions: destination !== "other_share",
    verify: targetProtocol === "nfs",
  };
}

/** `Restow-Restore-YYYYMMDD-HHMMSS`, the folder the runner creates when none is named. */
export function defaultRestoreFolder(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `Restow-Restore-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

// --- Errors -----------------------------------------------------------------------------------

const PROBLEM_KEYS: Readonly<Record<string, string>> = {
  [FILE_SHARE_PROBLEMS.nameTaken]: "errors.nameTaken",
  [FILE_SHARE_PROBLEMS.restoreNotAllowed]: "errors.restoreNotAllowed",
  [FILE_SHARE_PROBLEMS.busy]: "errors.busy",
  [FILE_SHARE_PROBLEMS.mounterUnavailable]: "errors.mounterUnavailable",
  [FILE_SHARE_PROBLEMS.locationChange]: "errors.locationChange",
  [FILE_SHARE_PROBLEMS.confirmName]: "errors.confirmName",
  [FILE_SHARE_PROBLEMS.retired]: "errors.retired",
  [FILE_SHARE_PROBLEMS.catalogUnavailable]: "errors.catalogUnavailable",
  [FILE_SHARE_PROBLEMS.repositoryUnavailable]: "errors.repositoryUnavailable",
  [FILE_SHARE_PROBLEMS.downloadGone]: "errors.downloadGone",
  [FILE_SHARE_PROBLEMS.pathNotFound]: "errors.pathNotFound",
  [FILE_SHARE_PROBLEMS.providerOnly]: "errors.providerOnly",
  "urn:restow:problem:recent-sign-in-required": "errors.recentSignIn",
};

/** The `fileshares:` key that says what went wrong, in the reader's words. */
export function shareErrorKey(error: unknown): string {
  if (error instanceof ApiError) {
    const type = error.problem?.type ?? "";
    if (type === FILE_SHARE_PROBLEMS.hostNotAllowed) {
      return error.problem?.reason === "forbidden_address"
        ? "errors.forbiddenAddress"
        : "errors.privateNetwork";
    }
    const known = PROBLEM_KEYS[type];
    if (known) return known;
    if (error.status === 403) return "errors.forbidden";
    if (error.status === 404) return "errors.notFound";
    if (error.status === 422) return "errors.invalid";
    if (error.status === 429 || error.status === 503) return "errors.busy";
  }
  return "errors.generic";
}

/** The problem type of an API error, or null. */
export function problemType(error: unknown): string | null {
  return error instanceof ApiError ? (error.problem?.type ?? null) : null;
}

/** The field a 422 names (`field` or the first issue's path), so the form shows it there. */
export function problemField(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const field = error.problem?.field;
  if (typeof field === "string") return field;
  const issues = error.problem?.issues as { path?: unknown[] }[] | undefined;
  const first = issues?.[0]?.path?.[0];
  return typeof first === "string" ? first : null;
}

/** The share's storage use against its budget, in percent; null without a budget. */
export function budgetPercent(usedBytes: number | null, quotaGib: number | null): number | null {
  if (usedBytes === null || quotaGib === null || quotaGib <= 0) return null;
  return Math.round((usedBytes / (quotaGib * 1024 ** 3)) * 100);
}

/** Item codes of a run (4.8) in the order the run sheet groups them. */
export const ITEM_CODES = [
  "locked_file",
  "read_error",
  "acl_unreadable",
  "acl_not_restored",
  "owner_not_restored",
  "offline_skipped",
  "name_invalid",
  "write_error",
  "files_dropped",
] as const;

export function itemCodeKey(code: string): string {
  return (ITEM_CODES as readonly string[]).includes(code)
    ? `items.codes.${code}`
    : "items.codes.other";
}
