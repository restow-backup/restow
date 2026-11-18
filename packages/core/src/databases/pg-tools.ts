import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { Writable } from "node:stream";
import { MysqlDumpScanner } from "./mysql-tools.js";
import { pgConninfoValue } from "./relay.js";

/**
 * The PostgreSQL programs of a backup and a restore (docs/DATABASES.md 5.1, 5.2, 7.1, 16 "D3"):
 * fixed argument lists, never a shell, the password never on a command line. The programs reach
 * the server only through the executor's relay (./relay.ts): host and port are the relay's
 * socket, `sslmode=disable` on that local leg, the user in the environment and the password in a
 * `PGPASSFILE`. Their environment is built here from nothing (no variable of the worker, such as
 * its own database URL or master key, reaches them).
 */

export type PgTool = "pg_dump" | "pg_dumpall" | "pg_restore";

export interface PgToolConnection {
  socketDir: string;
  port: number;
  user: string;
  passFile: string | null;
}

/** The environment of a program: the relay's socket, the user, the password file, nothing else. */
export function pgToolEnv(connection: PgToolConnection): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    TZ: "UTC",
    PGHOST: connection.socketDir,
    PGPORT: String(connection.port),
    PGUSER: connection.user,
    ...(connection.passFile ? { PGPASSFILE: connection.passFile } : {}),
    PGSSLMODE: "disable",
    PGGSSENCMODE: "disable",
    PGAPPNAME: "restow",
    PGCONNECT_TIMEOUT: "30",
  };
}

/** `dbname='…'` for `--dbname`: a name with `=` would otherwise be read as a connection string. */
export function pgDbnameArgument(database: string): string {
  return `--dbname=dbname=${pgConninfoValue(database)}`;
}

/** One database, custom format, uncompressed so restic deduplicates (5.2). */
export function pgDumpArgs(database: string): string[] {
  return ["--format=custom", "--compress=0", "--no-password", pgDbnameArgument(database)];
}

/** Roles and tablespaces once per instance; without the password hashes unless they may be read. */
export function pgDumpallGlobalsArgs(options: { rolePasswords: boolean }): string[] {
  return [
    "--globals-only",
    ...(options.rolePasswords ? [] : ["--no-role-passwords"]),
    "--no-password",
    pgDbnameArgument("postgres"),
  ];
}

/** Into the new database only, stopping at the first error, without owners and privileges (O3). */
export function pgRestoreArgs(database: string): string[] {
  return [
    "--exit-on-error",
    "--no-owner",
    "--no-privileges",
    "--no-password",
    pgDbnameArgument(database),
  ];
}

/** The table of contents of a custom-format archive read from stdin. */
export const PG_RESTORE_LIST_ARGS: readonly string[] = ["--list"];

/** Kinds of `pg_restore --list` entries with more than one word, the longest first. */
const MULTI_WORD_KINDS = [
  "MATERIALIZED VIEW DATA",
  "PUBLICATION TABLES IN SCHEMA",
  "TEXT SEARCH CONFIGURATION",
  "TEXT SEARCH DICTIONARY",
  "TEXT SEARCH TEMPLATE",
  "TEXT SEARCH PARSER",
  "FOREIGN DATA WRAPPER",
  "SEQUENCE OWNED BY",
  "MATERIALIZED VIEW",
  "PUBLICATION TABLE",
  "DATABASE PROPERTIES",
  "CHECK CONSTRAINT",
  "LARGE OBJECTS",
  "LARGE OBJECT",
  "BLOB METADATA",
  "FK CONSTRAINT",
  "EVENT TRIGGER",
  "FOREIGN TABLE",
  "OPERATOR CLASS",
  "OPERATOR FAMILY",
  "ROW SECURITY",
  "SEQUENCE SET",
  "USER MAPPING",
  "DEFAULT ACL",
  "TABLE DATA",
  "ACCESS METHOD",
  "PROCEDURAL LANGUAGE",
  "TABLE ATTACH",
  "INDEX ATTACH",
].map((kind) => kind.split(" "));

