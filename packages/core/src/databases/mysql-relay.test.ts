import { execFileSync } from "node:child_process";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MYSQL_RELAY_SOCKET, openMysqlRelay } from "./relay.js";

/**
 * The relay of MySQL and MariaDB (docs/DATABASES.md 16 "D4" M1) against a fake server: the
 * program gets the original greeting without TLS and compression, the sequence numbers and the
 * TLS flag of the login are set for the server, then the bytes pass; without TLS upstream the
 * relay does the RSA step of caching_sha2_password itself and the readable password never
 * reaches the server; a sign-in method that would send it readable ends the relay; refused
 * before connecting or before the login when the address is not allowed, is Restow's own
 * database, or shows another certificate; one client only. A real server: relay.mysql test.
 */

const CLIENT_COMPRESS = 0x20;
const CLIENT_SSL = 0x800;
const CAPS_LOW = 0x0001 | 0x0004 | 0x0200 | 0x2000 | 0x8000; // long pw, long flag, 41, trans, secure
const CAPS_HIGH = (0x80000 | 0x200000) >>> 16; // plugin auth, lenenc client data
const SCRAMBLE = Buffer.from("abcdefghijklmnopqrst", "latin1");

let certDir = "";
let key = "";
let cert = "";
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();

beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), "mysql-relay-cert-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=fake-mysql",
      "-keyout",
      join(certDir, "k.pem"),
      "-out",
      join(certDir, "c.pem"),
    ],
    { stdio: "ignore" },
  );
  key = readFileSync(join(certDir, "k.pem"), "utf8");
  cert = readFileSync(join(certDir, "c.pem"), "utf8");
});

afterAll(() => {
  rmSync(certDir, { recursive: true, force: true });
});

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

function packet(sequence: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUIntLE(payload.length, 0, 3);
  head.writeUInt8(sequence, 3);
  return Buffer.concat([head, payload]);
}

/** Reads packets from a socket, one promise each. */
function reader(socket: Socket) {
  let pending = Buffer.alloc(0);
  const waiting: ((p: { seq: number; payload: Buffer }) => void)[] = [];
  const queue: { seq: number; payload: Buffer }[] = [];
  const drain = () => {
    while (pending.length >= 4) {
      const length = pending.readUIntLE(0, 3);
      if (pending.length < 4 + length) return;
      const item = { seq: pending.readUInt8(3), payload: pending.subarray(4, 4 + length) };
      pending = pending.subarray(4 + length);
      const next = waiting.shift();
      if (next) next(item);
      else queue.push(item);
    }
  };
  const attach = (s: Socket) =>
    s.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      drain();
    });
  attach(socket);
  return {
    next: () =>
      new Promise<{ seq: number; payload: Buffer }>((resolve) => {
        const item = queue.shift();
        if (item) resolve(item);
        else waiting.push(resolve);
      }),
    attach,
  };
}

function greeting(options: { tls: boolean; mariadb: boolean; plugin: string }): Buffer {
  const version = options.mariadb ? "5.5.5-11.8.2-MariaDB" : "8.4.3";
  const low = CAPS_LOW | CLIENT_COMPRESS | (options.tls ? CLIENT_SSL : 0);
  const head = Buffer.alloc(4 + 8 + 1 + 2 + 1 + 2 + 2 + 1 + 10);
  let o = 0;
  head.writeUInt32LE(7, o);
  o += 4;
  SCRAMBLE.copy(head, o, 0, 8);
  o += 8 + 1;
  head.writeUInt16LE(low, o);
  o += 2;
  head.writeUInt8(45, o);
  o += 1 + 2;
  head.writeUInt16LE(CAPS_HIGH, o);
  o += 2;
  head.writeUInt8(21, o);
  return Buffer.concat([
    Buffer.from([10]),
    Buffer.from(`${version}\0`, "latin1"),
    head,
    SCRAMBLE.subarray(8),
    Buffer.from([0]),
    Buffer.from(`${options.plugin}\0`, "latin1"),
  ]);
}

interface Fake {
  port: number;
  connections: number;
  received: Buffer[];
  login: { seq: number; caps: number } | null;
  done: Promise<void>;
}

