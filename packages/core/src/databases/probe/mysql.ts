import { constants, createHash, publicEncrypt } from "node:crypto";
import type { DbHealthFacts, DbMysqlFacts } from "../facts.js";
import { DB_MAX_DATABASES } from "../model.js";
import { redactIdentifiedBy } from "../sanitize.js";
import type { DbConn } from "./conn.js";

/**
 * The MySQL and MariaDB side of the probe (docs/DATABASES.md 3): the server speaks first with a
 * greeting (protocol 10) that names its version, and MariaDB names itself in it. The sign-in
 * speaks mysql_native_password and caching_sha2_password (the default of MySQL 8), over TLS when
 * the server offers it; without TLS the full caching_sha2 exchange encrypts the password with the
 * server's RSA key. Text protocol, read-only queries.
 */

const CLIENT_LONG_PASSWORD = 0x1;
const CLIENT_LONG_FLAG = 0x4;
const CLIENT_CONNECT_WITH_DB = 0x8;
const CLIENT_PROTOCOL_41 = 0x200;
const CLIENT_SSL = 0x800;
const CLIENT_TRANSACTIONS = 0x2000;
const CLIENT_SECURE_CONNECTION = 0x8000;
const CLIENT_PLUGIN_AUTH = 0x80000;
const CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA = 0x200000;

/** utf8mb4_general_ci: known to MySQL 5.5 and later and to every MariaDB. */
const CHARSET_UTF8MB4 = 45;
const MAX_PACKET = 16 * 1024 * 1024;

export class MysqlServerError extends Error {
  constructor(
    readonly errno: number,
    message: string,
  ) {
    super(message);
    this.name = "MysqlServerError";
  }
}

/** Access denied (1045, 1044, 1698), host not allowed (1130), plugin refused (1251, 1524). */
export function isMysqlLoginError(error: unknown): boolean {
  return (
    error instanceof MysqlServerError && [1044, 1045, 1130, 1251, 1524, 1698].includes(error.errno)
  );
}

export interface MysqlGreeting {
  protocol: number;
  serverVersion: string;
  connectionId: number;
  scramble: Buffer;
  capabilities: number;
  authPlugin: string;
  /** MariaDB names itself in the version ("5.5.5-10.11.6-MariaDB", "11.8.2-MariaDB-ubu2404"). */
  mariadb: boolean;
}

/** One packet: 3 bytes length, 1 byte sequence, payload. */
export function splitMysqlPacket(
  data: Buffer,
): { sequence: number; payload: Buffer; rest: Buffer } | null {
  if (data.length < 4) {
    return null;
  }
  const length = data.readUIntLE(0, 3);
  if (data.length < 4 + length) {
    return null;
  }
  return {
    sequence: data.readUInt8(3),
    payload: data.subarray(4, 4 + length),
    rest: data.subarray(4 + length),
  };
}

/** Read the server's greeting; null when the bytes are no MySQL greeting. */
export function parseMysqlGreeting(payload: Buffer): MysqlGreeting | null {
  if (payload.length < 1) {
    return null;
  }
  const protocol = payload.readUInt8(0);
  if (protocol === 0xff) {
    // An error before the handshake ("Host … is not allowed to connect"): still MySQL or MariaDB.
    return null;
  }
  if (protocol !== 10) {
    return null;
  }
  const versionEnd = payload.indexOf(0, 1);
  if (versionEnd < 0 || versionEnd > 128 || payload.length < versionEnd + 1 + 4 + 8 + 1 + 2) {
    return null;
  }
  const serverVersion = payload.subarray(1, versionEnd).toString("latin1");
  if (!/^\d+\.\d+/.test(serverVersion)) {
    return null;
  }
  let offset = versionEnd + 1;
  const connectionId = payload.readUInt32LE(offset);
  offset += 4;
  const part1 = payload.subarray(offset, offset + 8);
  offset += 8 + 1;
  let capabilities = payload.readUInt16LE(offset);
  offset += 2;
  let authPlugin = "mysql_native_password";
  let scramble = Buffer.from(part1);
  if (payload.length >= offset + 1 + 2 + 2 + 1 + 10) {
    offset += 1 + 2; // charset, status
    capabilities |= payload.readUInt16LE(offset) << 16;
    offset += 2;
    const authDataLength = payload.readUInt8(offset);
    offset += 1 + 10;
    if (capabilities & CLIENT_SECURE_CONNECTION) {
      const part2Length = Math.max(13, authDataLength - 8);
      const part2 = payload.subarray(offset, offset + part2Length);
      offset += part2Length;
      // The second part ends with a NUL that is not part of the scramble.
      scramble = Buffer.concat([part1, part2.subarray(0, Math.max(0, part2Length - 1))]);
    }
    if (capabilities & CLIENT_PLUGIN_AUTH) {
      const end = payload.indexOf(0, offset);
      authPlugin = payload.subarray(offset, end < 0 ? payload.length : end).toString("latin1");
    }
  }
  return {
    protocol,
    serverVersion,
    connectionId,
    scramble: scramble.subarray(0, 20),
    capabilities: capabilities >>> 0,
    authPlugin,
    mariadb: /mariadb/i.test(serverVersion),
  };
}

