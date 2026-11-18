import { existsSync } from "node:fs";
import { chmod, lstat, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbTlsFacts } from "./facts.js";
import type { DbErrorCode } from "./model.js";
import { DbProbeScope } from "./probe/conn.js";
import { isPgLoginError, pgQuery, pgSignIn, pgTerminate } from "./probe/postgres.js";
import {
  type DbPinnedTarget,
  type DbServerProbeOptions,
  openPinnedPostgres,
} from "./probe/probe.js";
import { sanitizeDbMessage } from "./sanitize.js";

/**
 * The pinning relay of the executor (docs/DATABASES.md 16, "D3" O1). `pg_dump`, `pg_dumpall` and
 * `pg_restore` (libpq) resolve names themselves and cannot hold a certificate fingerprint, so the
 * executor opens the connection with the hardened client of D1 ({@link openPinnedPostgres}: the
 * address judged, the guarded lookup, never Restow's own database, TLS and the confirmed
 * certificate, all before anything of the sign-in is sent) and hands the program a plain
 * connection over its own Unix socket:
 *
 *   - the socket lives in a fresh directory with mode 0700 (the socket itself 0600), in memory
 *     where the machine has one (`/dev/shm`);
 *   - exactly one client is taken: the socket is unlinked and the listener closed the moment it
 *     connects, a second one is refused;
 *   - bytes flow with back pressure (stream piping), nothing is buffered beyond the streams'
 *     own windows;
 *   - it ends when either side closes or fails, when nothing moved for `idleTimeoutMs`, when no
 *     client came within `acceptTimeoutMs`, and at `maxDurationMs` at the latest; then both
 *     sockets are destroyed and the directory removed.
 *
 * The program connects with `sslmode=disable` (the local leg never leaves the executor) and signs
 * in itself, with the password from a `PGPASSFILE` ({@link writePgPassFile}).
 */

export const PG_RELAY_PORT = 5432;

export interface PgRelayOptions {
  target: DbPinnedTarget;
  /** The network rules of the connection (private networks, approval, Restow's own database). */
  network: DbServerProbeOptions;
  /** The pinned connect (lookup, TCP, TLS) in all (default 30 s). */
  connectTimeoutMs?: number;
  /** The program must connect within this (default 60 s). */
  acceptTimeoutMs?: number;
  /** No byte either way for this long ends the relay (default 10 minutes). */
  idleTimeoutMs?: number;
  /** The relay ends at this at the latest. */
  maxDurationMs: number;
  /** Where the socket directory is made (default {@link ramTempBase}). */
  baseDir?: string;
}

export type PgRelayEnd =
  | "client_closed"
  | "server_closed"
  | "error"
  | "idle"
  | "deadline"
  | "accept_timeout"
  | "closed";

export interface PgRelay {
  /** The directory of the socket: libpq's `host`. */
  readonly socketDir: string;
  /** The socket's port number for libpq (`.s.PGSQL.<port>`). */
  readonly port: number;
  readonly connectedAddress: string | null;
  readonly tls: DbTlsFacts;
  /** Settles when the relay has ended and its directory is gone. */
  readonly ended: Promise<{ reason: PgRelayEnd; bytesToServer: number; bytesToClient: number }>;
  /** End the relay now. */
  close(): void;
}

export type PgRelayOpen =
  | { ok: true; relay: PgRelay }
  | { ok: false; code: DbErrorCode; message: string };

/** A directory in memory where the machine has one (`/dev/shm`), else the temporary directory. */
export function ramTempBase(): string {
  return existsSync("/dev/shm") ? "/dev/shm" : tmpdir();
}

/** A fresh directory with mode 0700 below `base`. */
export async function privateTempDir(prefix: string, base = ramTempBase()): Promise<string> {
  const dir = await mkdtemp(join(base, prefix));
  await chmod(dir, 0o700);
  return dir;
}

/** The prefixes of the run's private directories (the relay's socket, the password file). */
export const DB_RUN_TEMP_PREFIXES = ["restow-db-", "restow-pg-relay-"] as const;

/**
 * Remove what a crashed run left in `base`: only directories with one of `prefixes`, owned by this
 * process's user and not changed for `maxAgeMs` (longer than any run may last). Returns how many
 * went; an entry that cannot be read or removed is skipped.
 */
export async function sweepStaleTempDirs(options: {
  maxAgeMs: number;
  base?: string;
  prefixes?: readonly string[];
  now?: Date;
}): Promise<number> {
  const base = options.base ?? ramTempBase();
  const prefixes = options.prefixes ?? DB_RUN_TEMP_PREFIXES;
  const now = (options.now ?? new Date()).getTime();
  const uid = process.getuid?.() ?? null;
  let names: string[];
  try {
    names = await readdir(base);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) {
      continue;
    }
    const path = join(base, name);
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || (uid !== null && stat.uid !== uid)) {
        continue;
      }
      if (now - stat.mtimeMs < options.maxAgeMs) {
        continue;
      }
      await rm(path, { recursive: true, force: true });
      removed++;
    } catch {
      // Someone else's or gone meanwhile.
    }
  }
  return removed;
}

