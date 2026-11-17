import { X509Certificate } from "node:crypto";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { Duplex } from "node:stream";
import { createSecureContext, TLSSocket } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { createSelfSignedCertificate } from "../../../../../scripts/smoke/lib/selfsigned.mjs";
import type { DbProbeSpec } from "../facts.js";
import { DbConn, DbConnError, DbProbeScope } from "./conn.js";
import { checkDatabaseHealthFromServer, type DbHealthCheckTarget } from "./health-check.js";
import { DB_MAX_VALUE_BYTES, pgQuery } from "./postgres.js";
import { probeDatabaseFromServer } from "./probe.js";

/**
 * What a server may make the server executor's probe do: one deadline for the whole probe, a
 * bounded amount of data, SCRAM off the event loop and only in its order, the confirmed
 * certificate before anything of the sign-in, Restow's own database refused by its address, and
 * no socket left open when the probe is over.
 */

interface Listening {
  port: number;
  sockets: Socket[];
}

const servers: Server[] = [];
const allSockets: Socket[] = [];

afterEach(async () => {
  for (const socket of allSockets.splice(0)) {
    socket.destroy();
  }
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function listen(onConnection: (socket: Socket, index: number) => void): Promise<Listening> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    sockets.push(socket);
    allSockets.push(socket);
    onConnection(socket, sockets.length - 1);
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ port: typeof address === "object" && address ? address.port : 0, sockets });
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether every server-side socket saw the probe close its end within `ms`. */
async function allClosed(sockets: Socket[], ms = 1000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (sockets.every((socket) => socket.destroyed || socket.readableEnded)) {
      return true;
    }
    await sleep(10);
  }
  return false;
}

/** The longest the event loop was blocked while `run` ran. */
async function loopLag<T>(run: () => Promise<T>): Promise<{ value: T; maxLagMs: number }> {
  let maxLagMs = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxLagMs = Math.max(maxLagMs, now - last - 10);
    last = now;
  }, 10);
  try {
    const value = await run();
    return { value, maxLagMs };
  } finally {
    clearInterval(timer);
  }
}

function spec(overrides: Partial<DbProbeSpec> = {}): DbProbeSpec {
  return {
    probeId: "00000000-0000-4000-8000-000000000002",
    engine: "postgresql",
    host: "127.0.0.1",
    port: null,
    path: null,
    database: "postgres",
    authMethod: "password",
    user: "restow_backup",
    password: "s3cret-pass",
    allowUnencrypted: true,
    timeoutSeconds: 10,
    ...overrides,
  };
}

const loopback = { allowPrivateNetworks: true, greetingWaitMs: 100, stepTimeoutMs: 2000 };

const cert = createSelfSignedCertificate({ commonName: "pg.example.test" });
const CERT_FINGERPRINT = new X509Certificate(cert.certPem).fingerprint256.toUpperCase();
const OTHER_FINGERPRINT = Array.from({ length: 32 }, () => "AB").join(":");

// ---------------------------------------------------------------------------
// A PostgreSQL server that follows a script
// ---------------------------------------------------------------------------

type Reply = (type: string, body: Buffer) => void;

interface FakePg {
  /** The answer to the SSLRequest of the connection with this index (default "N"). */
  ssl?: (index: number) => "S" | "N";
  /** Bytes sent right after the answer "S", before the handshake. */
  afterSsl?: (index: number) => Buffer | null;
  /** The certificate of the connection with this index (default: the one of the tests). */
  certificate?: (index: number) => { certPem: string; keyPem: string };
  /** The startup message arrived. */
  startup: (reply: Reply, socket: Socket, index: number) => void;
  /** A typed message of the client arrived. */
  message?: (type: string, body: Buffer, reply: Reply, index: number) => void;
  seen: { startups: number; bytes: number };
}

