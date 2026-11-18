import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  choosePgTools,
  countPgListEntries,
  pgDumpArgs,
  pgDumpallGlobalsArgs,
  pgRestoreArgs,
  pgToolEnv,
  pgToolMajor,
} from "./pg-tools.js";
import { pgStartupMessage } from "./probe/postgres.js";
import {
  openPgRelay,
  PgSignInFilter,
  pgConninfoValue,
  pgPassFileLine,
  pgQuoteLiteral,
  privateTempDir,
  sweepStaleTempDirs,
  writePgPassFile,
} from "./relay.js";

/**
 * The pinning relay (docs/DATABASES.md 16 "D3" O1) against a fake PostgreSQL that answers the
 * SSLRequest with `N` and echoes what follows: one client only, bounded, closed from either side,
 * its socket and directory gone afterwards; refused before connecting or before anything is
 * relayed when the address is not allowed or is Restow's own database. The certificate check
 * against a real server is in relay.pg.test.ts.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

interface FakePg {
  port: number;
  connections: number;
  received: number;
}

function fakePg(): Promise<FakePg> {
  const fake: FakePg = { port: 0, connections: 0, received: 0 };
  const server = createServer((socket: Socket) => {
    fake.connections++;
    socket.on("error", () => undefined);
    let stage = 0;
    socket.on("data", (chunk: Buffer) => {
      fake.received += chunk.length;
      if (stage === 0) {
        // The SSLRequest (8 bytes): no TLS.
        stage = 1;
        socket.write("N");
        return;
      }
      if (stage === 1) {
        // The startup message: signed in (AuthenticationOk), then everything is echoed.
        stage = 2;
        socket.write(AUTH_OK);
        return;
      }
      socket.write(chunk);
    });
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

const plainTarget = (port: number) => ({
  host: "127.0.0.1",
  port,
  allowUnencrypted: true,
  pinnedFingerprintSha256: null,
});
const loopback = { allowPrivateNetworks: true, approvedAddresses: [], forbiddenTargets: [] };

const AUTH_OK = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);

/** Connect to the relay's socket and sign in to the fake (a startup, AuthenticationOk back). */
function dial(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.once("data", () => resolve(socket));
      socket.write("start");
    });
    socket.once("error", reject);
  });
}

function roundTrip(socket: Socket, text: string): Promise<string> {
  return new Promise((resolve) => {
    socket.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
    socket.write(text);
  });
}

