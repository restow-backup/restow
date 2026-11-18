import { existsSync } from "node:fs";
import { chmod, lstat, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbTlsFacts } from "./facts.js";
import type { DbErrorCode } from "./model.js";
import { DbProbeScope } from "./probe/conn.js";
import {
  CLIENT_COMPRESS,
  CLIENT_CONNECT_WITH_DB,
  CLIENT_PLUGIN_AUTH,
  CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA,
  CLIENT_SECURE_CONNECTION,
  CLIENT_SSL,
  CLIENT_ZSTD_COMPRESSION,
  isMysqlLoginError,
  type MysqlGreeting,
  mysqlQuery,
  mysqlQuit,
  mysqlRsaPassword,
  mysqlSignIn,
} from "./probe/mysql.js";
import { isPgLoginError, pgQuery, pgSignIn, pgTerminate } from "./probe/postgres.js";
import {
  type DbPinnedTarget,
  type DbServerProbeOptions,
  openPinnedMysql,
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
  /** The socket's file inside {@link socketDir} (`.s.PGSQL.<port>`, MySQL `mysqld.sock`). */
  readonly socketPath: string;
  /** Settles when the relay has ended and its directory is gone. */
  readonly ended: Promise<{
    reason: PgRelayEnd;
    bytesToServer: number;
    bytesToClient: number;
    /** Why the sign-in filter stopped the relay (MySQL: a sign-in Restow does not hand on). */
    failure: { code: DbErrorCode; message: string } | null;
  }>;
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
  const scope = new DbProbeScope(Date.now() + (options.connectTimeoutMs ?? 30_000));
  let upstream: Socket;
  let meta: RelayMeta;
  try {
    const pinned = await openPinnedPostgres(options.target, options.network, scope);
    if (!pinned.ok) {
      return pinned;
    }
    upstream = pinned.conn.detach();
    meta = { connectedAddress: pinned.connectedAddress, tls: pinned.tls };
  } finally {
    // The relayed socket was released from the scope; anything else it opened is closed.
    scope.close();
  }
  return relayOver(upstream, meta, options, `.s.PGSQL.${PG_RELAY_PORT}`, () => {
    // Until the sign-in is through, the server's messages are read one by one: the relay ends
    // TLS, so the program cannot bind SCRAM to it and refuses SCRAM-SHA-256-PLUS on its plain
    // socket; the relay offers it the plain mechanism instead (the certificate is pinned here).
    const filter = new PgSignInFilter();
    return {
      first: null,
      fromClient: (chunk) => ({ toServer: chunk, toClient: EMPTY, failure: null, done: false }),
      fromServer: (chunk) => {
        const step = filter.push(chunk);
        return {
          toClient: step.out,
          toServer: EMPTY,
          failure: step.error
            ? { code: "db_probe_failed", message: "the server's sign-in could not be read" }
            : null,
          done: step.done,
        };
      },
    };
  });
}

const EMPTY = Buffer.alloc(0);

interface RelayMeta {
  connectedAddress: string | null;
  tls: DbTlsFacts;
  /** Called once the relay ended (MySQL: the connect's scope, until TLS was up). */
  onEnd?: () => void;
}

/** One step of a sign-in filter: what goes on either way, and whether it is through. */
export interface RelayStep {
  toServer: Buffer;
  toClient: Buffer;
  failure: { code: DbErrorCode; message: string } | null;
  done: boolean;
}

/** How the relay treats the sign-in of an engine, until it is through. */
interface SignInStage {
  /** Bytes for the program right after it connected (MySQL: the server's greeting). */
  first: Buffer | null;
  /**
   * Before any byte goes upstream: read what the program sends first and make the upstream
   * ready for it (MySQL: TLS with the capabilities of the program's login). Resolves with the
   * upstream and the program's bytes left over, or why the relay ends.
   */
  begin?: (
    client: Socket,
  ) => Promise<
    { upstream: Socket; rest: Buffer } | { failure: { code: DbErrorCode; message: string } }
  >;
  fromClient(chunk: Buffer): RelayStep;
  fromServer(chunk: Buffer): RelayStep;
}