/** A MySQL server with one sign-in `scenario`. */
function fakeMysql(options: {
  tls?: boolean;
  mariadb?: boolean;
  plugin?: string;
  scenario: "ok" | "rsa" | "clear_switch";
}): Promise<Fake> {
  let finished: () => void = () => undefined;
  const fake: Fake = {
    port: 0,
    connections: 0,
    received: [],
    login: null,
    done: new Promise((resolve) => {
      finished = resolve;
    }),
  };
  const plugin = options.plugin ?? "mysql_native_password";
  const server = createServer(async (raw: Socket) => {
    fake.connections++;
    raw.on("error", () => undefined);
    let socket: Socket = raw;
    raw.write(
      packet(0, greeting({ tls: options.tls === true, mariadb: options.mariadb === true, plugin })),
    );
    if (options.tls) {
      // The SSLRequest (36 bytes), then TLS on the same socket; bytes after it go back.
      const request = await new Promise<Buffer>((resolve) => {
        let got = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
          got = Buffer.concat([got, chunk]);
          if (got.length >= 36) {
            raw.off("data", onData);
            raw.pause();
            if (got.length > 36) raw.unshift(got.subarray(36));
            resolve(got.subarray(0, 36));
          }
        };
        raw.on("data", onData);
      });
      fake.received.push(request);
      const secure = new TLSSocket(raw, { isServer: true, key, cert });
      secure.on("error", () => undefined);
      socket = secure;
    }
    socket.on("data", (chunk: Buffer) => fake.received.push(Buffer.from(chunk)));
    const packets = reader(socket);
    try {
      const first = await packets.next();
      fake.login = { seq: first.seq, caps: first.payload.readUInt32LE(0) };
      let seq = first.seq;
      if (options.scenario === "ok") {
        socket.write(packet(++seq, Buffer.from([0, 0, 0, 2, 0, 0, 0])));
      } else if (options.scenario === "rsa") {
        socket.write(packet(++seq, Buffer.from([0x01, 0x04])));
        const ask = await packets.next();
        expect(ask.payload).toEqual(Buffer.from([0x02]));
        seq = ask.seq;
        socket.write(packet(++seq, Buffer.concat([Buffer.from([0x01]), Buffer.from(PEM)])));
        const sealed = await packets.next();
        seq = sealed.seq;
        const plain = privateDecrypt(
          { key: rsa.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
          sealed.payload,
        );
        const password = Buffer.alloc(plain.length);
        for (let i = 0; i < plain.length; i++) {
          password[i] = (plain[i] as number) ^ (SCRAMBLE[i % SCRAMBLE.length] as number);
        }
        socket.write(
          packet(
            ++seq,
            password.toString("latin1") === "s3cret-pw\0"
              ? Buffer.from([0, 0, 0, 2, 0, 0, 0])
              : Buffer.concat([Buffer.from([0xff, 0x15, 0x04]), Buffer.from("#28000denied")]),
          ),
        );
      } else {
        socket.write(packet(++seq, Buffer.from("\xfemysql_clear_password\0", "latin1")));
      }
      // After the sign-in, a COM_PING passes as it is.
      const ping = await packets.next();
      expect(ping).toEqual({ seq: 0, payload: Buffer.from([0x0e]) });
      socket.write(packet(1, Buffer.from([0, 0, 0, 2, 0, 0, 0])));
    } catch {
      // The relay ended the connection.
    } finally {
      finished();
    }
  });
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      fake.port = typeof address === "object" && address ? address.port : 0;
      resolve(fake);
    }),
  );
}

const loopback = { allowPrivateNetworks: true, approvedAddresses: [], forbiddenTargets: [] };
const target = (port: number, over: Record<string, unknown> = {}) => ({
  host: "127.0.0.1",
  port,
  allowUnencrypted: true,
  pinnedFingerprintSha256: null,
  ...over,
});

