import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type TransformCallback } from "node:stream";

/**
 * The MySQL and MariaDB programs of a backup and a restore (docs/DATABASES.md 5.3, 16 "D4"):
 * fixed argument lists, never a shell, the password only in an option file (0600, in the run's
 * private directory in memory) that is the only one the program reads (`--defaults-file`, so no
 * `/etc/my.cnf` or `~/.my.cnf` changes what it does). The programs reach the server only through
 * the executor's relay (`--protocol=SOCKET --socket=<relay>`, ./relay.ts).
 */

export type MysqlFamily = "mysql" | "mariadb";

/** One option value, quoted the way the option file parser reads it (backslash escapes). */
export function mysqlOptionValue(value: string): string {
  if (value.includes("\0")) {
    throw new Error("a NUL byte cannot be part of an option value");
  }
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replaceAll(String.fromCharCode(8), "\\b");
  return `"${escaped}"`;
}

/** The option file of a program: user, password and the relay's socket, nothing else. */
export function mysqlOptionFile(options: {
  user: string;
  password: string | null;
  socket: string;
}): string {
  return [
    "[client]",
    `user=${mysqlOptionValue(options.user)}`,
    ...(options.password !== null && options.password !== ""
      ? [`password=${mysqlOptionValue(options.password)}`]
      : []),
    `socket=${mysqlOptionValue(options.socket)}`,
    "protocol=SOCKET",
    "",
  ].join("\n");
}

/** Write the option file with mode 0600 into `dir` (the run's private directory). */
export async function writeMysqlOptionFile(
  dir: string,
  options: { user: string; password: string | null; socket: string },
): Promise<string> {
  const path = join(dir, `my-${Math.random().toString(36).slice(2, 10)}.cnf`);
  await writeFile(path, mysqlOptionFile(options), { mode: 0o600 });
  return path;
}

/** The environment of a program: nothing of the executor's own (HOME is the private directory). */
export function mysqlToolEnv(privateDir: string): Record<string, string> {
  return { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", TZ: "UTC", HOME: privateDir };
}

/** One schema, consistent for InnoDB, without `--databases` so it restores under another name. */
export function mysqlDumpArgs(optionFile: string, family: MysqlFamily, schema: string): string[] {
  return [
    `--defaults-file=${optionFile}`,
    "--single-transaction",
    "--quick",
    "--routines",
    "--events",
    "--triggers",
    "--hex-blob",
    "--default-character-set=utf8mb4",
    "--no-tablespaces",
    "--skip-add-locks",
    ...(family === "mysql" ? ["--set-gtid-purged=OFF", "--column-statistics=0"] : []),
    "--",
    schema,
  ];
}

/** MariaDB's users and grants (`--system=users`), the instance's "globals". */
export function mariadbUsersArgs(optionFile: string): string[] {
  return [
    `--defaults-file=${optionFile}`,
    "--system=users",
    "--skip-add-locks",
    "--default-character-set=utf8mb4",
  ];
}

/** The client into the new schema: stop at the first error, utf8mb4, large packets. */
export function mysqlRestoreArgs(optionFile: string, database: string): string[] {
  return [
    `--defaults-file=${optionFile}`,
    `--database=${database}`,
    "--default-character-set=utf8mb4",
    "--max-allowed-packet=1073741824",
    "--binary-mode",
    "--batch",
  ];
}

/**
 * The dump's file in the repository: PostgreSQL `postgresql/<name>.pgdump` and
 * `postgresql/globals.sql`, MySQL and MariaDB `<engine>/<name>.sql` and `<engine>/users.sql`.
 */
export function dbDumpFileName(engine: string, kind: "database" | "globals", name: string): string {
  const safe = name.replace(/[/\\]/g, "_");
  if (engine === "postgresql") {
    return kind === "globals" ? "postgresql/globals.sql" : `postgresql/${safe}.pgdump`;
  }
  return kind === "globals" ? `${engine}/users.sql` : `${engine}/${safe}.sql`;
}

/** An identifier in backticks. */
export function mysqlQuoteIdent(name: string): string {
  if (name.includes("\0")) {
    throw new Error("a NUL byte cannot be part of an identifier");
  }
  return `\`${name.replace(/`/g, "``")}\``;
}

