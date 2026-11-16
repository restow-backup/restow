/**
 * How the server judges one database of a `sql_verify` run (W2a, docs/BAREMETAL-WINDOWS.md 5.1.7,
 * "Grün ist Beweis"). The agent reports facts only; the server decides.
 *
 *   red         evidence that the backup itself is bad: the file fetched from the repository has
 *               another SHA-256 than the one recorded at backup time, CHECKDB ran and reported
 *               errors, or RESTORE failed with an error that names the backup (3183 checksum or
 *               damaged backup set, 3189 damage to the backup set, 3241 media family incorrectly
 *               formed, 3242 file is not a valid backup set, 3243 media family formatted for
 *               another software).
 *   green       the file was fetched from the repository, its SHA-256 matched, RESTORE worked and
 *               CHECKDB ran on the restored copy without an error (method `restore+checkdb`).
 *   incomplete  anything else (no space, no rights, a time limit, a crash): it rates nothing and
 *               keeps the agent's code. RESTORE VERIFYONLY never makes a result green.
 */
import type { SqlServerError, SqlVerifyDatabaseReport } from "./schemas.js";

export type SqlVerifyOutcome = "green" | "red" | "incomplete";

/** RESTORE errors that prove the backup file itself is unusable. */
export const SQL_BACKUP_DAMAGE_ERRORS: ReadonlySet<number> = new Set([
  3183, 3189, 3241, 3242, 3243,
]);

export interface SqlVerifyEvidence {
  source: "checkdb" | "restore" | "sha256";
  number?: number;
  message: string;
}

export interface SqlVerifyJudgement {
  outcome: SqlVerifyOutcome;
  /** For an incomplete result: the agent's code (or `sql_verify_incomplete` when it gave none). */
  code?: string;
  /** For a red result: what proves it, at most 20 entries. */
  evidence: SqlVerifyEvidence[];
}

const MAX_EVIDENCE = 20;

function damage(errors: readonly SqlServerError[]): SqlServerError[] {
  return errors.filter((error) => SQL_BACKUP_DAMAGE_ERRORS.has(error.number));
}

export function judgeSqlVerifyDatabase(report: SqlVerifyDatabaseReport): SqlVerifyJudgement {
  const evidence: SqlVerifyEvidence[] = [];
  if (report.fetched && report.sha256Match === false) {
    evidence.push({
      source: "sha256",
      message:
        "The backup file fetched from the repository does not have the SHA-256 recorded when it was made.",
    });
  }
  if (report.checkdb?.ran === true && report.checkdb.errors.length > 0) {
    for (const error of report.checkdb.errors) {
      evidence.push({ source: "checkdb", number: error.number, message: error.message });
    }
  }
  if (report.restore?.ok === false) {
    for (const error of damage(report.restore.errors)) {
      evidence.push({ source: "restore", number: error.number, message: error.message });
    }
  }
  if (evidence.length > 0) {
    return { outcome: "red", evidence: evidence.slice(0, MAX_EVIDENCE) };
  }
  const green =
    report.method === "restore+checkdb" &&
    report.fetched &&
    report.sha256Match === true &&
    report.restore?.ok === true &&
    report.checkdb?.ran === true &&
    report.checkdb.errors.length === 0;
  if (green) {
    return { outcome: "green", evidence: [] };
  }
  return { outcome: "incomplete", code: report.code ?? "sql_verify_incomplete", evidence: [] };
}