/** The version of a greeting without MariaDB's replication prefix ("5.5.5-"). */
export function mysqlShortVersion(serverVersion: string): string {
  return serverVersion.replace(/^5\.5\.5-/, "").split("-")[0] ?? serverVersion;
}

function sha1(...parts: Buffer[]): Buffer {
  const hash = createHash("sha1");
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest();
}

function sha256(...parts: Buffer[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest();
}

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let index = 0; index < a.length; index++) {
    out[index] = (a[index] ?? 0) ^ (b[index % b.length] ?? 0);
  }
  return out;
}

/** mysql_native_password: SHA1(password) XOR SHA1(scramble + SHA1(SHA1(password))). */
export function mysqlNativePassword(password: string, scramble: Buffer): Buffer {
  if (password === "") {
    return Buffer.alloc(0);
  }
  const stage1 = sha1(Buffer.from(password, "utf8"));
  return xor(stage1, sha1(scramble.subarray(0, 20), sha1(stage1)));
}

/** caching_sha2_password: SHA256(password) XOR SHA256(SHA256(SHA256(password)) + scramble). */
export function mysqlCachingSha2Password(password: string, scramble: Buffer): Buffer {
  if (password === "") {
    return Buffer.alloc(0);
  }
  const stage1 = sha256(Buffer.from(password, "utf8"));
  return xor(stage1, sha256(sha256(stage1), scramble.subarray(0, 20)));
}

function authResponse(plugin: string, password: string, scramble: Buffer, tls: boolean): Buffer {
  switch (plugin) {
    case "mysql_native_password":
      return mysqlNativePassword(password, scramble);
    case "caching_sha2_password":
      return mysqlCachingSha2Password(password, scramble);
    case "mysql_clear_password":
      if (!tls) {
        throw new MysqlServerError(
          1251,
          "the server asks for the password in clear text without TLS",
        );
      }
      return Buffer.concat([Buffer.from(password, "utf8"), Buffer.from([0])]);
    default:
      throw new MysqlServerError(1251, `unsupported authentication plugin ${plugin}`);
  }
}

class Packets {
  sequence = 0;
  constructor(readonly conn: DbConn) {}

  async read(): Promise<Buffer> {
    const header = await this.conn.read(4);
    const length = header.readUIntLE(0, 3);
    this.sequence = (header.readUInt8(3) + 1) & 0xff;
    return this.conn.read(length);
  }

  write(payload: Buffer): void {
    const header = Buffer.alloc(4);
    header.writeUIntLE(payload.length, 0, 3);
    header.writeUInt8(this.sequence, 3);
    this.sequence = (this.sequence + 1) & 0xff;
    this.conn.write(Buffer.concat([header, payload]));
  }
}

function errorOf(payload: Buffer): MysqlServerError {
  const errno = payload.length >= 3 ? payload.readUInt16LE(1) : 0;
  let text = payload.subarray(3).toString("utf8");
  if (text.startsWith("#")) {
    text = text.slice(6);
  }
  return new MysqlServerError(errno, text);
}