/** A new schema's name (16 "D4" M3): 1 to 64 characters, nothing a server refuses. */
export function validMysqlSchemaName(name: string): boolean {
  const chars = [...name];
  return (
    chars.length > 0 &&
    chars.length <= 64 &&
    !/\s$/.test(name) &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused
    !/[\u0000-\u001f\u007f]/.test(name) &&
    chars.every((char) => (char.codePointAt(0) ?? 0) <= 0xffff)
  );
}

/** `<name>_restored_<UTC time>`, cut to 64 characters. */
export function defaultMysqlRestoreName(name: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "_");
  const suffix = `_restored_${stamp}`;
  const base = [...name].slice(0, Math.max(0, 64 - suffix.length)).join("");
  return base + suffix;
}

// ---------------------------------------------------------------------------
// Which programs (16 "D4" M2)
// ---------------------------------------------------------------------------

export interface MysqlToolVersion {
  family: MysqlFamily;
  major: number;
  minor: number;
}

/**
 * The family and version in a program's `--version`: "mysqldump  Ver 8.4.3 for Linux …",
 * "mariadb-dump from 11.8.2-MariaDB, client 10.19 …", "mysqldump  Ver 10.19 Distrib
 * 10.11.6-MariaDB, for debian-linux-gnu …". Null when unknown.
 */
export function mysqlToolVersion(text: string): MysqlToolVersion | null {
  const maria =
    /from (\d+)\.(\d+)\.\d+-MariaDB/.exec(text) ?? /Distrib (\d+)\.(\d+)\.\d+-MariaDB/.exec(text);
  if (maria) {
    return { family: "mariadb", major: Number(maria[1]), minor: Number(maria[2]) };
  }
  if (/MariaDB/i.test(text)) {
    return null;
  }
  const mysql = /Ver (\d+)\.(\d+)\.\d+/.exec(text);
  if (mysql && Number(mysql[1]) >= 8) {
    return { family: "mysql", major: Number(mysql[1]), minor: Number(mysql[2]) };
  }
  return null;
}

/** The server's version from its greeting ("8.4.3", "5.5.5-10.11.6-MariaDB-…"). */
export function mysqlServerVersion(serverVersion: string): { major: number; minor: number } {
  const match = /^(?:5\.5\.5-)?(\d+)\.(\d+)/.exec(serverVersion);
  return { major: Number(match?.[1] ?? 0), minor: Number(match?.[2] ?? 0) };
}

export interface MysqlToolSet {
  family: MysqlFamily;
  version: { major: number; minor: number };
  dump: string;
  client: string;
}

export type MysqlToolChoice =
  | { ok: true; tools: MysqlToolSet }
  | {
      ok: false;
      code: "db_tool_missing" | "db_tool_too_old";
      message: string;
      found: string[];
    };

/** Where the worker's programs lie: Oracle's MySQL in /opt/mysql/bin, MariaDB's in /usr/bin. */
export const MYSQL_TOOL_DIRECTORIES = ["/opt/mysql/bin", "/usr/bin"] as const;