describe("the pinning relay [DB-003]", () => {
  it("relays one client, refuses a second and removes its socket and directory", async () => {
    const fake = await fakePg();
    const opened = await openPgRelay({
      target: plainTarget(fake.port),
      network: loopback,
      maxDurationMs: 30_000,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const { relay } = opened;
    const path = join(relay.socketDir, `.s.PGSQL.${relay.port}`);
    expect(statSync(relay.socketDir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const client = await dial(path);
    expect(await roundTrip(client, "hello")).toBe("hello");
    // The socket is gone the moment the first client is in: no one else reaches the server.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(path)).toBe(false);
    await expect(dial(path)).rejects.toThrow();
    expect(fake.connections).toBe(1);
    client.end();
    const end = await relay.ended;
    expect(end.reason).toBe("client_closed");
    expect(end.bytesToServer).toBe(10);
    expect(existsSync(relay.socketDir)).toBe(false);
  });

  it("ends when the server closes, when idle, at its deadline and without a client", async () => {
    const fake = await fakePg();
    const idle = await openPgRelay({
      target: plainTarget(fake.port),
      network: loopback,
      maxDurationMs: 30_000,
      idleTimeoutMs: 100,
    });
    if (!idle.ok) throw new Error(idle.message);
    const client = await dial(join(idle.relay.socketDir, ".s.PGSQL.5432"));
    client.on("error", () => undefined);
    expect((await idle.relay.ended).reason).toBe("idle");

    const deadline = await openPgRelay({
      target: plainTarget(fake.port),
      network: loopback,
      maxDurationMs: 150,
    });
    if (!deadline.ok) throw new Error(deadline.message);
    const busy = await dial(join(deadline.relay.socketDir, ".s.PGSQL.5432"));
    busy.on("error", () => undefined);
    const ticker = setInterval(() => busy.write("x"), 20);
    expect((await deadline.relay.ended).reason).toBe("deadline");
    clearInterval(ticker);

    const lonely = await openPgRelay({
      target: plainTarget(fake.port),
      network: loopback,
      maxDurationMs: 30_000,
      acceptTimeoutMs: 80,
    });
    if (!lonely.ok) throw new Error(lonely.message);
    expect((await lonely.relay.ended).reason).toBe("accept_timeout");
    expect(existsSync(lonely.relay.socketDir)).toBe(false);

    const closing = await openPgRelay({
      target: plainTarget(fake.port),
      network: loopback,
      maxDurationMs: 30_000,
    });
    if (!closing.ok) throw new Error(closing.message);
    const other = await dial(join(closing.relay.socketDir, ".s.PGSQL.5432"));
    other.on("error", () => undefined);
    await roundTrip(other, "ping");
    for (const server of servers) {
      server.close();
    }
    // Closing the listener leaves accepted sockets; end them from the server's side.
    other.destroy();
    expect(["client_closed", "server_closed"]).toContain((await closing.relay.ended).reason);
  });

  it("offers the program SCRAM without channel binding during the sign-in, then passes bytes", () => {
    const filter = new PgSignInFilter();
    const sasl = Buffer.concat([
      Buffer.from([0x52]),
      Buffer.alloc(4),
      Buffer.from([0, 0, 0, 10]),
      Buffer.from("SCRAM-SHA-256-PLUS\0SCRAM-SHA-256\0\0", "utf8"),
    ]);
    sasl.writeUInt32BE(sasl.length - 1, 1);
    // In two pieces, as the network may deliver it.
    const first = filter.push(sasl.subarray(0, 7));
    expect(first).toMatchObject({ done: false, error: false });
    expect(first.out.length).toBe(0);
    const second = filter.push(sasl.subarray(7));
    expect(second.out.subarray(9).toString("utf8")).toBe("SCRAM-SHA-256\0\0");
    expect(second.out.readUInt32BE(1)).toBe(second.out.length - 1);
    const ok = filter.push(Buffer.concat([AUTH_OK, Buffer.from("Z-rest")]));
    expect(ok.done).toBe(true);
    expect(ok.out.subarray(9).toString("utf8")).toBe("Z-rest");
    expect(filter.push(Buffer.from("raw")).out.toString()).toBe("raw");
    // A message larger than any sign-in message ends the relay.
    const huge = Buffer.from([0x52, 0x7f, 0, 0, 0]);
    expect(new PgSignInFilter().push(huge).error).toBe(true);
  });

  it("refuses a private address without approval before connecting", async () => {
    const fake = await fakePg();
    const opened = await openPgRelay({
      target: plainTarget(fake.port),
      network: { allowPrivateNetworks: false, approvedAddresses: [], forbiddenTargets: [] },
      maxDurationMs: 30_000,
    });
    expect(opened).toMatchObject({ ok: false, code: "db_private_network" });
    expect(fake.connections).toBe(0);
  });

  it("refuses Restow's own database by the address reached, before anything is sent", async () => {
    const fake = await fakePg();
    const opened = await openPgRelay({
      target: plainTarget(fake.port),
      network: { ...loopback, forbiddenTargets: [{ address: "127.0.0.1", port: fake.port }] },
      maxDurationMs: 30_000,
    });
    expect(opened).toMatchObject({ ok: false, code: "db_target_is_restow" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.received).toBe(0);
  });

  it("goes only to the address of the run's first connection, whatever the name resolves to", async () => {
    const fake = await fakePg();
    // The name resolves to the fake, but the run's first connection reached another address:
    // the relay goes there (nothing listens) and never to what the lookup answers now.
    const lookup = ((_host: string, options: { all?: boolean }, callback: Function) =>
      options.all
        ? callback(null, [{ address: "127.0.0.1", family: 4 }])
        : callback(null, "127.0.0.1", 4)) as never;
    const moved = await openPgRelay({
      target: { ...plainTarget(fake.port), host: "db.example.test", address: "127.0.0.2" },
      network: { ...loopback, lookup },
      connectTimeoutMs: 2000,
      maxDurationMs: 30_000,
    });
    expect(moved.ok).toBe(false);
    expect(fake.connections).toBe(0);
    // The fixed address is judged like any other: not approved, not connected.
    const refused = await openPgRelay({
      target: { ...plainTarget(fake.port), host: "db.example.test", address: "127.0.0.1" },
      network: { allowPrivateNetworks: false, approvedAddresses: [], forbiddenTargets: [] },
      maxDurationMs: 30_000,
    });
    expect(refused).toMatchObject({ ok: false, code: "db_private_network" });
    // An IP address as the host must be the fixed one.
    const other = await openPgRelay({
      target: { ...plainTarget(fake.port), address: "127.0.0.3" },
      network: loopback,
      maxDurationMs: 30_000,
    });
    expect(other.ok).toBe(false);
    expect(fake.connections).toBe(0);
    const same = await openPgRelay({
      target: { ...plainTarget(fake.port), host: "db.example.test", address: "127.0.0.1" },
      network: loopback,
      maxDurationMs: 30_000,
    });
    expect(same.ok).toBe(true);
    if (same.ok) {
      expect(same.relay.connectedAddress).toBe("127.0.0.1");
      same.relay.close();
      await same.relay.ended;
    }
  });

  it("refuses a server without TLS unless the connection allows it", async () => {
    const fake = await fakePg();
    const opened = await openPgRelay({
      target: { ...plainTarget(fake.port), allowUnencrypted: false },
      network: loopback,
      maxDurationMs: 30_000,
    });
    expect(opened).toMatchObject({ ok: false, code: "db_tls_missing" });
  });
});

describe("SQL literals [DB-008]", () => {
  it("meet only UTF-8 sessions: the client asks for it at the start", () => {
    expect(pgStartupMessage("backup", "app").includes(Buffer.from("client_encoding\0UTF8\0"))).toBe(
      true,
    );
  });

  it("mean the same with and without standard_conforming_strings", () => {
    expect(pgQuoteLiteral("plain")).toBe("E'plain'");
    // A backslash before the quote must not escape it: both are doubled in the escape form.
    expect(pgQuoteLiteral("a\\'b")).toBe("E'a\\\\''b'");
    expect(() => pgQuoteLiteral("a\0b")).toThrow();
  });
});

describe("leftovers of crashed runs [DB-003]", () => {
  it("are removed when older than a run may last, only directories with the run's prefixes", async () => {
    const base = await mkdtemp(join(tmpdir(), "sweep-"));
    try {
      const old = new Date(Date.now() - 48 * 3600 * 1000);
      for (const name of ["restow-db-run-a", "restow-pg-relay-b", "restow-db-young", "other-c"]) {
        await mkdir(join(base, name));
      }
      await writeFile(join(base, "restow-db-file"), "x");
      for (const name of ["restow-db-run-a", "restow-pg-relay-b", "other-c", "restow-db-file"]) {
        await utimes(join(base, name), old, old);
      }
      const removed = await sweepStaleTempDirs({ base, maxAgeMs: 25 * 3600 * 1000 });
      expect(removed).toBe(2);
      expect(existsSync(join(base, "restow-db-run-a"))).toBe(false);
      expect(existsSync(join(base, "restow-pg-relay-b"))).toBe(false);
      expect(existsSync(join(base, "restow-db-young"))).toBe(true);
      expect(existsSync(join(base, "other-c"))).toBe(true);
      expect(existsSync(join(base, "restow-db-file"))).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("the PostgreSQL programs [DB-002]", () => {
  it("get fixed argument lists and an environment of their own, never the password", async () => {
    expect(pgDumpArgs("shop's=db")).toEqual([
      "--format=custom",
      "--compress=0",
      "--no-password",
      "--dbname=dbname='shop\\'s=db'",
    ]);
    expect(pgRestoreArgs("new")).toEqual([
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
      "--no-password",
      "--dbname=dbname='new'",
    ]);
    expect(pgDumpallGlobalsArgs({ rolePasswords: false })).toContain("--no-role-passwords");
    expect(pgConninfoValue("a\\b")).toBe("'a\\\\b'");
    const env = pgToolEnv({
      socketDir: "/dev/shm/x",
      port: 5432,
      user: "backup",
      passFile: "/dev/shm/p",
    });
    expect(env).toMatchObject({
      PGHOST: "/dev/shm/x",
      PGSSLMODE: "disable",
      PGPASSFILE: "/dev/shm/p",
    });
    expect(Object.keys(env)).not.toContain("DATABASE_URL");
    expect(JSON.stringify(env)).not.toContain("secret");
    const dir = await privateTempDir("restow-test-");
    const passFile = await writePgPassFile(dir, "se:cr\\et");
    expect(statSync(passFile).mode & 0o777).toBe(0o600);
    expect(await readFile(passFile, "utf8")).toBe(pgPassFileLine("se:cr\\et"));
    expect(pgPassFileLine("se:cr\\et")).toBe("*:*:*:*:se\\:cr\\\\et\n");
  });

  it("count the table of contents by kind and read the program's version", async () => {
    const listing = [
      ";",
      "; Archive created at 2026-11-18 10:00:00 UTC",
      "215; 1259 16390 TABLE public orders restow",
      "216; 1259 16391 TABLE public items restow",
      "3380; 0 16390 TABLE DATA public orders restow",
      "3200; 2606 16400 FK CONSTRAINT public items items_order_fkey restow",
      "218; 1255 16401 FUNCTION public total() restow",
      "219; 1259 16402 MATERIALIZED VIEW public summary restow",
    ].join("\n");
    expect(countPgListEntries(listing)).toEqual({
      TABLE: 2,
      "TABLE DATA": 1,
      "FK CONSTRAINT": 1,
      FUNCTION: 1,
      "MATERIALIZED VIEW": 1,
    });
    expect(pgToolMajor("pg_dump (PostgreSQL) 18.1 (Debian 18.1-1.pgdg12+1)")).toBe(18);
    expect(pgToolMajor("pg_dump (PostgreSQL) 9.6.24")).toBeNull();
    expect(await choosePgTools(16, [])).toMatchObject({ ok: false, code: "db_tool_missing" });
  });
});