/**
 * Count the entries of `pg_restore --list` by kind (5.5: the object counter the verification
 * compares with). A line is `<id>; <tableoid> <oid> <KIND> <schema> <name> <owner>`; comments
 * (`;`) and blank lines are skipped.
 */
export function countPgListEntries(listing: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const raw of listing.split("\n")) {
    const line = raw.trim();
    const match = /^\d+;\s+\d+\s+\d+\s+(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    const words = (match[1] as string).split(/\s+/);
    const multi = MULTI_WORD_KINDS.find((kind) =>
      kind.every((word, index) => words[index] === word),
    );
    const kind = multi ? multi.join(" ") : (words[0] as string);
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

/** The major version of a program's `--version` (`pg_dump (PostgreSQL) 18.1` is 18). */
export function pgToolMajor(versionText: string): number | null {
  const match = /\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?/.exec(versionText);
  if (!match) {
    return null;
  }
  const major = Number(match[1]);
  // Before 10 the major version had two parts (9.6).
  return major < 10 ? null : major;
}

export interface PgToolSet {
  major: number;
  dir: string;
  path(tool: PgTool): string;
}

export type PgToolChoice =
  | { ok: true; tools: PgToolSet }
  | { ok: false; code: "db_tool_missing" | "db_tool_too_old"; message: string; found: number[] };

function versionOf(binary: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      binary,
      ["--version"],
      { timeout: 10_000, env: { PATH: "/usr/bin:/bin" } },
      (error, stdout) => resolve(error ? null : pgToolMajor(String(stdout))),
    );
  });
}

/** The directories that may hold the programs: the packages' version directories, then PATH. */
export function pgToolDirectories(path = process.env.PATH ?? ""): string[] {
  const dirs: string[] = [];
  for (const base of ["/usr/lib/postgresql", "/usr/pgsql"]) {
    if (existsSync(base)) {
      for (const entry of readdirSync(base)) {
        dirs.push(join(base, entry, "bin"));
      }
    }
  }
  for (const entry of path.split(delimiter)) {
    if (entry) {
      dirs.push(entry);
    }
  }
  return [...new Set(dirs)];
}

/**
 * The programs for a server of `serverMajor`: the newest major version that is at least as new
 * (`pg_dump` must be, 5.2), with `pg_dumpall` and `pg_restore` next to it. None: `db_tool_missing`;
 * only older ones: `db_tool_too_old`.
 */
export async function choosePgTools(
  serverMajor: number,
  dirs: readonly string[] = pgToolDirectories(),
): Promise<PgToolChoice> {
  const found: { major: number; dir: string }[] = [];
  for (const dir of dirs) {
    const binaries = ["pg_dump", "pg_dumpall", "pg_restore"].map((tool) => join(dir, tool));
    if (!binaries.every((binary) => existsSync(binary))) {
      continue;
    }
    const major = await versionOf(binaries[0] as string);
    if (major !== null) {
      found.push({ major, dir });
    }
  }
  const majors = [...new Set(found.map((entry) => entry.major))].sort((a, b) => a - b);
  const best = found
    .filter((entry) => entry.major >= serverMajor)
    .sort((a, b) => b.major - a.major)[0];
  if (best) {
    return {
      ok: true,
      tools: { major: best.major, dir: best.dir, path: (tool) => join(best.dir, tool) },
    };
  }
  if (found.length === 0) {
    return {
      ok: false,
      code: "db_tool_missing",
      found: [],
      message:
        "pg_dump, pg_dumpall and pg_restore were not found. Install the PostgreSQL client programs of the server's major version or newer.",
    };
  }
  return {
    ok: false,
    code: "db_tool_too_old",
    found: majors,
    message: `pg_dump ${majors.join(", ")} found, the server runs PostgreSQL ${serverMajor}. Install the client programs of version ${serverMajor} or newer.`,
  };
}

