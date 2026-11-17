import { isIP, type LookupFunction, type Socket } from "node:net";
import {
  BlockedAddressError,
  classifyAddress,
  guardedLookup,
  isBlockedAddressError,
  normalizeHost,
  refuseHostBeforeConnect,
} from "../../net/address-policy.js";
import type { DbProbeError, DbProbeResult, DbProbeSpec, DbTlsFacts } from "../facts.js";
import { DB_DEFAULT_PORTS, DB_DETECTION_PORTS, type DbEngine, type DbErrorCode } from "../model.js";
import { dbPlaintextAllowedFor } from "../network.js";
import { sanitizeDbMessage } from "../sanitize.js";
import { DbConn, DbConnError } from "./conn.js";
import {
  isMysqlLoginError,
  type MysqlGreeting,
  MysqlServerError,
  mysqlFacts,
  mysqlHealth,
  mysqlOffersTls,
  mysqlQuit,
  mysqlReadGreeting,
  mysqlShortVersion,
  mysqlSignIn,
  parseMysqlGreeting,
  splitMysqlPacket,
} from "./mysql.js";
import {
  isPgLoginError,
  PG_SSL_REQUEST,
  PgServerError,
  pgFacts,
  pgHealth,
  pgShortVersion,
  pgSignIn,
  pgTerminate,
} from "./postgres.js";
import { parseTdsPreloginResponse, tdsPacketLength, tdsPreloginPacket } from "./tds.js";

/**
 * "Test connection" with the Restow server as executor (docs/DATABASES.md 3 and 4.2): detect the
 * engine from the first exchange of its protocol, switch to TLS whenever the server offers it,
 * sign in and read the facts of the rights matrix and the identity. The agent does the same in Go
 * (agent/internal/dbprobe); both report a {@link DbProbeResult}, which the server judges.
 *
 * The network protection is part of every connection the probe opens: a literal address and a
 * local-only name are refused before connecting, every other name through the guarded lookup,
 * so the address that was checked is the address that is connected to. The server never signs in
 * to a public address without TLS, even when the connection allows it unencrypted.
 */

export interface DbServerProbeOptions {
  /** Private networks and loopback: the installation flag or the provider admin's approval. */
  allowPrivateNetworks: boolean;
  /** Tests: a socket factory instead of the guarded network. */
  connect?: (host: string, port: number) => Socket;
  /** Tests: a lookup instead of the guarded system resolver. */
  lookup?: LookupFunction;
  /** How long one step may wait (default 5 s). */
  stepTimeoutMs?: number;
  /** How long the probe waits for the MySQL greeting before asking PostgreSQL (default 400 ms). */
  greetingWaitMs?: number;
}

type Detected =
  | { engine: "postgresql"; conn: DbConn; port: number; tlsOffered: boolean }
  | {
      engine: "mysql" | "mariadb";
      conn: DbConn;
      port: number;
      greeting: MysqlGreeting;
    }
  | { engine: "sqlserver"; port: number; version: string | null; encryption: string | null };

