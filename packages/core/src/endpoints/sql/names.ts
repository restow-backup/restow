/**
 * Names of SQL Server databases the server hands to the agent (W2a). `newName` of a restore
 * under a new name is checked here and again by the agent (docs/BAREMETAL-WINDOWS.md 5.1.4); the
 * check name pattern mirrors the agent's (agent/internal/sqlserver/plan.go `VerifyName`) and is
 * read-only here: only the agent creates and drops check databases, and only those in its journal.
 */

export const SQL_SYSTEM_DATABASES = ["master", "model", "msdb", "tempdb"] as const;

/** The part every check database's name carries (an infix, not a prefix). */
export const SQL_VERIFY_NAME_INFIX = "__restow_verify_";

/** `<first 80 code points of the name>__restow_verify_<yyyymmddThhmmssZ>`. */
const VERIFY_NAME = /^(.{1,80})__restow_verify_(\d{8}T\d{6}Z)$/su;

export type SqlNewNameIssue = "empty" | "too_long" | "control_characters" | "system" | "reserved";

export function sqlNewNameIssue(value: string): SqlNewNameIssue | null {
  if (value.length === 0) {
    return "empty";
  }
  if (Array.from(value).length > 128) {
    return "too_long";
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (/[\u0000-\u001f]/.test(value)) {
    return "control_characters";
  }
  if ((SQL_SYSTEM_DATABASES as readonly string[]).includes(value.trim().toLowerCase())) {
    return "system";
  }
  if (value.toLowerCase().includes(SQL_VERIFY_NAME_INFIX)) {
    return "reserved";
  }
  return null;
}

export function isSystemDatabase(value: string): boolean {
  return (SQL_SYSTEM_DATABASES as readonly string[]).includes(value.toLowerCase());
}

/** Whether a database name has the shape of the agent's check databases. */
export function isSqlVerifyName(value: string): boolean {
  return VERIFY_NAME.test(value);
}

function stamp(at: Date): string {
  return at.toISOString().slice(0, 10).replace(/-/g, "");
}

/** The name the restore dialog proposes: `<db>_restored_<yyyymmdd>`, cut to 128 code points. */
export function defaultRestoreName(database: string, at: Date): string {
  const suffix = `_restored_${stamp(at)}`;
  return `${Array.from(database)
    .slice(0, 128 - suffix.length)
    .join("")}${suffix}`;
}

/** A file name part from a database name for downloads: letters, digits, `-` and `_`. */
export function safeFilePart(value: string, max = 60): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "database").slice(0, max);
}