/** The program's side: a native login over the relay's socket. */
async function program(path: string, options: { plugin?: string; password?: string } = {}) {
  const socket = connect(path);
  socket.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  const packets = reader(socket);
  const hello = await packets.next();
  const caps = hello.payload.readUInt16LE(hello.payload.indexOf(0, 1) + 1 + 4 + 8 + 1);
  const plugin = options.plugin ?? "mysql_native_password";
  const fixed = Buffer.alloc(32);
  fixed.writeUInt32LE((CAPS_LOW | (CAPS_HIGH << 16) | CLIENT_COMPRESS) >>> 0, 0);
  fixed.writeUInt32LE(1 << 24, 4);
  fixed.writeUInt8(45, 8);
  const auth = Buffer.alloc(20, 7);
  socket.write(
    packet(
      1,
      Buffer.concat([
        fixed,
        Buffer.from("backup\0"),
        Buffer.from([auth.length]),
        auth,
        Buffer.from(`${plugin}\0`, "latin1"),
      ]),
    ),
  );
  return { socket, packets, hello, caps };
}

describe("the MySQL relay [DB-003]", () => {
  it("hands the greeting on without TLS and compression and passes a TLS sign-in", async () => {
    const fake = await fakeMysql({ tls: true, scenario: "ok" });
    const opened = await openMysqlRelay({
      target: target(fake.port, { allowUnencrypted: false }),
      engine: "mysql",
      network: loopback,
      maxDurationMs: 30_000,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.relay.tls.used).toBe(true);
    expect(opened.relay.socketPath).toBe(join(opened.relay.socketDir, MYSQL_RELAY_SOCKET));
    const { socket, packets, hello, caps } = await program(opened.relay.socketPath);
    expect(hello.seq).toBe(0);
    expect(caps & (CLIENT_SSL | CLIENT_COMPRESS)).toBe(0);
    // The relay sent the SSLRequest (sequence 1): the login is the server's sequence 2, with TLS.
    const ok = await packets.next();
    expect(ok).toEqual({ seq: 2, payload: Buffer.from([0, 0, 0, 2, 0, 0, 0]) });
    expect(fake.login?.seq).toBe(2);
    expect((fake.login?.caps ?? 0) & CLIENT_SSL).toBe(CLIENT_SSL);
    expect((fake.login?.caps ?? 0) & CLIENT_COMPRESS).toBe(0);
    socket.write(packet(0, Buffer.from([0x0e])));
    expect(await packets.next()).toEqual({ seq: 1, payload: Buffer.from([0, 0, 0, 2, 0, 0, 0]) });
    // One client only; the socket is gone.
    expect(existsSync(opened.relay.socketPath)).toBe(false);
    socket.end();
    expect((await opened.relay.ended).reason).toBe("client_closed");
    await fake.done;
  });

  it("does the RSA step itself without TLS: the readable password never reaches the server", async () => {
    const fake = await fakeMysql({ scenario: "rsa", plugin: "caching_sha2_password" });
    const opened = await openMysqlRelay({
      target: target(fake.port),
      engine: "mysql",
      network: loopback,
      maxDurationMs: 30_000,
    });
    if (!opened.ok) throw new Error(opened.message);
    const { socket, packets } = await program(opened.relay.socketPath, {
      plugin: "caching_sha2_password",
    });
    const more = await packets.next();
    expect(more.payload).toEqual(Buffer.from([0x01, 0x04]));
    // The program sends its password as on any secure transport (the local socket).
    socket.write(packet(more.seq + 1, Buffer.from("s3cret-pw\0")));
    const ok = await packets.next();
    expect(ok).toEqual({ seq: more.seq + 2, payload: Buffer.from([0, 0, 0, 2, 0, 0, 0]) });
    socket.write(packet(0, Buffer.from([0x0e])));
    await packets.next();
    expect(Buffer.concat(fake.received).includes(Buffer.from("s3cret-pw"))).toBe(false);
    socket.end();
    await opened.relay.ended;
  });

  it("ends before a readable sign-in without TLS (db_auth_unsupported)", async () => {
    const fake = await fakeMysql({ scenario: "clear_switch" });
    const opened = await openMysqlRelay({
      target: target(fake.port),
      engine: "mysql",
      network: loopback,
      maxDurationMs: 30_000,
    });
    if (!opened.ok) throw new Error(opened.message);
    const { packets } = await program(opened.relay.socketPath);
    const ended = await opened.relay.ended;
    expect(ended.failure?.code).toBe("db_auth_unsupported");
    // The program never saw the switch to the clear-text method.
    const seen = await Promise.race([
      packets.next().then(() => "packet"),
      new Promise((resolve) => setTimeout(() => resolve("none"), 100)),
    ]);
    expect(seen).toBe("none");
    // A program that names a readable method itself is refused as well.
    const fake2 = await fakeMysql({ scenario: "ok" });
    const second = await openMysqlRelay({
      target: target(fake2.port),
      engine: "mysql",
      network: loopback,
      maxDurationMs: 30_000,
    });
    if (!second.ok) throw new Error(second.message);
    await program(second.relay.socketPath, { plugin: "mysql_clear_password" });
    expect((await second.relay.ended).failure?.code).toBe("db_auth_unsupported");
    expect(fake2.login).toBeNull();
  });

  it("refuses another certificate, another engine, an unapproved address and Restow's own database", async () => {
    const fake = await fakeMysql({ tls: true, scenario: "ok" });
    const first = await openMysqlRelay({
      target: target(fake.port, { allowUnencrypted: false }),
      engine: "mysql",
      network: loopback,
      maxDurationMs: 30_000,
    });
    if (!first.ok) throw new Error(first.message);
    first.relay.close();
    await first.relay.ended;
    const other = (first.relay.tls.fingerprintSha256 ?? "").replace(/^../, "00");
    const pinned = await fakeMysql({ tls: true, scenario: "ok" });
    expect(
      await openMysqlRelay({
        target: target(pinned.port, { allowUnencrypted: false, pinnedFingerprintSha256: other }),
        engine: "mysql",
        network: loopback,
        maxDurationMs: 30_000,
      }),
    ).toMatchObject({ ok: false, code: "db_tls_changed" });
    // Nothing of a login reached the server with the other certificate.
    expect(pinned.login).toBeNull();
    const maria = await fakeMysql({ mariadb: true, scenario: "ok" });
    expect(
      await openMysqlRelay({
        target: target(maria.port),
        engine: "mysql",
        network: loopback,
        maxDurationMs: 30_000,
      }),
    ).toMatchObject({ ok: false, code: "db_engine_changed" });
    const plain = await fakeMysql({ scenario: "ok" });
    expect(
      await openMysqlRelay({
        target: target(plain.port),
        engine: "mysql",
        network: { allowPrivateNetworks: false, approvedAddresses: [], forbiddenTargets: [] },
        maxDurationMs: 30_000,
      }),
    ).toMatchObject({ ok: false, code: "db_private_network" });
    expect(plain.connections).toBe(0);
    expect(
      await openMysqlRelay({
        target: target(plain.port),
        engine: "mysql",
        network: { ...loopback, forbiddenTargets: [{ address: "127.0.0.1", port: plain.port }] },
        maxDurationMs: 30_000,
      }),
    ).toMatchObject({ ok: false, code: "db_target_is_restow" });
    expect(
      await openMysqlRelay({
        target: target(plain.port, { allowUnencrypted: false }),
        engine: "mysql",
        network: loopback,
        maxDurationMs: 30_000,
      }),
    ).toMatchObject({ ok: false, code: "db_tls_missing" });
  });

  it("takes one client and refuses TLS asked for on its local socket", async () => {
    const fake = await fakeMysql({ scenario: "ok" });
    const opened = await openMysqlRelay({
      target: target(fake.port),
      engine: "mysql",
      network: loopback,
      maxDurationMs: 30_000,
    });
    if (!opened.ok) throw new Error(opened.message);
    const socket = connect(opened.relay.socketPath);
    socket.on("error", () => undefined);
    const packets = reader(socket);
    await packets.next();
    await expect(
      new Promise((resolve, reject) => {
        const second = connect(opened.relay.socketPath);
        second.once("connect", () => resolve("connected"));
        second.once("error", reject);
      }),
    ).rejects.toThrow();
    // An SSLRequest (32 bytes) on the local socket ends the relay; the server learns nothing.
    socket.write(packet(1, Buffer.alloc(32)));
    expect((await opened.relay.ended).failure?.code).toBe("db_probe_failed");
    expect(fake.login).toBeNull();
    expect(fake.connections).toBe(1);
  });
});