class ProbeFailure extends Error {
  constructor(
    readonly code: DbErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const emptyTls = (offered: boolean | null): DbTlsFacts => ({
  offered,
  used: false,
  fingerprintSha256: null,
  subject: null,
  issuer: null,
  notAfter: null,
});

function portsToTry(spec: DbProbeSpec): number[] {
  if (spec.port) {
    return [spec.port];
  }
  if (spec.engine && spec.engine !== "sqlite") {
    return [DB_DEFAULT_PORTS[spec.engine]];
  }
  return [...DB_DETECTION_PORTS];
}

/** Ask one port what it is; null when it answers as no database Restow knows. */
async function detectOn(
  spec: DbProbeSpec,
  port: number,
  open: (port: number) => Promise<DbConn>,
  options: Required<Pick<DbServerProbeOptions, "greetingWaitMs" | "stepTimeoutMs">>,
): Promise<Detected | null> {
  const tdsFirst = spec.engine === "sqlserver" || (spec.engine === null && port === 1433);
  if (!tdsFirst) {
    const conn = await open(port);
    const waitMs =
      spec.engine === "mysql" || spec.engine === "mariadb"
        ? options.stepTimeoutMs
        : spec.engine === "postgresql"
          ? 0
          : options.greetingWaitMs;
    let early = waitMs > 0 ? await conn.peek(waitMs) : Buffer.alloc(0);
    if (early.length === 0 && !conn.closed) {
      // Nothing on its own: ask as PostgreSQL. A MySQL server that was slow to greet answers
      // with its greeting instead (that connection is not used further).
      conn.write(PG_SSL_REQUEST);
      early = await conn.peek(options.stepTimeoutMs);
      const first = early[0];
      if (early.length === 1 && (first === 0x53 || first === 0x4e)) {
        await conn.read(1);
        return { engine: "postgresql", conn, port, tlsOffered: first === 0x53 };
      }
    }
    const packet = splitMysqlPacket(early);
    if (packet) {
      const greeting = parseMysqlGreeting(packet.payload);
      if (greeting || packet.payload.readUInt8(0) === 0xff) {
        conn.close();
        // Sign in on a fresh connection: this one may have seen the SSLRequest.
        const fresh = await open(port);
        const again = await mysqlReadGreeting(fresh);
        return { engine: again.mariadb ? "mariadb" : "mysql", conn: fresh, port, greeting: again };
      }
    }
    conn.close();
    if (spec.engine === "postgresql" || spec.engine === "mysql" || spec.engine === "mariadb") {
      return null;
    }
  }
  const conn = await open(port);
  try {
    conn.write(tdsPreloginPacket());
    const header = await conn.read(8, options.stepTimeoutMs);
    const length = tdsPacketLength(header);
    if (length === null || length < 8 || length > 4096) {
      return null;
    }
    const body = await conn.read(length - 8, options.stepTimeoutMs);
    const facts = parseTdsPreloginResponse(Buffer.concat([header, body]));
    return facts
      ? { engine: "sqlserver", port, version: facts.version, encryption: facts.encryption }
      : null;
  } catch (error) {
    if (error instanceof DbConnError) {
      return null;
    }
    throw error;
  } finally {
    conn.close();
  }
}

function failureOf(error: unknown, host: string | null = null): ProbeFailure {
  if (error instanceof ProbeFailure) {
    return error;
  }
  if (error instanceof BlockedAddressError || isBlockedAddressError(error)) {
    const literal = host ? normalizeHost(host) : "";
    const kind = isIP(literal) !== 0 ? classifyAddress(literal) : "private";
    return kind === "private" || kind === "loopback"
      ? new ProbeFailure(
          "db_private_network",
          "The address is in a private network; only a provider admin can approve it.",
        )
      : new ProbeFailure(
          "db_forbidden_address",
          "The address is link-local, multicast or reserved; Restow never connects there.",
        );
  }
  if (error instanceof DbConnError) {
    return new ProbeFailure("db_unreachable", error.message);
  }
  if (isPgLoginError(error) || isMysqlLoginError(error)) {
    return new ProbeFailure("db_login_failed", (error as Error).message);
  }
  if (error instanceof PgServerError || error instanceof MysqlServerError) {
    return new ProbeFailure("db_probe_failed", error.message);
  }
  return new ProbeFailure(
    "db_probe_failed",
    error instanceof Error ? error.message : "unknown error",
  );
}

/** Whether the address the socket reached may be used without TLS. */
function plaintextAllowed(conn: DbConn, spec: DbProbeSpec): boolean {
  if (!spec.allowUnencrypted) {
    return false;
  }
  const remote = conn.remoteAddress;
  return remote !== null && isIP(remote) !== 0 && dbPlaintextAllowedFor(classifyAddress(remote));
}

function tlsMissing(): ProbeFailure {
  return new ProbeFailure(
    "db_tls_missing",
    "The server offers no TLS. Restow connects without TLS only to a private address and only when the connection allows it.",
  );
}

/**
 * A stored connection's certificate (3.2): after the TLS handshake and before a credential is
 * sent, another certificate ends the probe (`db_tls_changed`). The facts keep what was seen.
 */
function assertPinnedCertificate(conn: DbConn, spec: DbProbeSpec): void {
  const pinned = spec.tlsFingerprint ?? null;
  if (pinned && conn.tls.fingerprintSha256 !== pinned) {
    throw new ProbeFailure(
      "db_tls_changed",
      "The server shows another TLS certificate than the one confirmed; no credentials were sent.",
    );
  }
}

/** Run one probe from the Restow server. Never throws: every failure is part of the result. */
export async function probeDatabaseFromServer(
  spec: DbProbeSpec,
  options: DbServerProbeOptions,
): Promise<DbProbeResult> {
  const started = Date.now();
  const stepTimeoutMs = options.stepTimeoutMs ?? 5000;
  const greetingWaitMs = options.greetingWaitMs ?? 400;
  const deadline = started + spec.timeoutSeconds * 1000;
  const result: DbProbeResult = {
    engine: null,
    port: null,
    serverVersion: null,
    tls: emptyTls(null),
    login: "skipped",
    error: null,
    durationMs: 0,
  };
  const secrets = { user: spec.user, password: spec.password };
  const finish = (error: ProbeFailure | null): DbProbeResult => {
    const outcome: DbProbeError | null = error
      ? { code: error.code, message: sanitizeDbMessage(error.message, secrets) }
      : null;
    return {
      ...result,
      error: outcome,
      durationMs: Math.min(Date.now() - started, 10 * 60 * 1000),
    };
  };
  if (spec.engine === "sqlite" || spec.path || !spec.host) {
    return finish(
      new ProbeFailure(
        "db_engine_unsupported",
        "An SQLite file is opened by an agent on its machine.",
      ),
    );
  }
  if (spec.authMethod === "socket") {
    return finish(
      new ProbeFailure(
        "db_auth_unsupported",
        "The sign-in over the socket needs an agent on the database machine.",
      ),
    );
  }
  const host = spec.host;
  const refusal = options.connect
    ? null
    : refuseHostBeforeConnect(host, options.allowPrivateNetworks);
  if (refusal) {
    return finish(failureOf(refusal, host));
  }
  const lookup = options.lookup ?? guardedLookup(options.allowPrivateNetworks);
  const open = (port: number) =>
    DbConn.open({
      host,
      port,
      timeoutMs: Math.max(1000, Math.min(stepTimeoutMs, deadline - Date.now())),
      lookup,
      ...(options.connect ? { connect: options.connect } : {}),
    });

  let detected: Detected | null = null;
  let lastFailure: ProbeFailure | null = null;
  for (const port of portsToTry(spec)) {
    try {
      detected = await detectOn(spec, port, open, { greetingWaitMs, stepTimeoutMs });
      if (detected) {
        break;
      }
      lastFailure = new ProbeFailure(
        "db_not_a_database",
        `Port ${port} answers, but not as PostgreSQL, MySQL, MariaDB or SQL Server.`,
      );
    } catch (error) {
      lastFailure = failureOf(error, host);
      if (
        lastFailure.code === "db_private_network" ||
        lastFailure.code === "db_forbidden_address"
      ) {
        return finish(lastFailure);
      }
    }
  }
  if (!detected) {
    return finish(lastFailure ?? new ProbeFailure("db_unreachable", "Nothing answered."));
  }
  result.engine = detected.engine;
  result.port = detected.port;
  // The engine of the spec is a hint (a URL scheme, a stored connection); a stored connection's
  // exact engine is compared by the server, which judges the result.
  if (!dbEngineMatchesHint(spec.engine, detected.engine)) {
    if ("conn" in detected) {
      detected.conn.close();
    }
    return finish(
      new ProbeFailure(
        "db_engine_changed",
        `Under the address answers ${detected.engine}, not ${spec.engine}.`,
      ),
    );
  }

  if (detected.engine === "sqlserver") {
    result.serverVersion = detected.version;
    result.tls = emptyTls(detected.encryption === "on" || detected.encryption === "required");
    result.sqlserver = {
      version: detected.version,
      encryption:
        (detected.encryption as "off" | "on" | "not_supported" | "required" | null) ?? null,
    };
    return finish(
      new ProbeFailure(
        "db_engine_unsupported",
        "SQL Server is backed up by an agent on its own machine; the Restow server does not sign in to it.",
      ),
    );
  }

  const user = spec.user ?? "";
  if (detected.engine === "postgresql") {
    const { conn, tlsOffered } = detected;
    result.tls = emptyTls(tlsOffered);
    try {
      if (tlsOffered) {
        await conn.startTls(isIP(host) === 0 ? host : null);
        result.tls = { offered: true, ...conn.tls };
        assertPinnedCertificate(conn, spec);
      } else if (!plaintextAllowed(conn, spec)) {
        conn.close();
        return finish(tlsMissing());
      }
      if (!user) {
        conn.close();
        return finish(new ProbeFailure("db_login_failed", "No user was given."));
      }
      const databases = [spec.database ?? "postgres", "template1"];
      let lastError: unknown = null;
      for (const [index, database] of databases.entries()) {
        let session: Awaited<ReturnType<typeof pgSignIn>> | null = null;
        let current = conn;
        try {
          if (index > 0) {
            // The first database does not exist: a new connection for the next one.
            current = await reopenPostgres(open, detected.port, host, tlsOffered);
            assertPinnedCertificate(current, spec);
          }
          session = await pgSignIn(current, user, spec.password, database);
          result.login = "ok";
          if (spec.purpose === "health") {
            const health = await pgHealth(session, started, spec.sizes === true);
            result.health = health.facts;
            result.serverVersion =
              pgShortVersion(health.version) ?? session.parameters.get("server_version") ?? null;
            pgTerminate(session);
            current.close();
            return finish(null);
          }
          const facts = await pgFacts(session);
          result.postgresql = facts;
          result.serverVersion =
            pgShortVersion(facts.version) ?? session.parameters.get("server_version") ?? null;
          pgTerminate(session);
          current.close();
          return finish(null);
        } catch (error) {
          current.close();
          lastError = error;
          if (!(error instanceof PgServerError && error.sqlState === "3D000")) {
            break;
          }
        }
      }
      const failure = failureOf(lastError);
      result.login = failure.code === "db_login_failed" ? "failed" : result.login;
      return finish(failure);
    } catch (error) {
      conn.close();
      return finish(failureOf(error));
    }
  }

  const { conn, greeting } = detected;
  result.serverVersion = mysqlShortVersion(greeting.serverVersion);
  const offered = mysqlOffersTls(greeting);
  result.tls = emptyTls(offered);
  try {
    if (!offered && !plaintextAllowed(conn, spec)) {
      conn.close();
      return finish(tlsMissing());
    }
    if (!user) {
      conn.close();
      return finish(new ProbeFailure("db_login_failed", "No user was given."));
    }
    const session = await mysqlSignIn(conn, greeting, {
      user,
      password: spec.password,
      database: spec.database,
      startTls: offered
        ? async () => {
            await conn.startTls(isIP(host) === 0 ? host : null);
            result.tls = { offered: true, ...conn.tls };
            assertPinnedCertificate(conn, spec);
          }
        : null,
    });
    if (offered) {
      result.tls = { offered: true, ...conn.tls };
    }
    result.login = "ok";
    if (spec.purpose === "health") {
      result.health = await mysqlHealth(session, started, spec.sizes === true);
      mysqlQuit(session);
      conn.close();
      return finish(null);
    }
    result.mysql = await mysqlFacts(session);
    mysqlQuit(session);
    conn.close();
    return finish(null);
  } catch (error) {
    if (offered && conn.tls.used) {
      result.tls = { offered: true, ...conn.tls };
    }
    conn.close();
    const failure = failureOf(error);
    if (failure.code === "db_login_failed") {
      result.login = "failed";
    }
    return finish(failure);
  }
}

async function reopenPostgres(
  open: (port: number) => Promise<DbConn>,
  port: number,
  host: string,
  tls: boolean,
): Promise<DbConn> {
  const conn = await open(port);
  conn.write(PG_SSL_REQUEST);
  const answer = await conn.read(1);
  if (tls) {
    if (answer.readUInt8(0) !== 0x53) {
      conn.close();
      throw new ProbeFailure("db_tls_missing", "The server stopped offering TLS.");
    }
    await conn.startTls(isIP(host) === 0 ? host : null);
  }
  return conn;
}

/** The engines a probe may report for a URL scheme (a `mysql://` URL may reach MariaDB). */
export function dbEngineMatchesHint(hint: DbEngine | null, engine: DbEngine): boolean {
  if (hint === null || hint === engine) {
    return true;
  }
  return hint === "mysql" && engine === "mariadb";
}