/**
 * The relay over a pinned, detached `upstream` (both engines): the socket in its private
 * directory, one client, the sign-in through `stage`, then the bytes either way with back
 * pressure; the timers and the end as described at the top of this file.
 */
async function relayOver(
  initialUpstream: Socket | null,
  meta: RelayMeta,
  options: Pick<PgRelayOptions, "acceptTimeoutMs" | "idleTimeoutMs" | "maxDurationMs" | "baseDir">,
  socketName: string,
  stage: () => SignInStage,
): Promise<PgRelayOpen> {
  const started = Date.now();
  let socketDir: string;
  try {
    socketDir = await privateTempDir("restow-pg-relay-", options.baseDir);
  } catch (error) {
    initialUpstream?.destroy();
    meta.onEnd?.();
    return {
      ok: false,
      code: "db_probe_failed",
      message: `no directory for the relay: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let upstream: Socket | null = initialUpstream;
  const socketPath = join(socketDir, socketName);
  const server: Server = createServer({ pauseOnConnect: true });
  server.maxConnections = 1;
  let client: Socket | null = null;
  let reason: PgRelayEnd | null = null;
  let failure: { code: DbErrorCode; message: string } | null = null;
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
    upstream?.destroy();
    client?.destroy();
    server.close();
    meta.onEnd?.();
    void rm(socketDir, { recursive: true, force: true })
      .catch(() => undefined)
      .then(() => resolveEnded({ reason: why, bytesToServer, bytesToClient, failure }));
  };
  const watch = (up: Socket) => {
    up.once("error", () => finish("error"));
    up.once("close", () => finish(client ? "server_closed" : "closed"));
  };
  if (upstream) {
    watch(upstream);
  }
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
    socket.on("data", (chunk: Buffer) => {
      bytesToServer += chunk.length;
    });
    socket.once("error", () => finish("error"));
    socket.once("close", () => finish("client_closed"));
    const signIn = stage();
    let through = false;
    const apply = (step: RelayStep) => {
      if (reason !== null || !upstream) {
        return;
      }
      if (step.failure) {
        failure = step.failure;
        finish("error");
        return;
      }
      if (step.toServer.length > 0) {
        upstream.write(step.toServer);
      }
      if (step.toClient.length > 0) {
        socket.write(step.toClient);
      }
      if (step.done && !through) {
        through = true;
        socket.off("data", onClient);
        upstream.off("data", onServer);
        // `pipe` waits for the other side to drain: no unbounded buffering.
        socket.pipe(upstream, { end: false });
        upstream.pipe(socket, { end: false });
      }
    };
    const onClient = (chunk: Buffer) => apply(signIn.fromClient(chunk));
    const onServer = (chunk: Buffer) => apply(signIn.fromServer(chunk));
    const attach = (up: Socket, rest: Buffer) => {
      upstream = up;
      up.setTimeout(idle, () => finish("idle"));
      up.on("data", (chunk: Buffer) => {
        bytesToClient += chunk.length;
      });
      up.on("data", onServer);
      socket.on("data", onClient);
      if (rest.length > 0) {
        onClient(rest);
      }
      socket.resume();
      up.resume();
    };
    if (signIn.first) {
      socket.write(signIn.first);
    }
    if (signIn.begin) {
      socket.resume();
      void signIn.begin(socket).then((begun) => {
        if (reason !== null) {
          if ("upstream" in begun) {
            begun.upstream.destroy();
          }
          return;
        }
        if ("failure" in begun) {
          failure = begun.failure;
          finish("error");
          return;
        }
        watch(begun.upstream);
        attach(begun.upstream, begun.rest);
      });
      return;
    }
    if (upstream) {
      attach(upstream, EMPTY);
    }
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
      socketPath,
      port: PG_RELAY_PORT,
      connectedAddress: meta.connectedAddress,
      get tls() {
        return meta.tls;
      },
      ended,
      close: () => finish("closed"),
    },
  };
}

/** The MySQL relay's socket file in its directory. */
export const MYSQL_RELAY_SOCKET = "mysqld.sock";

/**
 * The relay of MySQL and MariaDB (16 "D4" M1): the pinned connection of {@link openPinnedMysql}
 * (SSLRequest and TLS already done when offered), the original greeting handed to the program
 * without the TLS and compression flags, the sign-in through {@link MysqlSignInFilter}.
 */
export async function openMysqlRelay(
  options: PgRelayOptions & { engine: "mysql" | "mariadb" },
): Promise<PgRelayOpen> {
  // The connect, and the TLS that waits for the program's login, under one deadline.
  const scope = new DbProbeScope(
    Date.now() + (options.connectTimeoutMs ?? 30_000) + (options.acceptTimeoutMs ?? 60_000),
  );
  const pinned = await openPinnedMysql(options.target, options.engine, options.network, scope, {
    deferTls: true,
  });
  if (!pinned.ok) {
    scope.close();
    return pinned;
  }
  const filter = new MysqlSignInFilter({
    greetingPayload: pinned.greetingPayload,
    greeting: pinned.greeting,
    upstreamTls: pinned.startTls !== null || pinned.tls.used,
  });
  const meta: RelayMeta = {
    connectedAddress: pinned.connectedAddress,
    tls: pinned.tls,
    onEnd: () => setImmediate(() => scope.close()),
  };
  const begin = (client: Socket) =>
    new Promise<
      { upstream: Socket; rest: Buffer } | { failure: { code: DbErrorCode; message: string } }
    >((resolve) => {
      let got = EMPTY;
      const onData = (chunk: Buffer) => {
        got = Buffer.concat([got, chunk]);
        const next = takePacket(got);
        if (next === null) {
          return;
        }
        client.off("data", onData);
        client.pause();
        if (next === "too_large") {
          resolve({
            failure: { code: "db_probe_failed", message: "the program's login is too large" },
          });
          return;
        }
        const login = filter.login(next.payload);
        if ("failure" in login) {
          resolve({ failure: login.failure });
          return;
        }
        void (async () => {
          if (pinned.startTls) {
            const secured = await pinned.startTls(login.sslRequest);
            if (!secured.ok) {
              resolve({ failure: { code: secured.code, message: secured.message } });
              return;
            }
            meta.tls = secured.tls;
          }
          const upstream = pinned.conn.detach();
          scope.close();
          upstream.write(login.toServer);
          resolve({ upstream, rest: next.rest });
        })();
      };
      client.on("data", onData);
    });
  return relayOver(null, meta, options, MYSQL_RELAY_SOCKET, () => ({
    first: filter.greetingForClient(),
    begin,
    fromClient: (chunk) => filter.fromClient(chunk),
    fromServer: (chunk) => filter.fromServer(chunk),
  }));
}

/** Sign-in plugins that never send the password readable: allowed without TLS upstream. */
const MYSQL_PLAIN_SAFE_PLUGINS = new Set([
  "mysql_native_password",
  "caching_sha2_password",
  "client_ed25519",
  "parsec",
]);

/**
 * The sign-in of a MySQL program through the relay (16 "D4" M1). The relay sent the SSLRequest
 * itself (sequence 1), so until the server's OK or error every packet gets a new sequence number
 * on either side, and the program's login packet the TLS flag (and never compression). Without
 * TLS upstream the full `caching_sha2_password` step is done by the relay: the program sends its
 * password over the local socket as on any secure transport, the relay asks the server for its
 * RSA key and sends the password encrypted with it; any other plugin that would send the
 * password readable ends the relay with `db_auth_unsupported` before the program is asked.
 * A packet during the sign-in has at most {@link SIGN_IN_MESSAGE_MAX} bytes.
 */
export class MysqlSignInFilter {
  private readonly greetingPayload: Buffer;
  private readonly upstreamTls: boolean;
  private scramble: Buffer;
  private plugin: string;
  private clientPending: Buffer = EMPTY;
  private serverPending: Buffer = EMPTY;
  /** The next sequence number towards the server. */
  private serverSeq: number;
  /** The sequence number of the last packet the program has seen or sent. */
  private clientSeq = 0;
  private loginSeen = false;
  private finished = false;
  /** RSA step: waiting for the program's password, then for the server's key. */
  private rsa: "none" | "await_password" | "await_key" = "none";
  private rsaPassword: Buffer = EMPTY;

  constructor(options: { greetingPayload: Buffer; greeting: MysqlGreeting; upstreamTls: boolean }) {
    this.greetingPayload = options.greetingPayload;
    this.upstreamTls = options.upstreamTls;
    this.scramble = options.greeting.scramble;
    this.plugin = options.greeting.authPlugin || "mysql_native_password";
    this.serverSeq = options.upstreamTls ? 2 : 1;
  }

  /** The server's greeting for the program: sequence 0, without TLS and compression. */
  greetingForClient(): Buffer {
    const payload = Buffer.from(this.greetingPayload);
    const versionEnd = payload.indexOf(0, 1);
    const lower = versionEnd + 1 + 4 + 8 + 1;
    if (versionEnd > 0 && payload.length >= lower + 2) {
      const caps = payload.readUInt16LE(lower) & ~(CLIENT_SSL | CLIENT_COMPRESS);
      payload.writeUInt16LE(caps & 0xffff, lower);
      const upper = lower + 2 + 1 + 2;
      if (payload.length >= upper + 2) {
        const high = payload.readUInt16LE(upper) & ~(CLIENT_ZSTD_COMPRESSION >>> 16);
        payload.writeUInt16LE(high & 0xffff, upper);
      }
    }
    return packet(0, payload);
  }

  private fail(message: string, code: DbErrorCode = "db_auth_unsupported"): RelayStep {
    return { toServer: EMPTY, toClient: EMPTY, failure: { code, message }, done: false };
  }

  /**
   * The program's login (its first packet): the SSLRequest for the server with the login's
   * capabilities (with TLS) and the login itself (sequence 2 after the SSLRequest, else 1), or
   * why it is refused.
   */
  login(
    payload: Buffer,
  ):
    | { sslRequest: Buffer; toServer: Buffer }
    | { failure: { code: DbErrorCode; message: string } } {
    this.loginSeen = true;
    this.clientSeq = 1;
    if (payload.length <= 32) {
      // An SSLRequest on the local socket, or a packet that is no login.
      return {
        failure: {
          code: "db_probe_failed",
          message: "the program asked for TLS on the relay's local socket",
        },
      };
    }
    const login = Buffer.from(payload);
    let caps = login.readUInt32LE(0);
    caps &= ~(CLIENT_COMPRESS | CLIENT_ZSTD_COMPRESSION);
    caps = this.upstreamTls ? caps | CLIENT_SSL : caps & ~CLIENT_SSL;
    login.writeUInt32LE(caps >>> 0, 0);
    const plugin = loginPlugin(login);
    if (plugin) {
      this.plugin = plugin;
    }
    if (!this.upstreamTls && !MYSQL_PLAIN_SAFE_PLUGINS.has(this.plugin)) {
      return {
        failure: {
          code: "db_auth_unsupported",
          message: `the sign-in method ${this.plugin} sends the password readable; the connection has no TLS`,
        },
      };
    }
    const toServer = packet(this.serverSeq, login);
    this.serverSeq = (this.serverSeq + 1) & 0xff;
    // The SSLRequest carries the login's fixed part: the server keeps these capabilities.
    return { sslRequest: packet(1, login.subarray(0, 32)), toServer };
  }

  fromClient(chunk: Buffer): RelayStep {
    if (this.finished) {
      return { toServer: chunk, toClient: EMPTY, failure: null, done: true };
    }
    this.clientPending = Buffer.concat([this.clientPending, chunk]);
    const toServer: Buffer[] = [];
    for (;;) {
      const next = takePacket(this.clientPending);
      if (next === "too_large") {
        return this.fail("the program sent a packet too large for a sign-in", "db_probe_failed");
      }
      if (!next) {
        break;
      }
      this.clientPending = next.rest;
      this.clientSeq = next.sequence;
      const payload = next.payload;
      if (this.rsa === "await_password") {
        // The program's password for the full caching_sha2 step, never sent on readable.
        this.rsaPassword = Buffer.from(payload);
        this.rsa = "await_key";
        toServer.push(packet(this.serverSeq, Buffer.from([0x02])));
        this.serverSeq = (this.serverSeq + 1) & 0xff;
        continue;
      }
      toServer.push(packet(this.serverSeq, payload));
      this.serverSeq = (this.serverSeq + 1) & 0xff;
    }
    return { toServer: Buffer.concat(toServer), toClient: EMPTY, failure: null, done: false };
  }

  fromServer(chunk: Buffer): RelayStep {
    if (this.finished) {
      return { toServer: EMPTY, toClient: chunk, failure: null, done: true };
    }
    this.serverPending = Buffer.concat([this.serverPending, chunk]);
    const toClient: Buffer[] = [];
    const toServer: Buffer[] = [];
    for (;;) {
      const next = takePacket(this.serverPending);
      if (next === "too_large") {
        return this.fail("the server sent a packet too large for a sign-in", "db_probe_failed");
      }
      if (!next) {
        break;
      }
      this.serverPending = next.rest;
      this.serverSeq = (next.sequence + 1) & 0xff;
      const payload = next.payload;
      const head = payload.length > 0 ? (payload[0] as number) : -1;
      if (this.rsa === "await_key") {
        if (head !== 0x01) {
          return this.fail("the server did not send its RSA key", "db_login_failed");
        }
        try {
          const pem = payload.subarray(1, 16 * 1024).toString("latin1");
          toServer.push(
            packet(this.serverSeq, mysqlRsaPassword(this.rsaPassword, this.scramble, pem)),
          );
          this.serverSeq = (this.serverSeq + 1) & 0xff;
        } catch {
          return this.fail("the server's RSA key could not be used", "db_login_failed");
        } finally {
          this.rsaPassword.fill(0);
          this.rsaPassword = EMPTY;
        }
        this.rsa = "none";
        continue;
      }
      if (head === 0xfe && payload.length > 1) {
        // Auth switch: the plugin and the data the program signs next.
        const end = payload.indexOf(0, 1);
        this.plugin = payload.subarray(1, end < 0 ? payload.length : end).toString("latin1");
        const data = end < 0 ? EMPTY : payload.subarray(end + 1);
        this.scramble = Buffer.from(data.length > 20 ? data.subarray(0, 20) : data);
        if (!this.upstreamTls && !MYSQL_PLAIN_SAFE_PLUGINS.has(this.plugin)) {
          return this.fail(
            `the server asks for the sign-in method ${this.plugin}, which sends the password readable; the connection has no TLS`,
          );
        }
      } else if (
        head === 0x01 &&
        payload.length >= 2 &&
        this.plugin === "caching_sha2_password" &&
        payload[1] === 0x04 &&
        !this.upstreamTls
      ) {
        this.rsa = "await_password";
      }
      this.clientSeq = (this.clientSeq + 1) & 0xff;
      toClient.push(packet(this.clientSeq, payload));
      if (head === 0x00 || head === 0xff) {
        this.finished = true;
        toClient.push(this.serverPending);
        this.serverPending = EMPTY;
        break;
      }
    }
    return {
      toServer: Buffer.concat(toServer),
      toClient: Buffer.concat(toClient),
      failure: null,
      done: this.finished,
    };
  }
}

function packet(sequence: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUIntLE(payload.length, 0, 3);
  header.writeUInt8(sequence & 0xff, 3);
  return Buffer.concat([header, payload]);
}

function takePacket(
  data: Buffer,
): { sequence: number; payload: Buffer; rest: Buffer } | "too_large" | null {
  if (data.length < 4) {
    return null;
  }
  const length = data.readUIntLE(0, 3);
  if (length > SIGN_IN_MESSAGE_MAX) {
    return "too_large";
  }
  if (data.length < 4 + length) {
    return null;
  }
  return {
    sequence: data.readUInt8(3),
    payload: data.subarray(4, 4 + length),
    rest: data.subarray(4 + length),
  };
}

/** The plugin a login packet (HandshakeResponse41) names, or null. */
function loginPlugin(payload: Buffer): string | null {
  const caps = payload.readUInt32LE(0);
  let offset = 32;
  const userEnd = payload.indexOf(0, offset);
  if (userEnd < 0) {
    return null;
  }
  offset = userEnd + 1;
  if (caps & CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA) {
    const first = payload[offset];
    if (first === undefined) return null;
    if (first < 0xfb) {
      offset += 1 + first;
    } else if (first === 0xfc && offset + 3 <= payload.length) {
      offset += 3 + payload.readUInt16LE(offset + 1);
    } else {
      return null;
    }
  } else if (caps & CLIENT_SECURE_CONNECTION) {
    offset += 1 + (payload[offset] ?? 0);
  } else {
    const end = payload.indexOf(0, offset);
    if (end < 0) return null;
    offset = end + 1;
  }
  if (caps & CLIENT_CONNECT_WITH_DB) {
    const end = payload.indexOf(0, offset);
    if (end < 0) return null;
    offset = end + 1;
  }
  if (!(caps & CLIENT_PLUGIN_AUTH) || offset >= payload.length) {
    return null;
  }
  const end = payload.indexOf(0, offset);
  return payload.subarray(offset, end < 0 ? payload.length : end).toString("latin1");
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

/** Limits of the executor's own MySQL statements: larger than a probe's (users, grants). */
export const MYSQL_RUN_LIMITS = { maxValueBytes: 1024 * 1024, maxRows: 100_000 } as const;

/**
 * Sign in over a pinned MySQL or MariaDB connection for the executor's own statements (the list
 * of schemas, `CREATE DATABASE`, the users): the same checks as the relay, the sign-in by Restow's
 * client, values up to 1 MiB and up to 100000 rows.
 */
export async function openMysqlAdminSession(
  target: DbPinnedTarget,
  engine: "mysql" | "mariadb",
  network: DbServerProbeOptions,
  credentials: { user: string; password: string | null },
  database: string | null,
  timeoutMs = 60_000,
): Promise<
  | { ok: true; session: PgAdminSession; greeting: MysqlGreeting }
  | { ok: false; code: DbErrorCode; message: string }
> {
  const scope = new DbProbeScope(Date.now() + timeoutMs);
  const pinned = await openPinnedMysql(target, engine, network, scope);
  if (!pinned.ok) {
    scope.close();
    return pinned;
  }
  try {
    // Signed in without a database: the server keeps the capabilities of the SSLRequest, which
    // asked for none; the database follows with USE.
    const session = await mysqlSignIn(pinned.conn, pinned.greeting, {
      user: credentials.user,
      password: credentials.password,
      database: null,
      startTls: null,
      tlsEstablished: pinned.tls.used,
    });
    if (database) {
      await mysqlQuery(session, `USE \`${database.replace(/`/g, "``")}\``);
    }
    return {
      ok: true,
      greeting: pinned.greeting,
      session: {
        connectedAddress: pinned.connectedAddress,
        query: (sql) => mysqlQuery(session, sql, { ...MYSQL_RUN_LIMITS, truncated: false }),
        close: () => {
          mysqlQuit(session);
          scope.close();
        },
      },
    };
  } catch (error) {
    scope.close();
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: isMysqlLoginError(error) ? "db_login_failed" : "db_unreachable",
      message: sanitizeDbMessage(message, credentials),
    };
  }
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