/** Open the relay; a refused or failed pinned connect is answered with its code, nothing opened. */
export async function openPgRelay(options: PgRelayOptions): Promise<PgRelayOpen> {
  const started = Date.now();
  const scope = new DbProbeScope(started + (options.connectTimeoutMs ?? 30_000));
  let upstream: Socket;
  let connectedAddress: string | null;
  let tls: DbTlsFacts;
  try {
    const pinned = await openPinnedPostgres(options.target, options.network, scope);
    if (!pinned.ok) {
      return pinned;
    }
    upstream = pinned.conn.detach();
    connectedAddress = pinned.connectedAddress;
    tls = pinned.tls;
  } finally {
    // The relayed socket was released from the scope; anything else it opened is closed.
    scope.close();
  }
  let socketDir: string;
  try {
    socketDir = await privateTempDir("restow-pg-relay-", options.baseDir);
  } catch (error) {
    upstream.destroy();
    return {
      ok: false,
      code: "db_probe_failed",
      message: `no directory for the relay: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const socketPath = join(socketDir, `.s.PGSQL.${PG_RELAY_PORT}`);
  const server: Server = createServer({ pauseOnConnect: true });
  server.maxConnections = 1;
  let client: Socket | null = null;
  let reason: PgRelayEnd | null = null;
  let bytesToServer = 0;
  let bytesToClient = 0;
  let resolveEnded: (value: Awaited<PgRelay["ended"]>) => void = () => undefined;
  const ended = new Promise<Awaited<PgRelay["ended"]>>((resolve) => {
    resolveEnded = resolve;
  });
  const timers: NodeJS.Timeout[] = [];
  const finish = (why: PgRelayEnd) => {
    if (reason !== null) {
      return;
    }
    reason = why;
    for (const timer of timers) {
      clearTimeout(timer);
    }
    upstream.destroy();
    client?.destroy();
    server.close();
    void rm(socketDir, { recursive: true, force: true })
      .catch(() => undefined)
      .then(() => resolveEnded({ reason: why, bytesToServer, bytesToClient }));
  };
  upstream.once("error", () => finish("error"));
  upstream.once("close", () => finish(client ? "server_closed" : "closed"));
  server.on("connection", (socket: Socket) => {
    if (client || reason !== null) {
      // Only one connection per socket: a second client never reaches the server.
      socket.destroy();
      return;
    }
    client = socket;
    server.close();
    void unlink(socketPath).catch(() => undefined);
    clearTimeout(timers[0]);
    const idle = options.idleTimeoutMs ?? 10 * 60 * 1000;
    socket.setTimeout(idle, () => finish("idle"));
    upstream.setTimeout(idle, () => finish("idle"));
    socket.on("data", (chunk: Buffer) => {
      bytesToServer += chunk.length;
    });
    upstream.on("data", (chunk: Buffer) => {
      bytesToClient += chunk.length;
    });
    socket.once("error", () => finish("error"));
    socket.once("close", () => finish("client_closed"));
    // `pipe` waits for the other side to drain: no unbounded buffering.
    socket.pipe(upstream, { end: false });
    // Until the sign-in is through, the server's messages are read one by one: the relay ends
    // TLS, so the program cannot bind SCRAM to it and refuses SCRAM-SHA-256-PLUS on its plain
    // socket; the relay offers it the plain mechanism instead (the certificate is pinned here).
    const signIn = new PgSignInFilter();
    const onSignIn = (chunk: Buffer) => {
      const step = signIn.push(chunk);
      if (step.error) {
        finish("error");
        return;
      }
      if (step.out.length > 0) {
        socket.write(step.out);
      }
      if (step.done) {
        upstream.off("data", onSignIn);
        upstream.pipe(socket, { end: false });
      }
    };
    upstream.on("data", onSignIn);
    socket.resume();
    upstream.resume();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    finish("error");
    await ended;
    return {
      ok: false,
      code: "db_probe_failed",
      message: `the relay could not listen: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  timers.push(setTimeout(() => finish("accept_timeout"), options.acceptTimeoutMs ?? 60_000));
  timers.push(
    setTimeout(
      () => finish("deadline"),
      Math.max(0, options.maxDurationMs - (Date.now() - started)),
    ),
  );
  for (const timer of timers) {
    timer.unref?.();
  }
  return {
    ok: true,
    relay: {
      socketDir,
      port: PG_RELAY_PORT,
      connectedAddress,
      tls,
      ended,
      close: () => finish("closed"),
    },
  };
}

/** The largest server message the relay reads during the sign-in. */
const SIGN_IN_MESSAGE_MAX = 64 * 1024;

/**
 * Reads the server's messages until the sign-in is through (AuthenticationOk or an error) and
 * drops `-PLUS` mechanisms from an AuthenticationSASL list; from then on the bytes pass as they
 * are. A message over {@link SIGN_IN_MESSAGE_MAX} ends the relay.
 */
export class PgSignInFilter {
  private pending: Buffer = Buffer.alloc(0);
  private finished = false;

  push(chunk: Buffer): { out: Buffer; done: boolean; error: boolean } {
    if (this.finished) {
      return { out: chunk, done: true, error: false };
    }
    this.pending = Buffer.concat([this.pending, chunk]);
    const out: Buffer[] = [];
    while (this.pending.length >= 5) {
      const type = String.fromCharCode(this.pending[0] as number);
      const length = this.pending.readUInt32BE(1);
      if (length < 4 || length > SIGN_IN_MESSAGE_MAX) {
        return { out: Buffer.alloc(0), done: false, error: true };
      }
      if (this.pending.length < 1 + length) {
        break;
      }
      let message: Buffer = this.pending.subarray(0, 1 + length);
      this.pending = this.pending.subarray(1 + length);
      if (type === "R" && length >= 8) {
        const code = message.readUInt32BE(5);
        if (code === 10) {
          message = withoutPlusMechanisms(message);
        }
        if (code === 0) {
          this.finished = true;
        }
      }
      if (type === "E") {
        this.finished = true;
      }
      out.push(message);
      if (this.finished) {
        out.push(this.pending);
        this.pending = Buffer.alloc(0);
        break;
      }
    }
    return { out: Buffer.concat(out), done: this.finished, error: false };
  }
}

function withoutPlusMechanisms(message: Buffer): Buffer {
  const names = message
    .subarray(9)
    .toString("utf8")
    .split("\0")
    .filter((name) => name !== "" && !name.endsWith("-PLUS"));
  const body = Buffer.concat([
    ...names.map((name) => Buffer.from(`${name}\0`, "utf8")),
    Buffer.from([0]),
  ]);
  const head = Buffer.alloc(9);
  head.write("R", 0, "latin1");
  head.writeUInt32BE(8 + body.length, 1);
  head.writeUInt32BE(10, 5);
  return Buffer.concat([head, body]);
}

/** A line of a `PGPASSFILE` for any host, port, database and user; `:` and `\` escaped. */
export function pgPassFileLine(password: string): string {
  return `*:*:*:*:${password.replace(/\\/g, "\\\\").replace(/:/g, "\\:")}\n`;
}

/** Write a `PGPASSFILE` with mode 0600 into `dir` (a private directory, {@link privateTempDir}). */
export async function writePgPassFile(dir: string, password: string): Promise<string> {
  const path = join(dir, "pgpass");
  await writeFile(path, pgPassFileLine(password), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

/** A conninfo value in single quotes (`dbname='…'`), as libpq reads it. */
export function pgConninfoValue(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** An identifier for SQL, in double quotes. */
export function pgQuoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * A string literal for SQL in the escape form (`E'…'`): backslash and quote are escaped, so the
 * literal means the same whatever `standard_conforming_strings` the server or the role sets.
 */
export function pgQuoteLiteral(value: string): string {
  if (value.includes("\0")) {
    throw new Error("a NUL byte cannot be part of an SQL literal");
  }
  return `E'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

export interface PgAdminSession {
  /** The address the session reached; later connections of the run go to the same one. */
  readonly connectedAddress: string | null;
  query(sql: string): Promise<(string | null)[][]>;
  close(): void;
}

/**
 * Sign in over a pinned connection for the executor's own statements (`CREATE DATABASE`, the list
 * of databases, the server's version): the same checks as the relay, the sign-in by Restow's
 * client. A failure is answered with its code; the message is cleaned of the credentials.
 */
export async function openPgAdminSession(
  target: DbPinnedTarget,
  network: DbServerProbeOptions,
  credentials: { user: string; password: string | null },
  database: string,
  timeoutMs = 60_000,
): Promise<
  { ok: true; session: PgAdminSession } | { ok: false; code: DbErrorCode; message: string }
> {
  const scope = new DbProbeScope(Date.now() + timeoutMs);
  const pinned = await openPinnedPostgres(target, network, scope);
  if (!pinned.ok) {
    scope.close();
    return pinned;
  }
  try {
    const session = await pgSignIn(pinned.conn, credentials.user, credentials.password, database);
    return {
      ok: true,
      session: {
        connectedAddress: pinned.connectedAddress,
        query: (sql) => pgQuery(session, sql),
        close: () => {
          pgTerminate(session);
          scope.close();
        },
      },
    };
  } catch (error) {
    scope.close();
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: isPgLoginError(error) ? "db_login_failed" : "db_unreachable",
      message: sanitizeDbMessage(message, credentials),
    };
  }
}
