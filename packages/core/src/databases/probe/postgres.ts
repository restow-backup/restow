import { createHash, createHmac, pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { DbPostgresFacts } from "../facts.js";
import { DB_MAX_DATABASES } from "../model.js";
import { type DbConn, DbProbeAbort } from "./conn.js";

const pbkdf2Async = promisify(pbkdf2);

/**
 * The PostgreSQL side of the probe (docs/DATABASES.md 3): the SSLRequest that recognises the
 * engine, the sign-in (SCRAM-SHA-256, MD5 or a plain password, as the server asks) and the
 * read-only queries of the facts. Frontend/backend protocol 3.0, simple queries only.
 *
 * What a server may make the probe do is bounded: a message is at most {@link PG_MAX_MESSAGE}
 * bytes, the sign-in and every query end after a fixed number of messages, and SCRAM computes at
 * most {@link PG_SCRAM_MAX_ITERATIONS} rounds (off the event loop). The SCRAM exchange runs in
 * its order (server-first once, server-final after it) and the sign-in only counts when the
 * server proved it knows the password.
 */

/** The largest message the probe reads (the facts are small; the limit stops a flood). */
export const PG_MAX_MESSAGE = 1024 * 1024;
/** SCRAM rounds the probe computes at most (PostgreSQL's default is 4096). */
export const PG_SCRAM_MAX_ITERATIONS = 100_000;
/** Messages the sign-in may take (parameters, notices, the key). */
const PG_SIGN_IN_MAX_MESSAGES = 256;
/** A value of a row is kept up to this many bytes (the facts are short; the rest is dropped). */
export const DB_MAX_VALUE_BYTES = 4096;
/** Messages besides the rows a query may take (notices, the description, the tag). */
const PG_QUERY_MAX_EXTRA_MESSAGES = 256;

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
  if (length < 4 || length - 4 > PG_MAX_MESSAGE) {
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

  async clientFinal(serverFirst: string): Promise<string> {
    const attributes = new Map(
      serverFirst.split(",").map((part) => [part.slice(0, 1), part.slice(2)] as const),
    );
    const nonce = attributes.get("r") ?? "";
    const salt = Buffer.from(attributes.get("s") ?? "", "base64");
    const iterationsText = attributes.get("i") ?? "";
    const iterations = /^\d{1,10}$/.test(iterationsText) ? Number(iterationsText) : 0;
    if (nonce.length <= this.clientNonce.length || !nonce.startsWith(this.clientNonce)) {
      throw new PgServerError("08P01", "the server's SCRAM answer is not valid");
    }
    if (iterations < 1 || salt.length === 0) {
      throw new PgServerError("08P01", "the server's SCRAM answer is not valid");
    }
    if (iterations > PG_SCRAM_MAX_ITERATIONS) {
      throw new DbProbeAbort(
        "db_auth_unsupported",
        `the server asks for ${iterations} SCRAM iterations; Restow computes at most ${PG_SCRAM_MAX_ITERATIONS}`,
      );
    }
    // On the thread pool: the event loop serves other requests meanwhile.
    this.saltedPassword = await pbkdf2Async(
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
    const expected = hmac(serverKey, this.authMessage);
    const given = Buffer.from(verifier, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
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
  /** start, then password (3, 5) or sasl (10) -> sasl-continue (11) -> sasl-final (12), then ok. */
  let state: "start" | "password" | "sasl" | "sasl-continue" | "sasl-final" | "ok" = "start";
  const parameters = new Map<string, string>();
  const needPassword = (): string => {
    if (password === null) {
      throw new PgServerError("28P01", "the server asks for a password and none was given");
    }
    return password;
  };
  const outOfOrder = (code: number) =>
    new PgServerError("08P01", `unexpected authentication message ${code} during the sign-in`);
  for (let count = 0; count < PG_SIGN_IN_MAX_MESSAGES; count++) {
    const { type, body } = await readMessage(conn);
    if (type === "E") {
      throw errorOf(body);
    }
    if (type === "R") {
      if (body.length < 4) {
        throw new PgServerError("08P01", "invalid authentication message from the server");
      }
      const code = body.readUInt32BE(0);
      if (code === 0) {
        // Without a password (trust), after a password, or after the server's SCRAM proof.
        if (state !== "start" && state !== "password" && state !== "sasl-final") {
          throw new DbProbeAbort(
            "db_probe_failed",
            "the server accepted the sign-in without proving the SCRAM exchange",
          );
        }
        state = "ok";
        continue;
      }
      const expected = state === "sasl" ? 11 : state === "sasl-continue" ? 12 : null;
      if (state === "start" ? code === 11 || code === 12 : code !== expected) {
        throw outOfOrder(code);
      }
      if (code === 3 || code === 5) {
        state = "password";
        conn.write(
          code === 3
            ? message("p", cstring(needPassword()))
            : message("p", cstring(pgMd5Password(user, needPassword(), body.subarray(4, 8)))),
        );
      } else if (code === 10) {
        const mechanisms = body.subarray(4).toString("utf8").split("\u0000").filter(Boolean);
        if (!mechanisms.includes("SCRAM-SHA-256")) {
          throw new DbProbeAbort(
            "db_auth_unsupported",
            `unsupported SASL mechanisms: ${mechanisms.join(", ").slice(0, 200)}`,
          );
        }
        scram = new PgScram(needPassword());
        state = "sasl";
        const first = Buffer.from(scram.clientFirst(), "utf8");
        const length = Buffer.alloc(4);
        length.writeInt32BE(first.length);
        conn.write(message("p", Buffer.concat([cstring("SCRAM-SHA-256"), length, first])));
      } else if (code === 11 && scram) {
        state = "sasl-continue";
        const final = await scram.clientFinal(body.subarray(4).toString("utf8"));
        conn.write(message("p", Buffer.from(final)));
      } else if (code === 12 && scram) {
        if (!scram.verifyServerFinal(body.subarray(4).toString("utf8"))) {
          throw new DbProbeAbort("db_probe_failed", "the server's SCRAM signature does not match");
        }
        state = "sasl-final";
      } else {
        throw new DbProbeAbort("db_auth_unsupported", `unsupported authentication method ${code}`);
      }
      continue;
    }
    if (type === "S") {
      const [name = "", value = ""] = body.toString("utf8").split("\u0000");
      if (parameters.size < 64) {
        parameters.set(name.slice(0, 64), value.slice(0, 256));
      }
      continue;
    }
    if (type === "Z") {
      if (state !== "ok") {
        throw new PgServerError("08P01", "the server ended the sign-in without accepting it");
      }
      return { conn, parameters };
    }
    // K (backend key) and N (notice) carry nothing the probe needs.
  }
  throw new PgServerError("08P01", "the sign-in did not finish");
}

/** One simple query; every value as text (null for NULL). */
export async function pgQuery(session: PgSession, sql: string): Promise<(string | null)[][]> {
  session.conn.write(message("Q", cstring(sql)));
  const rows: (string | null)[][] = [];
  let failure: PgServerError | null = null;
  // The probe's queries return at most DB_MAX_DATABASES rows; a server that sends more is cut off.
  const maxMessages = DB_MAX_DATABASES + 1 + PG_QUERY_MAX_EXTRA_MESSAGES;
  for (let index = 0; index < maxMessages; index++) {
    const { type, body } = await readMessage(session.conn);
    if (type === "D") {
      if (body.length < 2) {
        throw new PgServerError("08P01", "invalid data row from the server");
      }
      const count = body.readUInt16BE(0);
      if (count > 64) {
        throw new PgServerError("08P01", "more columns than the probe asked for");
      }
      const row: (string | null)[] = [];
      let offset = 2;
      for (let column = 0; column < count; column++) {
        const length = body.readInt32BE(offset);
        offset += 4;
        if (length < 0) {
          row.push(null);
        } else {
          if (offset + length > body.length) {
            throw new PgServerError("08P01", "invalid data row from the server");
          }
          // Only the beginning of a long value is kept, while the row is read.
          row.push(
            body.subarray(offset, offset + Math.min(length, DB_MAX_VALUE_BYTES)).toString("utf8"),
          );
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
  throw new PgServerError("08P01", "the query did not finish");
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

/** The server version of a pg version string ("16.4" of "PostgreSQL 16.4 on x86_64..."). */
export function pgShortVersion(version: string): string | null {
  return /PostgreSQL\s+([0-9][0-9.]*\w*)/.exec(version)?.[1] ?? null;
}
