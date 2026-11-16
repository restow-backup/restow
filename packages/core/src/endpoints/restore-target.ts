/**
 * The rules for the folder a restore writes to (docs/AGENT.md, "Restore"), as far as they can be
 * checked without the machine: the form of the path and, on Windows, the folders a restore never
 * writes to. The agent checks the same and more (who may change the folders above it, the drive,
 * links). Shared by the API (the restore task) and the web app (the restore dialog).
 *
 * Linux and macOS: absolute and in plain form (no "." or ".." segment, no double or trailing
 * slash), never the root.
 *
 * Windows (docs/WINDOWS-AGENT.md, 18.1, steps 1 and 4): a local drive path `X:\...` below the
 * drive root; no UNC or device path, no forward slash, no "." or "..", no empty component, no
 * colon after the drive (alternate data streams), none of `<>"|?*` and no control character, no
 * component ending in a dot or a space (Windows trims them), no reserved device name (CON, NUL,
 * COM1, ...); and not in or below the Windows folder, the program folders, the agent's own data
 * folder or a System Volume Information. The agent resolves the path first and checks the same
 * list with the real folders of the machine.
 */

export type RestoreTargetIssue =
  | "control_characters"
  | "not_absolute"
  | "root"
  | "not_plain"
  | "network_path"
  | "forward_slash"
  | "invalid_character"
  | "trailing_dot_or_space"
  | "reserved_name"
  | "system_folder";

const RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CONIN$",
  "CONOUT$",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
  "COM\u00b9",
  "COM\u00b2",
  "COM\u00b3",
  "LPT\u00b9",
  "LPT\u00b2",
  "LPT\u00b3",
]);

/** Folders a Windows restore never writes to (below the drive letter, compared without case). */
export const WINDOWS_BLOCKED_RESTORE_FOLDERS = [
  "C:\\Windows",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
  "C:\\ProgramData\\Restow",
] as const;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
const CONTROL = /[\u0000-\u001f\u007f]/;

function unixIssue(value: string): RestoreTargetIssue | null {
  if (!value.startsWith("/")) return "not_absolute";
  if (value === "/") return "root";
  if (
    value.endsWith("/") ||
    !value
      .slice(1)
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  ) {
    return "not_plain";
  }
  return null;
}

function isBelow(path: string, base: string): boolean {
  const p = path.toUpperCase();
  const b = base.toUpperCase();
  return p === b || p.startsWith(`${b}\\`);
}

function windowsIssue(value: string): RestoreTargetIssue | null {
  if (value.startsWith("\\\\") || value.startsWith("//")) return "network_path";
  if (!/^[A-Za-z]:\\/.test(value)) return "not_absolute";
  if (value.includes("/")) return "forward_slash";
  const rest = value.slice(3);
  if (rest === "") return "root";
  if (/[<>"|?*:]/.test(rest)) return "invalid_character";
  const parts = rest.split("\\");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") return "not_plain";
    if (part.endsWith(".") || part.endsWith(" ")) return "trailing_dot_or_space";
    const base = (part.split(".")[0] ?? "").trimEnd().toUpperCase();
    if (RESERVED.has(base)) return "reserved_name";
  }
  const full = `${value[0]?.toUpperCase()}:\\${rest}`;
  if (WINDOWS_BLOCKED_RESTORE_FOLDERS.some((blocked) => isBelow(full, blocked))) {
    return "system_folder";
  }
  if (parts.some((part) => part.toUpperCase() === "SYSTEM VOLUME INFORMATION")) {
    return "system_folder";
  }
  return null;
}

/** What is wrong with a restore folder for a machine of `os`, or null when the form is fine. */
export function restoreTargetIssue(os: string, value: string): RestoreTargetIssue | null {
  if (CONTROL.test(value)) return "control_characters";
  return os === "windows" ? windowsIssue(value) : unixIssue(value);
}

// ---------------------------------------------------------------------------
// Files a restore does not hand out (docs/BAREMETAL.md 5.4)
// ---------------------------------------------------------------------------

/**
 * The agent's state file (with the agent secret and the repository password) and the temporary
 * files of its atomic save, in the form a snapshot names them: Linux (and the Proxmox VE agent),
 * macOS in its link, `/private` and Data volume forms, Windows under its drive letter. From 0.5.0
 * no agent backs them up; older snapshots still hold them. `*` stands for any part of one name.
 */
export const AGENT_STATE_SNAPSHOT_PATTERNS = [
  "/etc/restow-agent/state.json",
  "/etc/restow-agent/.state-*.tmp",
  "/etc/restow-pve/state.json",
  "/etc/restow-pve/.state.json.*",
  "/private/etc/restow-agent/state.json",
  "/private/etc/restow-agent/.state-*.tmp",
  "/System/Volumes/Data/private/etc/restow-agent/state.json",
  "/System/Volumes/Data/private/etc/restow-agent/.state-*.tmp",
  "/C/ProgramData/Restow/state/state.json",
  "/C/ProgramData/Restow/state/.state-*.tmp",
] as const;

function patternRegex(pattern: string): RegExp {
  const body = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  // Compared without case: macOS and Windows file systems ignore it, and a differently cased
  // copy of the file on Linux is no file anybody needs either.
  return new RegExp(`^${body}$`, "i");
}

const AGENT_STATE_REGEXES = AGENT_STATE_SNAPSHOT_PATTERNS.map(patternRegex);

/** A snapshot path in plain form: one leading slash, no empty, "." or trailing segment. */
export function plainSnapshotPath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

/** Whether a snapshot path is the agent's state file or one of its temporary copies. */
export function isAgentStatePath(path: string): boolean {
  const plain = plainSnapshotPath(path);
  return AGENT_STATE_REGEXES.some((regex) => regex.test(plain));
}

export type RestoreSelectionIssue = "agent_state" | "key_file";

/**
 * Why a selected path may not be handed out, or null. The agent's state file is locked for
 * everybody (a machine reset with an old secret would clash with its copy). The LUKS key files of
 * the machine's layout (`keyFiles`, @restow/core `keyFilesOf`) are locked for the restore role;
 * an admin may have them after a recent sign-in, audited, and gets null here.
 */
export function restoreSelectionIssue(
  path: string,
  access: { role: "admin" | "restore"; keyFiles: readonly string[] },
): RestoreSelectionIssue | null {
  if (isAgentStatePath(path)) {
    return "agent_state";
  }
  if (access.role === "restore" && isKeyFilePath(path, access.keyFiles)) {
    return "key_file";
  }
  return null;
}

/** Whether a snapshot path is one of the key files. */
export function isKeyFilePath(path: string, keyFiles: readonly string[]): boolean {
  const plain = plainSnapshotPath(path);
  return keyFiles.some((file) => plainSnapshotPath(file) === plain);
}

/** Whether selecting `dir` (a folder, or the file itself) takes along any of `lockedPaths`. */
export function selectionCovers(dir: string, lockedPaths: readonly string[]): boolean {
  const base = plainSnapshotPath(dir);
  const prefix = base === "/" ? "/" : `${base}/`;
  return lockedPaths.some((locked) => {
    const plain = plainSnapshotPath(locked);
    return plain === base || plain.startsWith(prefix);
  });
}