/** What `db-stream` writes into its statistics file when the dump ended. */
export interface DbStreamStats {
  ok: boolean;
  bytes: number;
  sha256: string;
  objects: Record<string, number>;
  exitCode: number | null;
  /** The last lines of the program's error output, for the run's message (cleaned later). */
  stderr: string;
  toolVersion: string | null;
}

/** The spec file of `db-stream`: which program with which arguments, where the stats go. */
export interface DbStreamSpec {
  tool: string;
  args: string[];
  env: Record<string, string>;
  /** `pg_restore` for the table of contents (`--list` from stdin); null: none counted. */
  listTool: string | null;
  statsPath: string;
  /** MySQL and MariaDB: count the objects from the dump's statement headers (16 "D4" M4). */
  countMysql?: boolean;
  /**
   * Instead of a program: pass this file (0600 in the run's private directory, written by the
   * executor, e.g. MySQL's users and grants); `tool` and `args` are not used.
   */
  inputFile?: string;
}

const STDERR_KEEP = 4096;
const LIST_BUFFER_MAX = 8 * 1024 * 1024;

/**
 * `db-stream` (5.1): start the dump program with its fixed argument list, pass its output to
 * `out` (restic's stdin) with back pressure, hash and count it, read its table of contents with
 * `pg_restore --list` on the side, write the statistics and resolve with the exit code restic
 * sees: not 0 when the program failed, so restic keeps no snapshot.
 */
export async function runDbStream(spec: DbStreamSpec, out: Writable): Promise<number> {
  const hash = createHash("sha256");
  let bytes = 0;
  let stderr = "";
  const scanner = spec.countMysql ? new MysqlDumpScanner() : null;
  const child = spec.inputFile
    ? spawn("/bin/cat", ["--", spec.inputFile], {
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "pipe"],
      })
    : spawn(spec.tool, spec.args, { env: spec.env, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_KEEP);
  });
  let listing = "";
  let lister: ReturnType<typeof spawn> | null = null;
  let listerOpen = false;
  const listed = new Promise<void>((resolve) => {
    if (!spec.listTool) {
      resolve();
      return;
    }
    lister = spawn(spec.listTool, [...PG_RESTORE_LIST_ARGS], {
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    listerOpen = true;
    lister.stdout?.on("data", (chunk: Buffer) => {
      if (listing.length < 64 * 1024 * 1024) {
        listing += chunk.toString("utf8");
      }
    });
    // The table of contents comes first; the lister may stop reading once it has it.
    lister.stdin?.on("error", () => {
      listerOpen = false;
    });
    lister.on("close", () => {
      listerOpen = false;
      resolve();
    });
    lister.on("error", () => {
      listerOpen = false;
      resolve();
    });
  });
  const exitCode = await new Promise<number | null>((resolve) => {
    child.stdout.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      bytes += chunk.length;
      scanner?.push(chunk);
      const listIn = listerOpen && lister ? (lister as ReturnType<typeof spawn>).stdin : null;
      if (listIn) {
        // The table of contents is at the start; a lister that falls behind is not fed further,
        // so nothing piles up in memory.
        if (listIn.writableLength > LIST_BUFFER_MAX) {
          listerOpen = false;
          listIn.end();
        } else {
          listIn.write(chunk);
        }
      }
      if (!out.write(chunk)) {
        child.stdout.pause();
        out.once("drain", () => child.stdout.resume());
      }
    });
    out.once("error", () => child.kill("SIGTERM"));
    child.on("error", (error) => {
      stderr = `${stderr}\n${error.message}`.slice(-STDERR_KEEP);
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });
  if (lister) {
    (lister as ReturnType<typeof spawn>).stdin?.end();
  }
  await listed;
  const ok = exitCode === 0;
  const stats: DbStreamStats = {
    ok,
    bytes,
    sha256: hash.digest("hex"),
    objects: scanner ? { ...scanner.counts } : countPgListEntries(listing),
    exitCode,
    stderr: stderr.trim(),
    toolVersion: null,
  };
  await writeFile(spec.statsPath, JSON.stringify(stats), { mode: 0o600 });
  return ok ? 0 : 1;
}
