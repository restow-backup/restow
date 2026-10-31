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