function lenenc(value: number): Buffer {
  if (value < 251) {
    return Buffer.from([value]);
  }
  const out = Buffer.alloc(3);
  out.writeUInt8(0xfc, 0);
  out.writeUInt16LE(value, 1);
  return out;
}

function readLenenc(buffer: Buffer, offset: number): { value: number | null; next: number } {
  const first = buffer.readUInt8(offset);
  if (first < 0xfb) {
    return { value: first, next: offset + 1 };
  }
  if (first === 0xfb) {
    return { value: null, next: offset + 1 };
  }
  if (first === 0xfc) {
    return { value: buffer.readUInt16LE(offset + 1), next: offset + 3 };
  }
  if (first === 0xfd) {
    return { value: buffer.readUIntLE(offset + 1, 3), next: offset + 4 };
  }
  return { value: Number(buffer.readBigUInt64LE(offset + 1)), next: offset + 9 };
}

export interface MysqlSession {
  packets: Packets;
  greeting: MysqlGreeting;
}

/** Read the greeting of a fresh connection. */
export async function mysqlReadGreeting(conn: DbConn): Promise<MysqlGreeting> {
  const packets = new Packets(conn);
  const payload = await packets.read();
  if (payload.readUInt8(0) === 0xff) {
    throw errorOf(payload);
  }
  const greeting = parseMysqlGreeting(payload);
  if (!greeting) {
    throw new MysqlServerError(0, "the server's greeting is not MySQL protocol 10");
  }
  return greeting;
}

export function mysqlOffersTls(greeting: MysqlGreeting): boolean {
  return (greeting.capabilities & CLIENT_SSL) !== 0;
}

/**
 * Sign in after the greeting: `startTls` is called when TLS is to be used (the server offers it);
 * the caller decides whether a connection without TLS is allowed at all.
 */
