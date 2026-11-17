import { constants, createHash, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { createSecureContext, TLSSocket } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { createSelfSignedCertificate } from "../../../../../scripts/smoke/lib/selfsigned.mjs";
import type { DbProbeSpec } from "../facts.js";
import { evaluateDbRights } from "../rights.js";
import { parseMysqlGreeting, splitMysqlPacket } from "./mysql.js";
import { probeDatabaseFromServer } from "./probe.js";
import { parseTdsPreloginResponse, tdsPreloginPacket } from "./tds.js";

/**
 * The server executor's probe against servers that speak just enough of each protocol (MySQL
 * and MariaDB are not installed where the tests run): greetings and PRELOGIN answers built from
 * the protocol descriptions, a sign-in that checks the client's proof the way the server does,
 * and canned answers to the probe's queries. PostgreSQL runs for real in pg.test.ts.
 */

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function listen(onConnection: (socket: Socket) => void): Promise<number> {
  const server = createServer((socket) => {
    sockets.push(socket);
    onConnection(socket);
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

function spec(overrides: Partial<DbProbeSpec> = {}): DbProbeSpec {
  return {
    probeId: "00000000-0000-4000-8000-000000000001",
    engine: null,
    host: "127.0.0.1",
    port: null,
    path: null,
    database: null,
    authMethod: "password",
    user: "restow_backup",
    password: "s3cret-pass",
    allowUnencrypted: true,
    timeoutSeconds: 10,
    ...overrides,
  };
}

const allowLoopback = { allowPrivateNetworks: true, greetingWaitMs: 200, stepTimeoutMs: 2000 };

// ---------------------------------------------------------------------------
// A MySQL / MariaDB server, just enough
// ---------------------------------------------------------------------------

const SCRAMBLE = Buffer.from("abcdefghijklmnopqrst", "latin1");

function packet(sequence: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUIntLE(payload.length, 0, 3);
  header.writeUInt8(sequence, 3);
  return Buffer.concat([header, payload]);
}

/** A protocol-10 greeting as MySQL 8.4 or MariaDB 11 sends it. */
export function mysqlGreeting(version: string, options: { ssl: boolean; plugin: string }): Buffer {
  const lower = options.ssl ? 0xffff : 0xf7ff;
  const upper = 0x81bf | 0x0008; // PLUGIN_AUTH and friends
  return Buffer.concat([
    Buffer.from([10]),
    Buffer.from(version, "latin1"),
    Buffer.from([0]),
    Buffer.from([0x2a, 0x00, 0x00, 0x00]),
    SCRAMBLE.subarray(0, 8),
    Buffer.from([0]),
    Buffer.from([lower & 0xff, lower >> 8]),
    Buffer.from([45]),
    Buffer.from([0x02, 0x00]),
    Buffer.from([upper & 0xff, upper >> 8]),
    Buffer.from([21]),
    Buffer.alloc(10),
    SCRAMBLE.subarray(8, 20),
    Buffer.from([0]),
    Buffer.from(options.plugin, "latin1"),
    Buffer.from([0]),
  ]);
}

function lenencString(text: string | null): Buffer {
  if (text === null) {
    return Buffer.from([0xfb]);
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length < 251) {
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  }
  if (bytes.length < 0x10000) {
    const head = Buffer.alloc(3);
    head.writeUInt8(0xfc, 0);
    head.writeUInt16LE(bytes.length, 1);
    return Buffer.concat([head, bytes]);
  }
  const head = Buffer.alloc(4);
  head.writeUInt8(0xfd, 0);
  head.writeUIntLE(bytes.length, 1, 3);
  return Buffer.concat([head, bytes]);
}

function resultSet(rows: (string | null)[][], columns: number): Buffer[] {
  const out = [Buffer.from([columns])];
  for (let index = 0; index < columns; index++) {
    out.push(Buffer.concat([lenencString("def"), Buffer.alloc(8)]));
  }
  out.push(Buffer.from([0xfe, 0, 0, 2, 0]));
  for (const row of rows) {
    out.push(Buffer.concat(row.map(lenencString)));
  }
  out.push(Buffer.from([0xfe, 0, 0, 2, 0]));
  return out;
}

function mysqlError(errno: number, message: string): Buffer {
  const head = Buffer.alloc(3);
  head.writeUInt8(0xff, 0);
  head.writeUInt16LE(errno, 1);
  return Buffer.concat([head, Buffer.from(`#28000${message}`, "utf8")]);
}

interface FakeMysql {
  version: string;
  password: string;
  plugin: "mysql_native_password" | "caching_sha2_password";
  ssl: boolean;
  grants: string[];
  serverUuid: string | null;
  /** caching_sha2: the server's cache is cold and asks for the full exchange. */
  fullAuth?: boolean;
  seen?: { tls: boolean; user: string };
}

const cert = createSelfSignedCertificate({ commonName: "db.example.test" });
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });

function sha1(...parts: Buffer[]): Buffer {
  const hash = createHash("sha1");
  for (const part of parts) hash.update(part);
  return hash.digest();
}
function sha256(...parts: Buffer[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}
function xor(a: Buffer, b: Buffer): Buffer {
  return Buffer.from(a.map((byte, index) => byte ^ (b[index % b.length] ?? 0)));
}

function startMysql(fake: FakeMysql): Promise<number> {
  return listen((raw) => {
    let socket: Socket = raw;
    let buffer = Buffer.alloc(0);
    let stage: "handshake" | "auth_more" | "rsa" | "command" = "handshake";
    let tls = false;
    let switched = false;
    const send = (sequence: number, payload: Buffer) => socket.write(packet(sequence, payload));
    const ok = (sequence: number) => send(sequence, Buffer.from([0, 0, 0, 2, 0, 0, 0]));
    const onPacket = (sequence: number, payload: Buffer) => {
      if (stage === "handshake") {
        if (payload.length === 32 && (payload.readUInt32LE(0) & 0x800) !== 0) {
          // SSL request: switch to TLS and wait for the handshake response.
          // The client's hello may have come in the same read: feed TLS through a stream of
          // its own, starting with what is left of the buffer.
          raw.removeAllListeners("data");
          const wire = new Duplex({
            read() {},
            write(chunk, _encoding, callback) {
              raw.write(chunk, callback);
            },
          });
          if (buffer.length > 0) {
            wire.push(buffer);
            buffer = Buffer.alloc(0);
          }
          raw.on("data", (chunk) => wire.push(chunk));
          const secure = new TLSSocket(wire as unknown as Socket, {
            isServer: true,
            secureContext: createSecureContext({ cert: cert.certPem, key: cert.keyPem }),
          });
          secure.on("data", onData);
          secure.on("error", () => undefined);
          socket = secure;
          tls = true;
          switched = true;
          return;
        }
        const userEnd = payload.indexOf(0, 32);
        const user = payload.subarray(32, userEnd).toString("utf8");
        const length = payload.readUInt8(userEnd + 1);
        const token = payload.subarray(userEnd + 2, userEnd + 2 + length);
        fake.seen = { tls, user };
        let good: boolean;
        if (fake.plugin === "mysql_native_password") {
          const stored = sha1(sha1(Buffer.from(fake.password)));
          const stage1 = xor(token, sha1(SCRAMBLE, stored));
          good = sha1(stage1).equals(stored);
        } else {
          const stage1 = sha256(Buffer.from(fake.password));
          good = xor(token, sha256(sha256(stage1), SCRAMBLE)).equals(stage1);
        }
        if (!good) {
          send(
            sequence + 1,
            mysqlError(1045, `Access denied for user '${user}'@'localhost' (using password: YES)`),
          );
          return;
        }
        if (fake.plugin === "caching_sha2_password" && fake.fullAuth) {
          stage = "auth_more";
          send(sequence + 1, Buffer.from([0x01, 0x04]));
          return;
        }
        if (fake.plugin === "caching_sha2_password") {
          send(sequence + 1, Buffer.from([0x01, 0x03]));
        }
        stage = "command";
        ok(fake.plugin === "caching_sha2_password" ? sequence + 2 : sequence + 1);
        return;
      }
      if (stage === "auth_more") {
        if (payload.length === 1 && payload[0] === 0x02) {
          stage = "rsa";
          send(
            sequence + 1,
            Buffer.concat([
              Buffer.from([0x01]),
              Buffer.from(rsa.publicKey.export({ type: "spki", format: "pem" })),
            ]),
          );
          return;
        }
        const clear = payload.subarray(0, payload.length - 1).toString("utf8");
        stage = "command";
        if (clear === fake.password) ok(sequence + 1);
        else send(sequence + 1, mysqlError(1045, "Access denied"));
        return;
      }
      if (stage === "rsa") {
        const plain = privateDecrypt(
          { key: rsa.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
          payload,
        );
        const clear = xor(plain, SCRAMBLE).subarray(0, -1).toString("utf8");
        stage = "command";
        if (clear === fake.password) ok(sequence + 1);
        else send(sequence + 1, mysqlError(1045, "Access denied"));
        return;
      }
      if (payload[0] === 0x01) {
        socket.end();
        return;
      }
      const sql = payload.subarray(1).toString("utf8");
      let answer: Buffer[];
      if (sql.startsWith("SELECT VERSION()")) {
        answer = resultSet(
          [[fake.version, "Fake server", "restow_backup@%", "7", "/var/lib/mysql/"]],
          5,
        );
      } else if (sql === "SELECT @@server_uuid") {
        answer =
          fake.serverUuid === null
            ? [mysqlError(1193, "Unknown system variable 'server_uuid'")]
            : resultSet([[fake.serverUuid]], 1);
      } else if (sql === "SELECT 1") {
        answer = resultSet([["1"]], 1);
      } else if (sql === "SELECT @@max_connections, @@server_id, @@datadir") {
        answer = resultSet([["151", "7", "/var/lib/mysql/"]], 3);
      } else if (sql.startsWith("SHOW GLOBAL STATUS")) {
        answer = resultSet(
          [
            ["Threads_connected", "4"],
            ["Uptime", "3600"],
          ],
          2,
        );
      } else if (sql === "SELECT @@log_bin") {
        answer = resultSet([["1"]], 1);
      } else if (sql === "SELECT @@binlog_format") {
        answer = resultSet([["ROW"]], 1);
      } else if (sql === "SHOW GRANTS") {
        answer = resultSet(
          fake.grants.map((grant) => [grant]),
          1,
        );
      } else if (sql.includes("information_schema.SCHEMATA")) {
        answer = resultSet(
          [
            ["app", "16384"],
            ["information_schema", null],
            ["mysql", "2048"],
            ["shop", null],
          ],
          2,
        );
      } else {
        answer = [mysqlError(1064, "unexpected query")];
      }
      answer.forEach((part, index) => {
        send(sequence + 1 + index, part);
      });
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      switched = false;
      for (;;) {
        const split = splitMysqlPacket(buffer);
        if (!split) break;
        buffer = Buffer.from(split.rest);
        onPacket(split.sequence, split.payload);
        if (switched) break;
      }
    };
    raw.on("data", onData);
    raw.on("error", () => undefined);
    raw.write(packet(0, mysqlGreeting(fake.version, { ssl: fake.ssl, plugin: fake.plugin })));
  });
}

/** A port that answers PRELOGIN as SQL Server 2022 (16.0.1000) with encryption off. */
function startSqlServer(): Promise<number> {
  return listen((socket) => {
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      if (chunk[0] !== 0x12) {
        socket.destroy();
        return;
      }
      const reply = Buffer.from(tdsPreloginPacket());
      reply.writeUInt8(0x04, 0);
      // VERSION 16.0.1000 at the data offset of the first option.
      const offset = 8 + reply.readUInt16BE(8 + 1);
      reply.writeUInt8(16, offset);
      reply.writeUInt8(0, offset + 1);
      reply.writeUInt16BE(1000, offset + 2);
      reply.writeUInt8(0x00, 8 + reply.readUInt16BE(8 + 5 + 1));
      socket.write(reply);
    });
  });
}

describe("engine detection from the address alone [DB-001]", () => {
  it("recognises MySQL 8.4 from its greeting and signs in with caching_sha2_password over TLS", async () => {
    const fake: FakeMysql = {
      version: "8.4.3",
      password: "s3cret-pass",
      plugin: "caching_sha2_password",
      ssl: true,
      grants: [
        "GRANT SELECT, RELOAD, PROCESS, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER ON *.* TO `restow_backup`@`%`",
      ],
      serverUuid: "3e11fa47-71ca-11e1-9e33-c80aa9429562",
    };
    const port = await startMysql(fake);
    const result = await probeDatabaseFromServer(spec({ port }), allowLoopback);
    expect(result.error).toBeNull();
    expect(result).toMatchObject({ engine: "mysql", port, serverVersion: "8.4.3", login: "ok" });
    expect(result.tls).toMatchObject({
      offered: true,
      used: true,
      subject: expect.stringContaining("db.example.test"),
    });
    expect(result.tls.fingerprintSha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(fake.seen).toEqual({ tls: true, user: "restow_backup" });
    expect(result.mysql?.serverUuid).toBe("3e11fa47-71ca-11e1-9e33-c80aa9429562");
    expect(result.mysql?.databases.map((database) => database.name)).toEqual([
      "app",
      "information_schema",
      "mysql",
      "shop",
    ]);
    const rights = evaluateDbRights(result);
    expect(rights?.capabilities.backup.state).toBe("granted");
    expect(rights?.capabilities.verifyOnInstance.state).toBe("missing");
  });

  it("recognises MariaDB by the name in its greeting and signs in with mysql_native_password", async () => {
    const fake: FakeMysql = {
      version: "5.5.5-10.11.6-MariaDB-0+deb12u1",
      password: "s3cret-pass",
      plugin: "mysql_native_password",
      ssl: false,
      grants: ["GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost` WITH GRANT OPTION"],
      serverUuid: null,
    };
    const port = await startMysql(fake);
    const result = await probeDatabaseFromServer(spec({ port }), allowLoopback);
    expect(result).toMatchObject({
      engine: "mariadb",
      serverVersion: "10.11.6",
      login: "ok",
      error: null,
    });
    expect(result.tls).toMatchObject({ offered: false, used: false });
    expect(result.mysql).toMatchObject({
      serverUuid: null,
      serverId: 7,
      datadir: "/var/lib/mysql/",
    });
    expect(evaluateDbRights(result)?.admin).toBe(true);
  });

  it("encrypts the password with the server's RSA key when caching_sha2 asks for it without TLS", async () => {
    const fake: FakeMysql = {
      version: "8.0.40",
      password: "s3cret-pass",
      plugin: "caching_sha2_password",
      ssl: false,
      fullAuth: true,
      grants: [],
      serverUuid: "3e11fa47-71ca-11e1-9e33-c80aa9429562",
    };
    const port = await startMysql(fake);
    const result = await probeDatabaseFromServer(spec({ port }), allowLoopback);
    expect(result).toMatchObject({ engine: "mysql", login: "ok", error: null });
  });

  it("reports a refused sign-in without the password or the user in the message [DB-002]", async () => {
    const port = await startMysql({
      version: "8.4.3",
      password: "another",
      plugin: "mysql_native_password",
      ssl: false,
      grants: [],
      serverUuid: null,
    });
    const result = await probeDatabaseFromServer(spec({ port }), allowLoopback);
    expect(result).toMatchObject({ engine: "mysql", login: "failed" });
    expect(result.error?.code).toBe("db_login_failed");
    expect(result.error?.message).not.toContain("restow_backup");
    expect(result.error?.message).not.toContain("s3cret-pass");
    expect(JSON.stringify(result)).not.toContain("s3cret-pass");
  });

  it("recognises SQL Server from its PRELOGIN answer and leaves the sign-in to an agent", async () => {
    const port = await startSqlServer();
    const result = await probeDatabaseFromServer(spec({ port }), allowLoopback);
    expect(result).toMatchObject({
      engine: "sqlserver",
      port,
      serverVersion: "16.0.1000",
      login: "skipped",
      sqlserver: { version: "16.0.1000", encryption: "off" },
    });
    expect(result.error?.code).toBe("db_engine_unsupported");
  });

  it("says when a port answers as no database", async () => {
    const port = await listen((socket) => {
      socket.on("error", () => undefined);
      socket.write("SSH-2.0-OpenSSH_9.6\r\n");
    });
    const result = await probeDatabaseFromServer(spec({ port }), allowLoopback);
    expect(result.engine).toBeNull();
    expect(result.error?.code).toBe("db_not_a_database");
  });

  it("says when nothing answers", async () => {
    const port = await listen((socket) => socket.destroy());
    servers[servers.length - 1]?.close();
    const result = await probeDatabaseFromServer(spec({ port }), allowLoopback);
    expect(result.engine).toBeNull();
    expect(["db_unreachable", "db_not_a_database"]).toContain(result.error?.code);
  });
});

describe("the server executor's network protection [DB-003]", () => {
  it("refuses loopback and private addresses without an approval", async () => {
    for (const host of ["127.0.0.1", "10.0.0.5", "192.168.1.10", "db", "postgres.internal"]) {
      const result = await probeDatabaseFromServer(spec({ host }), { allowPrivateNetworks: false });
      expect(result.error?.code, host).toBe("db_private_network");
      expect(result.engine).toBeNull();
    }
  });

  it("refuses link-local, metadata and reserved addresses even with an approval", async () => {
    for (const host of ["169.254.169.254", "fe80::1", "0.0.0.0", "224.0.0.1", "fd00:ec2::254"]) {
      const result = await probeDatabaseFromServer(spec({ host, port: 5432 }), {
        allowPrivateNetworks: true,
      });
      if (host === "fd00:ec2::254") {
        // Unique local IPv6 is a private network: allowed with the approval, refused without.
        const closed = await probeDatabaseFromServer(spec({ host, port: 5432 }), {
          allowPrivateNetworks: false,
        });
        expect(closed.error?.code).toBe("db_private_network");
        continue;
      }
      expect(result.error?.code, host).toBe("db_forbidden_address");
    }
  });

  it("never signs in without TLS when the connection does not allow it", async () => {
    const port = await startMysql({
      version: "8.4.3",
      password: "s3cret-pass",
      plugin: "mysql_native_password",
      ssl: false,
      grants: [],
      serverUuid: null,
    });
    const result = await probeDatabaseFromServer(
      spec({ port, allowUnencrypted: false }),
      allowLoopback,
    );
    expect(result).toMatchObject({ engine: "mysql", login: "skipped" });
    expect(result.error?.code).toBe("db_tls_missing");
  });

  it("refuses the SQLite file and the socket sign-in, which need an agent", async () => {
    expect(
      (
        await probeDatabaseFromServer(
          spec({ host: null, path: "/var/lib/app.db", engine: "sqlite" }),
          allowLoopback,
        )
      ).error?.code,
    ).toBe("db_engine_unsupported");
    expect(
      (await probeDatabaseFromServer(spec({ authMethod: "socket", port: 1 }), allowLoopback)).error
        ?.code,
    ).toBe("db_auth_unsupported");
  });
});

describe("the health check of a stored connection (docs/DATABASES.md 8) [DB-004]", () => {
  const maria: FakeMysql = {
    version: "5.5.5-11.4.4-MariaDB",
    password: "s3cret-pass",
    plugin: "mysql_native_password",
    ssl: true,
    grants: [],
    serverUuid: null,
  };

  it("reads response time, start, connections and identity, sizes only when asked", async () => {
    const fake = { ...maria };
    const port = await startMysql(fake);
    const result = await probeDatabaseFromServer(
      spec({ port, engine: "mariadb", purpose: "health" }),
      allowLoopback,
    );
    expect(result.error).toBeNull();
    expect(result).toMatchObject({ engine: "mariadb", login: "ok", serverVersion: "11.4.4" });
    expect(result.mysql).toBeUndefined();
    expect(result.health).toMatchObject({
      connectionsUsed: 4,
      connectionsMax: 151,
      serverId: 7,
      datadir: "/var/lib/mysql/",
      databases: null,
    });
    expect(result.health?.latencyMs).toBeGreaterThanOrEqual(0);
    const started = Date.parse(result.health?.startedAt ?? "");
    expect(Math.abs(Date.now() - 3600_000 - started)).toBeLessThan(60_000);

    const sized = await probeDatabaseFromServer(
      spec({ port, engine: "mariadb", purpose: "health", sizes: true }),
      allowLoopback,
    );
    expect(sized.health?.databases).toEqual([
      { name: "app", oid: null, sizeBytes: 16384 },
      { name: "information_schema", oid: null, sizeBytes: null },
      { name: "mysql", oid: null, sizeBytes: 2048 },
      { name: "shop", oid: null, sizeBytes: null },
    ]);
  });

  it("stops before the credentials when the certificate is not the confirmed one", async () => {
    const fake = { ...maria };
    const port = await startMysql(fake);
    const other = `${"AB:".repeat(31)}AB`;
    const result = await probeDatabaseFromServer(
      spec({ port, engine: "mariadb", purpose: "health", pinnedFingerprintSha256: other }),
      allowLoopback,
    );
    expect(result.error?.code).toBe("db_tls_changed");
    expect(result.login).toBe("skipped");
    // The TLS session was opened, but no handshake response with the user ever reached it.
    expect(fake.seen).toBeUndefined();
    expect(result.tls.fingerprintSha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(result.tls.fingerprintSha256).not.toBe(other);

    const pinned = await probeDatabaseFromServer(
      spec({
        port,
        engine: "mariadb",
        purpose: "health",
        pinnedFingerprintSha256: result.tls.fingerprintSha256,
      }),
      allowLoopback,
    );
    expect(pinned).toMatchObject({ login: "ok", error: null });
  });
});

describe("long grant lines (SHOW GRANTS)", () => {
  const dynamic = Array.from({ length: 400 }, (_, index) => `X_DYNAMIC_PRIVILEGE_${index}_ADMIN`);
  const grantWith = (padding: string[]) =>
    `GRANT SELECT, RELOAD, PROCESS, LOCK TABLES, SHOW VIEW, EVENT, ${padding.join(", ")}, TRIGGER ON *.* TO \`restow_backup\`@\`%\``;

  it("reads a grant line of several KiB in full", async () => {
    const line = grantWith(dynamic);
    expect(line.length).toBeGreaterThan(8 * 1024);
    const port = await startMysql({
      version: "8.4.3",
      password: "s3cret-pass",
      plugin: "mysql_native_password",
      ssl: false,
      grants: [line],
      serverUuid: null,
    });
    const result = await probeDatabaseFromServer(spec({ port }), allowLoopback);
    expect(result.error).toBeNull();
    expect(result.mysql?.grants[0]?.length).toBe(line.length);
    expect(result.mysql?.grantsTruncated).toBeUndefined();
    expect(evaluateDbRights(result)?.capabilities.backup.state).toBe("granted");
  });

  it("says a right is unknown, not missing, when a line was still too long", async () => {
    const huge = grantWith(Array.from({ length: 6000 }, (_, index) => `X_${index}_ADMIN`));
    expect(huge.length).toBeGreaterThan(64 * 1024);
    const port = await startMysql({
      version: "8.4.3",
      password: "s3cret-pass",
      plugin: "mysql_native_password",
      ssl: false,
      grants: [huge],
      serverUuid: null,
    });
    const result = await probeDatabaseFromServer(spec({ port }), allowLoopback);
    expect(result.error).toBeNull();
    expect(result.mysql?.grantsTruncated).toBe(true);
    expect(result.mysql?.grants[0]?.length).toBe(64 * 1024);
    expect(evaluateDbRights(result)?.capabilities.backup).toMatchObject({
      state: "unknown",
      note: "grants_truncated",
    });
  });
});

describe("protocol pieces", () => {
  it("reads greetings of MySQL and MariaDB", () => {
    const mysql = parseMysqlGreeting(
      mysqlGreeting("8.0.40", { ssl: true, plugin: "caching_sha2_password" }),
    );
    expect(mysql).toMatchObject({
      serverVersion: "8.0.40",
      mariadb: false,
      authPlugin: "caching_sha2_password",
    });
    expect(mysql?.scramble.equals(SCRAMBLE)).toBe(true);
    const maria = parseMysqlGreeting(
      mysqlGreeting("11.8.2-MariaDB-ubu2404", { ssl: false, plugin: "mysql_native_password" }),
    );
    expect(maria).toMatchObject({ mariadb: true, authPlugin: "mysql_native_password" });
    expect(parseMysqlGreeting(Buffer.from("SSH-2.0-OpenSSH"))).toBeNull();
  });

  it("reads a PRELOGIN answer and refuses anything else", () => {
    const reply = Buffer.from(tdsPreloginPacket());
    reply.writeUInt8(0x04, 0);
    expect(parseTdsPreloginResponse(reply)).toMatchObject({
      version: "0.0.0",
      encryption: "not_supported",
    });
    expect(parseTdsPreloginResponse(tdsPreloginPacket())).toBeNull();
    expect(parseTdsPreloginResponse(Buffer.from("N"))).toBeNull();
  });
});