function pgMessage(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.write(type, 0, "latin1");
  header.writeUInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

function auth(code: number, data: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(code);
  return Buffer.concat([head, data]);
}

function startPg(fake: FakePg): Promise<Listening> {
  return listen((raw, index) => {
    let socket: Socket = raw;
    let buffer = Buffer.alloc(0);
    let phase: "ssl" | "startup" | "messages" = "ssl";
    const reply: Reply = (type, body) => {
      if (!socket.destroyed) {
        socket.write(pgMessage(type, body));
      }
    };
    const onData = (chunk: Buffer) => {
      fake.seen.bytes += phase === "ssl" ? 0 : chunk.length;
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (phase === "ssl") {
          if (buffer.length < 8) return;
          buffer = buffer.subarray(8);
          const answer = fake.ssl?.(index) ?? "N";
          raw.write(answer);
          const extra = answer === "S" ? fake.afterSsl?.(index) : null;
          if (extra) {
            raw.write(extra);
          }
          phase = "startup";
          if (answer === "S") {
            raw.removeAllListeners("data");
            const wire = new Duplex({
              read() {},
              write(data, _encoding, callback) {
                raw.write(data, callback);
              },
            });
            if (buffer.length > 0) {
              wire.push(buffer);
              buffer = Buffer.alloc(0);
            }
            raw.on("data", (data) => wire.push(data));
            const secure = new TLSSocket(wire as unknown as Socket, {
              isServer: true,
              secureContext: createSecureContext({
                cert: (fake.certificate?.(index) ?? cert).certPem,
                key: (fake.certificate?.(index) ?? cert).keyPem,
              }),
            });
            secure.on("data", onData);
            secure.on("error", () => undefined);
            socket = secure;
            return;
          }
          continue;
        }
        if (phase === "startup") {
          if (buffer.length < 4) return;
          const length = buffer.readUInt32BE(0);
          if (buffer.length < length) return;
          buffer = buffer.subarray(length);
          fake.seen.startups += 1;
          phase = "messages";
          fake.startup(reply, raw, index);
          continue;
        }
        if (buffer.length < 5) return;
        const length = buffer.readUInt32BE(1);
        if (buffer.length < 1 + length) return;
        const type = String.fromCharCode(buffer.readUInt8(0));
        const body = buffer.subarray(5, 1 + length);
        buffer = buffer.subarray(1 + length);
        fake.message?.(type, body, reply, index);
      }
    };
    raw.on("data", onData);
  });
}

/** The client nonce of a SCRAM client-first message ("SCRAM-SHA-256\0" len "n,,n=,r=..."). */
function clientNonce(body: Buffer): string {
  return /r=([^,]+)$/.exec(body.subarray(body.indexOf(0) + 5).toString("utf8"))?.[1] ?? "";
}

function scramServerFirst(nonce: string, iterations: number): Buffer {
  const salt = Buffer.from("restow-salt-0123").toString("base64");
  return auth(11, Buffer.from(`r=${nonce}srv0123,s=${salt},i=${iterations}`));
}

/** A protocol-10 greeting of MySQL 8.4 without TLS. */
function mysqlGreetingPacket(): Buffer {
  const payload = Buffer.concat([
    Buffer.from([10]),
    Buffer.from("8.4.3\0", "latin1"),
    Buffer.from([0x2a, 0, 0, 0]),
    Buffer.from("abcdefgh", "latin1"),
    Buffer.from([0]),
    Buffer.from([0xff, 0xf7]),
    Buffer.from([45, 0x02, 0x00]),
    Buffer.from([0xbf, 0x81]),
    Buffer.from([21]),
    Buffer.alloc(10),
    Buffer.from("ijklmnopqrst\0", "latin1"),
    Buffer.from("caching_sha2_password\0", "latin1"),
  ]);
  const header = Buffer.alloc(4);
  header.writeUIntLE(payload.length, 0, 3);
  return Buffer.concat([header, payload]);
}

const SASL = auth(10, Buffer.from("SCRAM-SHA-256\0\0", "utf8"));
const READY = Buffer.from("I");

