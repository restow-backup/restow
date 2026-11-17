import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import type { DbHealthFacts, DbPostgresFacts } from "../facts.js";
import { DB_MAX_DATABASES } from "../model.js";
import type { DbConn } from "./conn.js";

/**
 * The PostgreSQL side of the probe (docs/DATABASES.md 3): the SSLRequest that recognises the
 * engine, the sign-in (SCRAM-SHA-256, MD5 or a plain password, as the server asks) and the
 * read-only queries of the facts. Frontend/backend protocol 3.0, simple queries only.
 */

export const PG_SSL_REQUEST = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]);

export class PgServerError extends Error {
  constructor(
    readonly sqlState: string,
    message: string,
  ) {
    super(message);
    this.name = "PgServerError";
  }
}

/** The sign-in failed because of the user, the password or pg_hba.conf. */
export function isPgLoginError(error: unknown): boolean {
  return (
    error instanceof PgServerError &&
    (error.sqlState === "28P01" || error.sqlState === "28000" || error.sqlState === "42501")
  );
}

interface PgMessage {
  type: string;
  body: Buffer;
}

async function readMessage(conn: DbConn): Promise<PgMessage> {
  const header = await conn.read(5);
  const type = String.fromCharCode(header.readUInt8(0));
  const length = header.readUInt32BE(1);
  if (length < 4 || length > 64 * 1024 * 1024) {
    throw new PgServerError("08P01", "invalid message length from the server");
  }
  return { type, body: await conn.read(length - 4) };
}

function message(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.write(type, 0, "latin1");
  header.writeUInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

function cstring(text: string): Buffer {
  return Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([0])]);
}

function errorOf(body: Buffer): PgServerError {
  const fields = new Map<string, string>();
  let index = 0;
  while (index < body.length) {
    const code = body.readUInt8(index);
    if (code === 0) {
      break;
    }
    const end = body.indexOf(0, index + 1);
    if (end < 0) {
      break;
    }
    fields.set(String.fromCharCode(code), body.subarray(index + 1, end).toString("utf8"));
    index = end + 1;
  }
  return new PgServerError(fields.get("C") ?? "XX000", fields.get("M") ?? "server error");
}

function startupMessage(user: string, database: string): Buffer {
  const body = Buffer.concat([
    Buffer.from([0x00, 0x03, 0x00, 0x00]),
    cstring("user"),
    cstring(user),
    cstring("database"),
    cstring(database),
    cstring("application_name"),
    cstring("restow"),
    Buffer.from([0]),
  ]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length + 4);
  return Buffer.concat([length, body]);
}

function md5Hex(data: Buffer | string): string {
  return createHash("md5").update(data).digest("hex");
}