export async function mysqlSignIn(
  conn: DbConn,
  greeting: MysqlGreeting,
  options: {
    user: string;
    password: string | null;
    database: string | null;
    startTls: (() => Promise<void>) | null;
  },
): Promise<MysqlSession> {
  const packets = new Packets(conn);
  packets.sequence = 1;
  let capabilities =
    CLIENT_LONG_PASSWORD |
    CLIENT_LONG_FLAG |
    CLIENT_PROTOCOL_41 |
    CLIENT_TRANSACTIONS |
    CLIENT_SECURE_CONNECTION |
    CLIENT_PLUGIN_AUTH |
    CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA;
  if (options.database) {
    capabilities |= CLIENT_CONNECT_WITH_DB;
  }
  const tls = options.startTls !== null;
  if (tls) {
    capabilities |= CLIENT_SSL;
  }
  capabilities &= greeting.capabilities | CLIENT_SSL | CLIENT_CONNECT_WITH_DB;
  const fixed = Buffer.alloc(32);
  fixed.writeUInt32LE(capabilities >>> 0, 0);
  fixed.writeUInt32LE(MAX_PACKET, 4);
  fixed.writeUInt8(CHARSET_UTF8MB4, 8);
  if (options.startTls) {
    packets.write(fixed);
    await options.startTls();
  }
  const password = options.password ?? "";
  let plugin = greeting.authPlugin || "mysql_native_password";
  let scramble = greeting.scramble;
  const response = authResponse(plugin, password, scramble, tls);
  packets.write(
    Buffer.concat([
      fixed,
      Buffer.from(options.user, "utf8"),
      Buffer.from([0]),
      lenenc(response.length),
      response,
      ...(options.database ? [Buffer.from(options.database, "utf8"), Buffer.from([0])] : []),
      Buffer.from(plugin, "latin1"),
      Buffer.from([0]),
    ]),
  );
  for (let round = 0; round < 6; round++) {
    const payload = await packets.read();
    const head = payload.readUInt8(0);
    if (head === 0x00) {
      return { packets, greeting };
    }
    if (head === 0xff) {
      throw errorOf(payload);
    }
    if (head === 0xfe) {
      // Auth switch: another plugin with fresh data.
      const end = payload.indexOf(0, 1);
      plugin = payload.subarray(1, end < 0 ? payload.length : end).toString("latin1");
      const data = end < 0 ? Buffer.alloc(0) : payload.subarray(end + 1);
      scramble = data.length > 20 ? data.subarray(0, 20) : data;
      packets.write(authResponse(plugin, password, scramble, tls));
      continue;
    }
    if (head === 0x01) {
      const status = payload.readUInt8(1);
      if (plugin === "caching_sha2_password" && status === 0x03) {
        // Fast authentication succeeded; the OK packet follows.
        continue;
      }
      if (plugin === "caching_sha2_password" && status === 0x04) {
        if (tls) {
          packets.write(Buffer.concat([Buffer.from(password, "utf8"), Buffer.from([0])]));
          continue;
        }
        // Without TLS: ask for the server's RSA key and encrypt the password with it.
        packets.write(Buffer.from([0x02]));
        const keyPacket = await packets.read();
        if (keyPacket.readUInt8(0) === 0xff) {
          throw errorOf(keyPacket);
        }
        const pem = keyPacket.subarray(1).toString("latin1");
        const plain = xor(
          Buffer.concat([Buffer.from(password, "utf8"), Buffer.from([0])]),
          scramble,
        );
        packets.write(
          publicEncrypt(
            { key: pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
            plain,
          ),
        );
        continue;
      }
    }
    throw new MysqlServerError(0, `unexpected answer during the sign-in (0x${head.toString(16)})`);
  }
  throw new MysqlServerError(0, "the sign-in did not finish");
}

/** One text query; every value as text (null for NULL). */
export async function mysqlQuery(session: MysqlSession, sql: string): Promise<(string | null)[][]> {
  const { packets } = session;
  packets.sequence = 0;
  packets.write(Buffer.concat([Buffer.from([0x03]), Buffer.from(sql, "utf8")]));
  const first = await packets.read();
  if (first.readUInt8(0) === 0xff) {
    throw errorOf(first);
  }
  if (first.readUInt8(0) === 0x00) {
    return [];
  }
  const columns = readLenenc(first, 0).value ?? 0;
  for (let index = 0; index < columns; index++) {
    await packets.read();
  }
  // EOF after the column definitions (the probe does not ask for CLIENT_DEPRECATE_EOF).
  await packets.read();
  const rows: (string | null)[][] = [];
  for (;;) {
    const payload = await packets.read();
    const head = payload.readUInt8(0);
    if (head === 0xfe && payload.length < 9) {
      return rows;
    }
    if (head === 0xff) {
      throw errorOf(payload);
    }
    const row: (string | null)[] = [];
    let offset = 0;
    for (let column = 0; column < columns; column++) {
      const { value, next } = readLenenc(payload, offset);
      if (value === null) {
        row.push(null);
        offset = next;
      } else {
        row.push(payload.subarray(next, next + value).toString("utf8"));
        offset = next + value;
      }
    }
    if (rows.length <= DB_MAX_DATABASES) {
      rows.push(row);
    }
  }
}

export function mysqlQuit(session: MysqlSession): void {
  try {
    session.packets.sequence = 0;
    session.packets.write(Buffer.from([0x01]));
  } catch {
    // Closed right after.
  }
}

async function optionalValue(session: MysqlSession, sql: string): Promise<string | null> {
  try {
    const [row] = await mysqlQuery(session, sql);
    return row?.[0] ?? null;
  } catch (error) {
    if (error instanceof MysqlServerError) {
      return null;
    }
    throw error;
  }
}

/** The facts of the rights matrix and the identity (3.2, 3.3), read-only. */
export async function mysqlFacts(session: MysqlSession): Promise<DbMysqlFacts> {
  const [head] = await mysqlQuery(
    session,
    "SELECT VERSION(), @@version_comment, CURRENT_USER(), @@server_id, @@datadir",
  );
  const serverUuid = await optionalValue(session, "SELECT @@server_uuid");
  const logBin = await optionalValue(session, "SELECT @@log_bin");
  const binlogFormat = await optionalValue(session, "SELECT @@binlog_format");
  const grants = (await mysqlQuery(session, "SHOW GRANTS"))
    .map((row) => redactIdentifiedBy(row[0] ?? ""))
    .filter((line) => line.length > 0)
    .slice(0, 200)
    .map((line) => line.slice(0, 4096));
  const schemas = await mysqlQuery(
    session,
    `SELECT s.SCHEMA_NAME, (SELECT SUM(t.DATA_LENGTH + t.INDEX_LENGTH) FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA = s.SCHEMA_NAME) FROM information_schema.SCHEMATA s ORDER BY s.SCHEMA_NAME LIMIT ${DB_MAX_DATABASES}`,
  );
  const serverId = Number(head?.[3]);
  return {
    version: (head?.[0] ?? "").slice(0, 256),
    versionComment: head?.[1]?.slice(0, 256) ?? null,
    currentUser: (head?.[2] ?? "").slice(0, 300),
    grants,
    serverUuid: serverUuid && serverUuid.length <= 64 ? serverUuid : null,
    serverId: Number.isInteger(serverId) && serverId >= 0 ? serverId : null,
    datadir: head?.[4]?.slice(0, 1024) ?? null,
    logBin: logBin === null ? null : logBin === "1" || logBin.toUpperCase() === "ON",
    binlogFormat: binlogFormat?.slice(0, 32) ?? null,
    databases: schemas.map((row) => ({
      name: (row[0] ?? "").slice(0, 128),
      sizeBytes:
        row[1] !== null && row[1] !== undefined && /^\d+$/.test(row[1]) ? Number(row[1]) : null,
    })),
  };
}

const count = (value: string | null | undefined): number | null =>
  value && /^\d{1,18}$/.test(value) ? Number(value) : null;

/**
 * The health check (docs/DATABASES.md 8), read-only: `SELECT 1` ends the response time (counted
 * from `started`), then `Uptime` and `Threads_connected` against `max_connections`, the identity
 * of the instance and, when asked, the size of every schema.
 */
export async function mysqlHealth(
  session: MysqlSession,
  started: number,
  sizes: boolean,
): Promise<DbHealthFacts> {
  await mysqlQuery(session, "SELECT 1");
  const latencyMs = Math.max(0, Date.now() - started);
  const [head] = await mysqlQuery(session, "SELECT @@max_connections, @@server_id, @@datadir");
  const serverUuid = await optionalValue(session, "SELECT @@server_uuid");
  const status = new Map<string, string | null>();
  for (const row of await mysqlQuery(
    session,
    "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime', 'Threads_connected')",
  )) {
    status.set((row[0] ?? "").toLowerCase(), row[1] ?? null);
  }
  const uptime = count(status.get("uptime"));
  const serverId = count(head?.[1]);
  const schemas = sizes
    ? await mysqlQuery(
        session,
        `SELECT s.SCHEMA_NAME, (SELECT SUM(t.DATA_LENGTH + t.INDEX_LENGTH) FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA = s.SCHEMA_NAME) FROM information_schema.SCHEMATA s ORDER BY s.SCHEMA_NAME LIMIT ${DB_MAX_DATABASES}`,
      )
    : null;
  return {
    latencyMs,
    // Whole seconds: a start time that moves by a second or two is no restart.
    startedAt: uptime !== null ? new Date(Date.now() - uptime * 1000).toISOString() : null,
    connectionsUsed: count(status.get("threads_connected")),
    connectionsMax: count(head?.[0]),
    systemIdentifier: null,
    serverUuid: serverUuid && serverUuid.length <= 64 ? serverUuid : null,
    serverId,
    datadir: head?.[2]?.slice(0, 1024) ?? null,
    databases:
      schemas?.map((row) => ({
        name: (row[0] ?? "").slice(0, 128),
        oid: null,
        sizeBytes: count(row[1]),
      })) ?? null,
  };
}