describe("SCRAM against a hostile server", () => {
  it("refuses more rounds than it computes, at once and without blocking the event loop", async () => {
    const fake: FakePg = {
      startup: (reply) => reply("R", SASL),
      message: (type, body, reply) => {
        if (type === "p") reply("R", scramServerFirst(clientNonce(body), 10_000_000));
      },
      seen: { startups: 0, bytes: 0 },
    };
    const { port, sockets } = await startPg(fake);
    const started = Date.now();
    const { value: result, maxLagMs } = await loopLag(() =>
      probeDatabaseFromServer(spec({ port }), loopback),
    );
    expect(result.error?.code).toBe("db_auth_unsupported");
    expect(result.login).not.toBe("ok");
    expect(Date.now() - started).toBeLessThan(1500);
    expect(maxLagMs).toBeLessThan(100);
    expect(await allClosed(sockets)).toBe(true);
  });

  it("counts the sign-in only after the server proved the SCRAM exchange", async () => {
    const fake: FakePg = {
      startup: (reply) => reply("R", SASL),
      message: (type, body, reply) => {
        if (type !== "p") return;
        if (body.includes(Buffer.from("SCRAM-SHA-256\0"))) {
          reply("R", scramServerFirst(clientNonce(body), 4096));
        } else {
          // Ok without the server-final message (and its proof).
          reply("R", auth(0));
          reply("Z", READY);
        }
      },
      seen: { startups: 0, bytes: 0 },
    };
    const { port } = await startPg(fake);
    const result = await probeDatabaseFromServer(spec({ port }), loopback);
    expect(result.login).not.toBe("ok");
    expect(result.error?.code).toBe("db_probe_failed");
  });

  it("takes the server-first message once and refuses it again", async () => {
    let firsts = 0;
    const fake: FakePg = {
      startup: (reply) => reply("R", SASL),
      message: (type, body, reply) => {
        if (type !== "p") return;
        firsts += 1;
        // Every answer is another server-first message.
        reply("R", scramServerFirst(firsts === 1 ? clientNonce(body) : "x", 4096));
      },
      seen: { startups: 0, bytes: 0 },
    };
    const { port } = await startPg(fake);
    const started = Date.now();
    const result = await probeDatabaseFromServer(spec({ port }), loopback);
    expect(result.error?.code).toBe("db_probe_failed");
    expect(firsts).toBe(2);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("one deadline and bounded data for the whole probe", () => {
  it("ends at the probe's deadline when the server trickles notices", async () => {
    const fake: FakePg = {
      startup: (reply, socket) => {
        reply("R", auth(0));
        const timer = setInterval(() => {
          if (socket.destroyed) {
            clearInterval(timer);
            return;
          }
          reply("N", Buffer.from("SNOTICE\0Mstill here\0\0"));
        }, 50);
        socket.on("close", () => clearInterval(timer));
      },
      seen: { startups: 0, bytes: 0 },
    };
    const { port, sockets } = await startPg(fake);
    const started = Date.now();
    const result = await probeDatabaseFromServer(spec({ port, timeoutSeconds: 1 }), loopback);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.error?.code).toBe("db_unreachable");
    expect(result.error?.message).toMatch(/did not finish in time/);
    expect(await allClosed(sockets)).toBe(true);
  });

  it("cuts off a flood of notices", async () => {
    const notice = pgMessage("N", Buffer.from("SNOTICE\0Mflood\0\0"));
    const fake: FakePg = {
      startup: (_reply, socket) => {
        socket.write(Buffer.concat([pgMessage("R", auth(0)), ...Array(5000).fill(notice)]));
      },
      seen: { startups: 0, bytes: 0 },
    };
    const { port, sockets } = await startPg(fake);
    const started = Date.now();
    const result = await probeDatabaseFromServer(spec({ port }), loopback);
    expect(result.error?.code).toBe("db_probe_failed");
    expect(Date.now() - started).toBeLessThan(1500);
    expect(await allClosed(sockets)).toBe(true);
  });

  it("refuses a message larger than the probe reads without waiting for it", async () => {
    const fake: FakePg = {
      startup: (_reply, socket) => {
        const header = Buffer.alloc(5);
        header.write("R", 0, "latin1");
        header.writeUInt32BE(64 * 1024 * 1024, 1);
        socket.write(header);
      },
      seen: { startups: 0, bytes: 0 },
    };
    const { port } = await startPg(fake);
    const started = Date.now();
    const result = await probeDatabaseFromServer(spec({ port }), loopback);
    expect(result.error?.code).toBe("db_probe_failed");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("keeps a bounded amount of unread data per connection", async () => {
    const { port } = await listen((socket) => {
      socket.write(Buffer.alloc(3 * 1024 * 1024, 0x41));
    });
    const conn = await DbConn.open({
      host: "127.0.0.1",
      port,
      timeoutMs: 2000,
      maxBufferedBytes: 256 * 1024,
    });
    try {
      await sleep(200);
      const failure = await conn.read(16).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DbConnError);
      expect((failure as DbConnError).kind).toBe("limit");
      await expect(conn.read(512 * 1024)).rejects.toMatchObject({ kind: "limit" });
    } finally {
      conn.close();
    }
  });

  it("closes the fresh MySQL connection when its greeting is not one", async () => {
    const { port, sockets } = await listen((socket, index) => {
      if (index === 0) {
        socket.write(mysqlGreetingPacket());
      } else {
        // An empty packet instead of the greeting; the server keeps the connection open.
        socket.write(Buffer.from([0, 0, 0, 0]));
      }
    });
    const result = await probeDatabaseFromServer(
      spec({ port, engine: null, allowUnencrypted: true }),
      loopback,
    );
    expect(result.error?.code).toBe("db_probe_failed");
    expect(sockets.length).toBe(2);
    expect(await allClosed(sockets)).toBe(true);
  });
});

describe("the confirmed certificate before the sign-in [DB-003]", () => {
  it("stops right after the TLS handshake when PostgreSQL shows another certificate", async () => {
    const fake: FakePg = {
      ssl: () => "S",
      startup: (reply) => reply("R", auth(3)),
      seen: { startups: 0, bytes: 0 },
    };
    const { port, sockets } = await startPg(fake);
    const result = await probeDatabaseFromServer(
      spec({ port, pinnedFingerprintSha256: OTHER_FINGERPRINT }),
      loopback,
    );
    expect(result.error?.code).toBe("db_tls_changed");
    expect(result.tls).toMatchObject({ used: true, fingerprintSha256: CERT_FINGERPRINT });
    expect(fake.seen.startups).toBe(0);
    expect(await allClosed(sockets)).toBe(true);
  });

  it("signs in when PostgreSQL shows the confirmed certificate", async () => {
    const fake: FakePg = {
      ssl: () => "S",
      startup: (reply) => reply("R", auth(3)),
      message: (type, _body, reply) => {
        if (type === "p") {
          reply("E", Buffer.from("SFATAL\0C28P01\0Mpassword authentication failed\0\0"));
        }
      },
      seen: { startups: 0, bytes: 0 },
    };
    const { port } = await startPg(fake);
    const result = await probeDatabaseFromServer(
      spec({ port, pinnedFingerprintSha256: CERT_FINGERPRINT }),
      loopback,
    );
    expect(fake.seen.startups).toBe(1);
    expect(result.error?.code).toBe("db_login_failed");
  });

  it("stops before the sign-in when a server with a confirmed certificate offers no TLS", async () => {
    const fake: FakePg = {
      ssl: () => "N",
      startup: (reply) => reply("R", auth(3)),
      seen: { startups: 0, bytes: 0 },
    };
    const { port } = await startPg(fake);
    const result = await probeDatabaseFromServer(
      spec({ port, pinnedFingerprintSha256: CERT_FINGERPRINT, allowUnencrypted: true }),
      loopback,
    );
    expect(result.error?.code).toBe("db_tls_missing");
    expect(fake.seen.startups).toBe(0);
  });

  it("gives a reopened connection the same checks as the first one", async () => {
    // The first database does not exist; the second connection reaches a public address
    // (as a name that resolves elsewhere would) and offers no TLS: no sign-in there.
    const fake: FakePg = {
      startup: (reply, _socket, index) => {
        if (index === 0) {
          reply("E", Buffer.from('SFATAL\0C3D000\0Mdatabase "app" does not exist\0\0'));
        } else {
          reply("R", auth(3));
        }
      },
      seen: { startups: 0, bytes: 0 },
    };
    const { port, sockets } = await startPg(fake);
    let opened = 0;
    const connect = (host: string, at: number) => {
      const socket = netConnect({ host, port: at });
      const index = opened++;
      Object.defineProperty(socket, "remoteAddress", {
        get: () => (index === 0 ? "127.0.0.1" : "93.184.216.34"),
      });
      return socket;
    };
    const result = await probeDatabaseFromServer(spec({ port, database: "app" }), {
      ...loopback,
      connect,
    });
    expect(result.error?.code).toBe("db_tls_missing");
    expect(fake.seen.startups).toBe(1);
    expect(await allClosed(sockets)).toBe(true);
  });
});

describe("addresses the server executor never signs in to [DB-003]", () => {
  it("refuses Restow's own database by its address before sending anything", async () => {
    let received = 0;
    const { port, sockets } = await listen((socket) => {
      socket.on("data", (chunk) => {
        received += chunk.length;
      });
    });
    const result = await probeDatabaseFromServer(spec({ port }), {
      ...loopback,
      forbiddenTargets: [{ address: "::ffff:127.0.0.1", port }],
    });
    expect(result.error?.code).toBe("db_target_is_restow");
    await sleep(50);
    expect(received).toBe(0);
    expect(await allClosed(sockets)).toBe(true);
  });

  it("reaches only the private addresses an approval names", async () => {
    const { port } = await startPg({
      startup: (reply) => {
        reply("R", auth(0));
        reply("E", Buffer.from("SFATAL\0C28000\0Mno pg_hba.conf entry\0\0"));
      },
      seen: { startups: 0, bytes: 0 },
    });
    const approved = (addresses: string[], host = "127.0.0.1") =>
      probeDatabaseFromServer(spec({ port, host }), {
        allowPrivateNetworks: false,
        approvedAddresses: addresses,
        stepTimeoutMs: 2000,
      });
    expect((await approved(["127.0.0.2"])).error?.code).toBe("db_private_network");
    expect((await approved([])).error?.code).toBe("db_private_network");
    // A name that resolves to another loopback or private address than the approved one.
    expect((await approved(["10.0.0.9"], "localhost")).error?.code).toBe("db_private_network");
    expect((await approved(["127.0.0.1"])).error?.code).toBe("db_login_failed");
  });
});

/** A PostgreSQL that lets anyone in and answers every query with `rows` (one column each). */
function openPg(rows: (index: number) => Buffer[]): FakePg {
  return {
    startup: (reply) => {
      reply("R", auth(0));
      reply("Z", READY);
    },
    message: (type, _body, reply, index) => {
      if (type !== "Q") return;
      for (const value of rows(index)) {
        const row = Buffer.alloc(6);
        row.writeUInt16BE(1, 0);
        row.writeInt32BE(value.length, 2);
        reply("D", Buffer.concat([row, value]));
      }
      reply("C", Buffer.from("SELECT\0"));
      reply("Z", READY);
    },
    seen: { startups: 0, bytes: 0 },
  };
}

describe("a read budget for the whole probe", () => {
  it("stops a server that answers with more data than the probe reads in all", async () => {
    // Twenty rows just under the message limit: each message is allowed, together they are not.
    const big = Buffer.alloc(900 * 1024, 0x61);
    const { port, sockets } = await startPg(openPg(() => Array(20).fill(big)));
    const result = await probeDatabaseFromServer(spec({ port }), loopback);
    expect(result.error?.code).toBe("db_probe_failed");
    expect(result.postgresql).toBeUndefined();
    expect(await allClosed(sockets)).toBe(true);
  });

  it("keeps only the beginning of a long value while it reads the row", async () => {
    const { port } = await startPg(openPg(() => [Buffer.alloc(500 * 1024, 0x62)]));
    const scope = new DbProbeScope(Date.now() + 5000);
    const conn = await DbConn.open({ host: "127.0.0.1", port, timeoutMs: 2000, scope });
    try {
      conn.write(Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]));
      await conn.read(1);
      const { pgSignIn } = await import("./postgres.js");
      const session = await pgSignIn(conn, "restow_backup", null, "postgres");
      const rows = await pgQuery(session, "SELECT version()");
      expect(rows[0]?.[0]?.length).toBe(DB_MAX_VALUE_BYTES);
    } finally {
      scope.close();
    }
  });

  it("reports the address it signed in on", async () => {
    const { port } = await startPg(openPg(() => []));
    const result = await probeDatabaseFromServer(spec({ port }), loopback);
    expect(result).toMatchObject({ login: "ok", error: null, connectedAddress: "127.0.0.1" });
  });
});

describe("TLS of a further connection", () => {
  it("refuses bytes the server sends before the TLS handshake", async () => {
    const fake: FakePg = {
      ssl: () => "S",
      afterSsl: (index) => (index === 1 ? pgMessage("R", auth(0)) : null),
      startup: (reply, _socket, index) => {
        if (index === 0)
          reply("E", Buffer.from('SFATAL\0C3D000\0Mdatabase "app" does not exist\0\0'));
        else reply("R", auth(3));
      },
      seen: { startups: 0, bytes: 0 },
    };
    const { port } = await startPg(fake);
    const result = await probeDatabaseFromServer(spec({ port, database: "app" }), loopback);
    expect(result.error?.code).toBe("db_probe_failed");
    expect(fake.seen.startups).toBe(1);
  });

  it("refuses another certificate on the second connection without a confirmed one", async () => {
    const other = createSelfSignedCertificate({ commonName: "other.example.test" });
    const fake: FakePg = {
      ssl: () => "S",
      certificate: (index) => (index === 0 ? cert : other),
      startup: (reply, _socket, index) => {
        if (index === 0)
          reply("E", Buffer.from('SFATAL\0C3D000\0Mdatabase "app" does not exist\0\0'));
        else reply("R", auth(3));
      },
      seen: { startups: 0, bytes: 0 },
    };
    const { port } = await startPg(fake);
    const result = await probeDatabaseFromServer(spec({ port, database: "app" }), loopback);
    expect(result.error?.code).toBe("db_tls_changed");
    expect(fake.seen.startups).toBe(1);
  });
});

describe("Restow's own database on loopback [DB-003]", () => {
  it("counts every loopback address as the same server", async () => {
    for (const address of ["127.0.0.53", "::1"]) {
      let received = 0;
      const { port } = await listen((socket) => {
        socket.on("data", (chunk) => {
          received += chunk.length;
        });
      });
      const result = await probeDatabaseFromServer(spec({ port }), {
        ...loopback,
        forbiddenTargets: [{ address, port }],
      });
      expect(result.error?.code, address).toBe("db_target_is_restow");
      await sleep(30);
      expect(received, address).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The health check of a stored connection (D2): the same scope, nothing around it
// ---------------------------------------------------------------------------

function healthTarget(port: number, over: Partial<DbHealthCheckTarget> = {}): DbHealthCheckTarget {
  return {
    engine: "postgresql",
    host: "127.0.0.1",
    port,
    database: "postgres",
    user: "restow_backup",
    password: "s3cret-pass",
    allowUnencrypted: true,
    pinnedFingerprintSha256: null,
    sizes: true,
    ...over,
  };
}

const healthOptions = {
  allowPrivateNetworks: false,
  approvedAddresses: ["127.0.0.1"],
  forbiddenTargets: [] as { address: string; port: number }[],
  stepTimeoutMs: 2000,
};

describe("the health check runs inside the probe's scope [DB-004]", () => {
  it("ends at its deadline with every socket closed when the server trickles notices", async () => {
    let timer: NodeJS.Timeout | undefined;
    const { port, sockets } = await startPg({
      startup: (reply) => {
        reply("R", auth(0));
        timer = setInterval(() => reply("N", Buffer.from("SNOTICE\0Mstill here\0\0")), 50);
      },
      seen: { startups: 0, bytes: 0 },
    });
    try {
      const started = Date.now();
      const result = await checkDatabaseHealthFromServer(healthTarget(port), {
        ...healthOptions,
        timeoutSeconds: 1,
      });
      expect(Date.now() - started).toBeLessThan(2500);
      expect(result.error?.code).toMatch(/^db_(unreachable|probe_failed)$/);
      expect(result.health).toBeUndefined();
      expect(await allClosed(sockets)).toBe(true);
    } finally {
      clearInterval(timer);
    }
  });

  it("keeps the read budget and the value cut while it reads the sizes", async () => {
    const big = Buffer.alloc(900 * 1024, 0x61);
    const flood = await startPg(openPg(() => Array(20).fill(big)));
    const flooded = await checkDatabaseHealthFromServer(healthTarget(flood.port), healthOptions);
    expect(flooded.error?.code).toBe("db_probe_failed");
    expect(flooded.health).toBeUndefined();
    expect(await allClosed(flood.sockets)).toBe(true);

    const long = await startPg(openPg(() => [Buffer.alloc(300 * 1024, 0x62)]));
    const cut = await checkDatabaseHealthFromServer(healthTarget(long.port), healthOptions);
    expect(cut).toMatchObject({ login: "ok", error: null });
    // Every value was cut to DB_MAX_VALUE_BYTES while reading; a name to its 128 characters.
    expect(cut.health?.databases?.every((database) => database.name.length <= 128)).toBe(true);
    expect(cut.serverVersion?.length ?? 0).toBeLessThanOrEqual(DB_MAX_VALUE_BYTES);
  });

  it("reaches only the approved addresses, never with an approval without addresses", async () => {
    const { port } = await startPg(openPg(() => []));
    const check = (approvedAddresses: string[]) =>
      checkDatabaseHealthFromServer(healthTarget(port, { sizes: false }), {
        ...healthOptions,
        approvedAddresses,
      });
    expect((await check([])).error?.code).toBe("db_private_network");
    expect((await check(["127.0.0.2"])).error?.code).toBe("db_private_network");
    expect(await check(["127.0.0.1"])).toMatchObject({ login: "ok", error: null });
  });

  it("refuses Restow's own database and another certificate before anything of the sign-in", async () => {
    const own = await startPg(openPg(() => []));
    const refused = await checkDatabaseHealthFromServer(healthTarget(own.port), {
      ...healthOptions,
      forbiddenTargets: [{ address: "127.0.0.1", port: own.port }],
    });
    expect(refused.error?.code).toBe("db_target_is_restow");
    const fake: FakePg = { ...openPg(() => []), ssl: () => "S" };
    const tls = await startPg(fake);
    const pinned = await checkDatabaseHealthFromServer(
      healthTarget(tls.port, { pinnedFingerprintSha256: OTHER_FINGERPRINT }),
      healthOptions,
    );
    expect(pinned.error?.code).toBe("db_tls_changed");
    expect(fake.seen.startups).toBe(0);
    const good = await checkDatabaseHealthFromServer(
      healthTarget(tls.port, { pinnedFingerprintSha256: CERT_FINGERPRINT }),
      healthOptions,
    );
    expect(good).toMatchObject({ login: "ok", error: null });
    expect(fake.seen.startups).toBe(1);
  });
});