/** The MD5 answer: "md5" + md5(md5(password + user) + salt). */
export function pgMd5Password(user: string, password: string, salt: Buffer): string {
  const inner = md5Hex(password + user);
  return `md5${md5Hex(Buffer.concat([Buffer.from(inner, "utf8"), salt]))}`;
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** SCRAM-SHA-256 (RFC 5802, RFC 7677) without channel binding, as PostgreSQL speaks it. */
export class PgScram {
  readonly clientNonce: string;
  private saltedPassword = Buffer.alloc(0);
  private authMessage = "";

  constructor(
    private readonly password: string,
    nonce?: string,
  ) {
    this.clientNonce = nonce ?? randomBytes(18).toString("base64");
  }

  get clientFirstBare(): string {
    return `n=,r=${this.clientNonce}`;
  }

  clientFirst(): string {
    return `n,,${this.clientFirstBare}`;
  }

  clientFinal(serverFirst: string): string {
    const attributes = new Map(
      serverFirst.split(",").map((part) => [part.slice(0, 1), part.slice(2)] as const),
    );
    const nonce = attributes.get("r") ?? "";
    const salt = Buffer.from(attributes.get("s") ?? "", "base64");
    const iterations = Number(attributes.get("i") ?? "0");
    if (!nonce.startsWith(this.clientNonce) || iterations < 1 || iterations > 10_000_000) {
      throw new PgServerError("28000", "the server's SCRAM answer is not valid");
    }
    this.saltedPassword = pbkdf2Sync(
      this.password.normalize("NFKC"),
      salt,
      iterations,
      32,
      "sha256",
    );
    const withoutProof = `c=biws,r=${nonce}`;
    this.authMessage = `${this.clientFirstBare},${serverFirst},${withoutProof}`;
    const clientKey = hmac(this.saltedPassword, "Client Key");
    const storedKey = createHash("sha256").update(clientKey).digest();
    const signature = hmac(storedKey, this.authMessage);
    const proof = Buffer.alloc(clientKey.length);
    for (let index = 0; index < clientKey.length; index++) {
      proof[index] = (clientKey[index] ?? 0) ^ (signature[index] ?? 0);
    }
    return `${withoutProof},p=${proof.toString("base64")}`;
  }

  /** The server proves it knows the password too. */
  verifyServerFinal(serverFinal: string): boolean {
    const verifier = /(?:^|,)v=([^,]+)/.exec(serverFinal)?.[1];
    if (!verifier || !this.authMessage) {
      return false;
    }
    const serverKey = hmac(this.saltedPassword, "Server Key");
    return hmac(serverKey, this.authMessage).toString("base64") === verifier;
  }
}

export interface PgSession {
  conn: DbConn;
  parameters: Map<string, string>;
}

/** Sign in after the SSLRequest (and TLS, when the server offered it). */
export async function pgSignIn(
  conn: DbConn,
  user: string,
  password: string | null,
  database: string,
): Promise<PgSession> {
  conn.write(startupMessage(user, database));
  let scram: PgScram | null = null;
  const parameters = new Map<string, string>();
  const needPassword = (): string => {
    if (password === null) {
      throw new PgServerError("28P01", "the server asks for a password and none was given");
    }
    return password;
  };
  for (;;) {
    const { type, body } = await readMessage(conn);
    if (type === "E") {
      throw errorOf(body);
    }
    if (type === "R") {
      const code = body.readUInt32BE(0);
      if (code === 0) {
        continue;
      }
      if (code === 3) {
        conn.write(message("p", cstring(needPassword())));
      } else if (code === 5) {
        conn.write(message("p", cstring(pgMd5Password(user, needPassword(), body.subarray(4, 8)))));
      } else if (code === 10) {
        const mechanisms = body.subarray(4).toString("utf8").split("\u0000").filter(Boolean);
        if (!mechanisms.includes("SCRAM-SHA-256")) {
          throw new PgServerError("28000", `unsupported SASL mechanisms: ${mechanisms.join(", ")}`);
        }
        scram = new PgScram(needPassword());
        const first = Buffer.from(scram.clientFirst(), "utf8");
        const length = Buffer.alloc(4);
        length.writeInt32BE(first.length);
        conn.write(message("p", Buffer.concat([cstring("SCRAM-SHA-256"), length, first])));
      } else if (code === 11 && scram) {
        conn.write(message("p", Buffer.from(scram.clientFinal(body.subarray(4).toString("utf8")))));
      } else if (code === 12 && scram) {
        if (!scram.verifyServerFinal(body.subarray(4).toString("utf8"))) {
          throw new PgServerError("28000", "the server's SCRAM signature does not match");
        }
      } else {
        throw new PgServerError("28000", `unsupported authentication method ${code}`);
      }
      continue;
    }
    if (type === "S") {
      const [name = "", value = ""] = body.toString("utf8").split("\u0000");
      parameters.set(name, value);
      continue;
    }
    if (type === "Z") {
      return { conn, parameters };
    }
    // K (backend key) and N (notice) carry nothing the probe needs.
  }
}

/** One simple query; every value as text (null for NULL). */
export async function pgQuery(session: PgSession, sql: string): Promise<(string | null)[][]> {
  session.conn.write(message("Q", cstring(sql)));
  const rows: (string | null)[][] = [];
  let failure: PgServerError | null = null;
  for (;;) {
    const { type, body } = await readMessage(session.conn);
    if (type === "D") {
      const count = body.readUInt16BE(0);
      const row: (string | null)[] = [];
      let offset = 2;
      for (let column = 0; column < count; column++) {
        const length = body.readInt32BE(offset);
        offset += 4;
        if (length < 0) {
          row.push(null);
        } else {
          row.push(body.subarray(offset, offset + length).toString("utf8"));
          offset += length;
        }
      }
      if (rows.length < DB_MAX_DATABASES + 1) {
        rows.push(row);
      }
    } else if (type === "E") {
      failure = errorOf(body);
    } else if (type === "Z") {
      if (failure) {
        throw failure;
      }
      return rows;
    }
  }
}

export function pgTerminate(session: PgSession): void {
  try {
    session.conn.write(message("X", Buffer.alloc(0)));
  } catch {
    // The connection is closed right after.
  }
}

const bool = (value: string | null | undefined) => value === "t" || value === "true";

/**
 * The facts of the rights matrix and the identity (3.2, 3.3), read-only. `pg_control_system()`
 * is executable by every role; `pg_read_all_data` exists from PostgreSQL 14.
 */
export async function pgFacts(session: PgSession): Promise<DbPostgresFacts> {
  const [head] = await pgQuery(
    session,
    "SELECT current_setting('server_version_num'), version(), current_user, r.rolsuper, r.rolcreatedb, r.rolreplication, (SELECT system_identifier::text FROM pg_control_system()) FROM pg_roles r WHERE r.rolname = current_user",
  );
  const versionNum = Number(head?.[0] ?? "0") || 0;
  let readAllData: boolean | null = null;
  if (versionNum >= 140000) {
    const [row] = await pgQuery(
      session,
      "SELECT pg_has_role(current_user, 'pg_read_all_data', 'USAGE')",
    );
    readAllData = bool(row?.[0]);
  }
  const databases = await pgQuery(
    session,
    `SELECT d.oid::text, d.datname, d.datallowconn, has_database_privilege(d.oid, 'CONNECT'), CASE WHEN has_database_privilege(d.oid, 'CONNECT') THEN pg_database_size(d.oid)::text END FROM pg_database d WHERE NOT d.datistemplate ORDER BY d.datname LIMIT ${DB_MAX_DATABASES}`,
  );
  return {
    versionNum,
    version: (head?.[1] ?? "").slice(0, 512),
    currentUser: (head?.[2] ?? "").slice(0, 128),
    superuser: bool(head?.[3]),
    createDb: bool(head?.[4]),
    replication: bool(head?.[5]),
    readAllData,
    systemIdentifier: head?.[6] && /^\d{1,20}$/.test(head[6]) ? head[6] : null,
    databases: databases.map((row) => ({
      oid: row[0] ?? "0",
      name: (row[1] ?? "").slice(0, 128),
      allowConnections: bool(row[2]),
      canConnect: bool(row[3]),
      sizeBytes: row[4] ? Number(row[4]) : null,
    })),
  };
}

const count = (value: string | null | undefined): number | null =>
  value && /^\d{1,10}$/.test(value) ? Number(value) : null;

/**
 * The health check (docs/DATABASES.md 8), read-only: `SELECT 1` ends the response time (counted
 * from `started`, the start of the check), then the start time of the postmaster, the client
 * connections against `max_connections`, the cluster's identity and, when asked, the size of
 * every database the user may connect to.
 */
export async function pgHealth(
  session: PgSession,
  started: number,
  sizes: boolean,
): Promise<{ facts: DbHealthFacts; version: string }> {
  await pgQuery(session, "SELECT 1");
  const latencyMs = Math.max(0, Date.now() - started);
  const [head] = await pgQuery(
    session,
    "SELECT version(), extract(epoch FROM pg_postmaster_start_time())::bigint::text, (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend')::text, current_setting('max_connections'), (SELECT system_identifier::text FROM pg_control_system())",
  );
  const epoch = count(head?.[1]);
  const databases = sizes
    ? await pgQuery(
        session,
        `SELECT d.oid::text, d.datname, pg_database_size(d.oid)::text FROM pg_database d WHERE NOT d.datistemplate AND d.datallowconn AND has_database_privilege(d.oid, 'CONNECT') ORDER BY d.datname LIMIT ${DB_MAX_DATABASES}`,
      )
    : null;
  return {
    version: (head?.[0] ?? "").slice(0, 512),
    facts: {
      latencyMs,
      startedAt: epoch !== null ? new Date(epoch * 1000).toISOString() : null,
      connectionsUsed: count(head?.[2]),
      connectionsMax: count(head?.[3]),
      systemIdentifier: head?.[4] && /^\d{1,20}$/.test(head[4]) ? head[4] : null,
      serverUuid: null,
      serverId: null,
      datadir: null,
      databases:
        databases?.map((row) => ({
          oid: row[0] && /^\d{1,10}$/.test(row[0]) ? row[0] : null,
          name: (row[1] ?? "").slice(0, 128),
          sizeBytes: row[2] && /^\d+$/.test(row[2]) ? Number(row[2]) : null,
        })) ?? null,
    },
  };
}

/** The server version of a pg version string ("16.4" of "PostgreSQL 16.4 on x86_64..."). */
export function pgShortVersion(version: string): string | null {
  return /PostgreSQL\s+([0-9][0-9.]*\w*)/.exec(version)?.[1] ?? null;
}