function runVersion(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      path,
      ["--version"],
      { timeout: 10_000, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

/**
 * The programs for a server of `family` and `serverVersion` (16 "D4" M2): never across the
 * family; MySQL needs a client of 8.4 or newer and at least the server's version, MariaDB takes
 * the newest client found. Links are resolved; what runs is the resolved program.
 */
export async function chooseMysqlTools(
  family: MysqlFamily,
  serverVersion: { major: number; minor: number },
  dirs: readonly string[] = MYSQL_TOOL_DIRECTORIES,
): Promise<MysqlToolChoice> {
  const names =
    family === "mariadb"
      ? [
          ["mariadb-dump", "mariadb"],
          ["mysqldump", "mysql"],
        ]
      : [["mysqldump", "mysql"]];
  const found: (MysqlToolSet & { label: string })[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const [dumpName, clientName] of names) {
      const dumpPath = join(dir, dumpName as string);
      const clientPath = join(dir, clientName as string);
      if (!existsSync(dumpPath) || !existsSync(clientPath)) {
        continue;
      }
      let dump: string;
      let client: string;
      try {
        dump = realpathSync(dumpPath);
        client = realpathSync(clientPath);
      } catch {
        continue;
      }
      if (seen.has(dump)) {
        continue;
      }
      seen.add(dump);
      const version = mysqlToolVersion((await runVersion(dump)) ?? "");
      if (!version) {
        continue;
      }
      found.push({
        family: version.family,
        version: { major: version.major, minor: version.minor },
        // MariaDB's client is the one that matches its dump program; the link name may differ.
        dump: family === "mariadb" && dumpName === "mysqldump" ? dumpPath : dump,
        client: family === "mariadb" && clientName === "mysql" ? clientPath : client,
        label: `${version.family} ${version.major}.${version.minor}`,
      });
    }
  }
  const same = found
    .filter((tool) => tool.family === family)
    .sort((a, b) => b.version.major - a.version.major || b.version.minor - a.version.minor);
  const labels = found.map((tool) => tool.label);
  if (same.length === 0) {
    return {
      ok: false,
      code: "db_tool_missing",
      found: labels,
      message:
        family === "mysql"
          ? "mysqldump and mysql of MySQL 8.4 or newer were not found. A MariaDB client never dumps a MySQL server."
          : "mariadb-dump and mariadb were not found. A MySQL client never dumps a MariaDB server.",
    };
  }
  const newest = same[0] as MysqlToolSet & { label: string };
  const atLeast = (a: { major: number; minor: number }, b: { major: number; minor: number }) =>
    a.major > b.major || (a.major === b.major && a.minor >= b.minor);
  if (
    family === "mysql" &&
    (!atLeast(newest.version, { major: 8, minor: 4 }) || !atLeast(newest.version, serverVersion))
  ) {
    return {
      ok: false,
      code: "db_tool_too_old",
      found: labels,
      message: `mysqldump ${newest.version.major}.${newest.version.minor} found, the server runs MySQL ${serverVersion.major}.${serverVersion.minor}. Install the MySQL client 8.4 or newer, at least the server's version.`,
    };
  }
  const { label: _label, ...tools } = newest;
  return { ok: true, tools };
}

// ---------------------------------------------------------------------------
// The dump as text (16 "D4" M3, M4): counting and the DEFINER filter
// ---------------------------------------------------------------------------

/** The longest beginning of a line the scanner looks at; the rest of a long line passes. */
const HEAD_MAX = 64 * 1024;
/** How much of a line is enough to tell it is no DDL header (an `INSERT` passes at once). */
const DECIDE_BYTES = 16;

const QUOTED = "`(?:[^`]|``)*`";
const DEFINER = `DEFINER=${QUOTED}(?:@${QUOTED})?`;
const ROUTINE = new RegExp(`^CREATE (?:${DEFINER} )?(PROCEDURE|FUNCTION|AGGREGATE FUNCTION) `);
const ROUTINE_DEFINER = new RegExp(`^CREATE ${DEFINER} (PROCEDURE |FUNCTION |AGGREGATE FUNCTION )`);
const TRIGGER = new RegExp(
  `^/\\*!50003 CREATE\\*/ (?:/\\*!50017 ${DEFINER}\\s?\\*/ )?/\\*!50003 TRIGGER `,
);
const TRIGGER_DEFINER = new RegExp(
  `^(/\\*!50003 CREATE\\*/ )/\\*!50017 ${DEFINER}\\s?\\*/ (/\\*!50003 TRIGGER )`,
);
const EVENT = new RegExp(
  `^/\\*!50106 CREATE\\*/ (?:/\\*!50117 ${DEFINER}\\s?\\*/ )?/\\*!50106 EVENT `,
);
const EVENT_DEFINER = new RegExp(
  `^(/\\*!50106 CREATE\\*/ )/\\*!50117 ${DEFINER}\\s?\\*/ (/\\*!50106 EVENT )`,
);
const VIEW_START = /^\/\*!50001 CREATE ALGORITHM=/;
const VIEW_DEFINER = new RegExp(`^/\\*!50013 ${DEFINER} SQL SECURITY (DEFINER|INVOKER) \\*/\\s*$`);
const VIEW_BODY = /^\/\*!50001 VIEW /;

/** Could a line starting with `head` be one the scanner counts or rewrites? */
function candidate(head: string): boolean {
  return (
    head.startsWith("CREATE ") ||
    head.startsWith("/*!50001 ") ||
    head.startsWith("/*!50003 ") ||
    head.startsWith("/*!50013 ") ||
    head.startsWith("/*!50106 ") ||
    "CREATE ".startsWith(head) ||
    "/*!50".startsWith(head)
  );
}

/**
 * Reads a dump of mysqldump or mariadb-dump line by line, without holding a long line: only the
 * beginning of a line (up to 64 KiB) of a possible DDL header is looked at; an `INSERT` or any
 * other line passes as it comes. It knows where a statement starts (after a line that ends with
 * the delimiter, after `DELIMITER`, a comment or an empty line), so a line inside the body of a
 * routine never counts. It counts the objects (`TABLE`, `VIEW`, `PROCEDURE`, `FUNCTION`,
 * `TRIGGER`, `EVENT`), and with `stripDefiners` it removes the `DEFINER` clause from exactly the
 * header forms the dump programs write: never from data, never from anything else.
 */
export class MysqlDumpScanner {
  readonly counts: Record<string, number> = {};
  /** DEFINER clauses removed (restore). */
  definersRemoved = 0;
  private readonly strip: boolean;
  private head: Buffer[] = [];
  private headLength = 0;
  /** The rest of the current line passes without a look. */
  private passing = false;
  /** The last characters of a passing line that were not blank (for the delimiter). */
  private tail = "";
  private delimiter = ";";
  private atStart = true;
  /** Lines since a view's `CREATE ALGORITHM` began (0: none). */
  private viewLine = 0;

  constructor(options: { stripDefiners?: boolean } = {}) {
    this.strip = options.stripDefiners === true;
  }

  /** The bytes to hand on for `chunk` (the same ones, unless a definer was removed). */
  push(chunk: Buffer): Buffer {
    const out: Buffer[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline + 1;
      const piece = chunk.subarray(offset, end);
      offset = end;
      if (this.passing) {
        out.push(piece);
        this.noteTail(piece);
        if (newline >= 0) {
          this.passing = false;
          this.endLine(null);
        }
        continue;
      }
      this.head.push(piece);
      this.headLength += piece.length;
      if (newline >= 0) {
        out.push(this.finishLine());
        continue;
      }
      const start = Buffer.concat(this.head);
      if (
        this.headLength > HEAD_MAX ||
        (this.headLength >= DECIDE_BYTES &&
          !candidate(start.subarray(0, DECIDE_BYTES).toString("latin1")))
      ) {
        // A long line, or one that cannot be a header: it passes as it comes. Its beginning
        // still counts (a routine header may be long); nothing in it is rewritten.
        out.push(start);
        this.head = [];
        this.headLength = 0;
        this.passing = true;
        this.tail = "";
        this.look(start.toString("latin1"), false);
        this.noteTail(start);
      }
    }
    return out.length === 1 ? (out[0] as Buffer) : Buffer.concat(out);
  }

  /** The bytes still held at the end of the stream. */
  end(): Buffer {
    if (this.passing || this.head.length === 0) {
      return Buffer.alloc(0);
    }
    return this.finishLine();
  }

  private noteTail(piece: Buffer): void {
    const text = piece.toString("latin1").replace(/\s+$/, "");
    if (text.length > 0) {
      this.tail = (this.tail + text).slice(-8);
    }
  }

  /** A whole line in the head: count, maybe rewrite, hand on. */
  private finishLine(): Buffer {
    const line = Buffer.concat(this.head).toString("latin1");
    this.head = [];
    this.headLength = 0;
    const eol = /\r?\n$/.exec(line)?.[0] ?? "";
    const body = line.slice(0, line.length - eol.length);
    const rewritten = this.look(body, this.strip);
    this.endLine(body);
    return Buffer.from(rewritten + eol, "latin1");
  }

  /** Count `line` (without its end) and return it, rewritten when `rewrite` and a form matches. */
  private look(line: string, rewrite: boolean): string {
    if (this.viewLine > 0) {
      this.viewLine++;
      if (this.viewLine <= 3 && VIEW_DEFINER.test(line)) {
        if (!rewrite) {
          return line;
        }
        this.definersRemoved++;
        return line.replace(VIEW_DEFINER, (_match, security: string) => {
          return `/*!50013 SQL SECURITY ${security} */`;
        });
      }
      if (this.viewLine <= 3 && VIEW_BODY.test(line)) {
        this.bump("VIEW");
        this.viewLine = 0;
      }
      return line;
    }
    if (!this.atStart) {
      return line;
    }
    if (line.startsWith("CREATE TABLE ")) {
      this.bump("TABLE");
      return line;
    }
    if (VIEW_START.test(line)) {
      this.viewLine = 1;
      return line;
    }
    const routine = ROUTINE.exec(line);
    if (routine) {
      this.bump((routine[1] as string).replace("AGGREGATE ", ""));
      if (rewrite && ROUTINE_DEFINER.test(line)) {
        this.definersRemoved++;
        return line.replace(ROUTINE_DEFINER, (_match, kind: string) => `CREATE ${kind}`);
      }
      return line;
    }
    if (TRIGGER.test(line)) {
      this.bump("TRIGGER");
      if (rewrite && TRIGGER_DEFINER.test(line)) {
        this.definersRemoved++;
        return line.replace(TRIGGER_DEFINER, (_match, a: string, b: string) => a + b);
      }
      return line;
    }
    if (EVENT.test(line)) {
      this.bump("EVENT");
      if (rewrite && EVENT_DEFINER.test(line)) {
        this.definersRemoved++;
        return line.replace(EVENT_DEFINER, (_match, a: string, b: string) => a + b);
      }
    }
    return line;
  }

  /**
   * After a line (null: a passing line, judged by its tail): where the next statement starts.
   * `DELIMITER` changes the delimiter; an empty line or a comment changes nothing (inside the
   * body of a routine either may stand); any other line ends a statement when it ends with the
   * delimiter.
   */
  private endLine(body: string | null): void {
    const trimmed = body === null ? null : body.replace(/\s+$/, "");
    const tail = trimmed ?? this.tail;
    this.tail = "";
    if (trimmed !== null) {
      if (trimmed.startsWith("DELIMITER ")) {
        this.delimiter = trimmed.slice("DELIMITER ".length).trim() || ";";
        this.atStart = true;
        this.viewLine = 0;
        return;
      }
      if (trimmed === "" || trimmed.startsWith("--")) {
        return;
      }
    }
    this.atStart = tail.endsWith(this.delimiter);
    if (this.atStart) {
      this.viewLine = 0;
    }
  }

  private bump(kind: string): void {
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
  }
}

/** A stream that removes definers from a dump on its way to the client (restore only). */
export function mysqlDefinerFilter(): { stream: Transform; scanner: MysqlDumpScanner } {
  const scanner = new MysqlDumpScanner({ stripDefiners: true });
  const stream = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
      done(null, scanner.push(chunk));
    },
    flush(done: TransformCallback) {
      done(null, scanner.end());
    },
  });
  return { stream, scanner };
}
