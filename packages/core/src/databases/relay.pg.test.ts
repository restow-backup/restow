/**
 * The pinning relay against a real PostgreSQL with TLS (docs/DATABASES.md 16 "D3" O1): `pg_dump`
 * dumps through it with the password from a `PGPASSFILE`, `db-stream` hashes and counts the
 * archive, `pg_restore` plays it into a new database through another relay; a certificate other
 * than the confirmed one opens no relay at all.
 *
 * Runs when RESTOW_TEST_DATABASE_TLS_URL points at a PostgreSQL with `ssl = on` (docs/CI.md
 * "Postgres suites") and the client programs are installed; skipped otherwise.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  choosePgTools,
  type DbStreamStats,
  pgDumpArgs,
  pgRestoreArgs,
  pgToolEnv,
  runDbStream,
} from "./pg-tools.js";
import { probeDatabaseFromServer } from "./probe/probe.js";
import {
  openPgAdminSession,
  openPgRelay,
  type PgAdminSession,
  pgQuoteIdent,
  privateTempDir,
  writePgPassFile,
} from "./relay.js";

const url = process.env.RESTOW_TEST_DATABASE_TLS_URL;
const admin = url ? new URL(url) : null;
const host = admin?.hostname ?? "localhost";
const port = Number(admin?.port || 5432);
const user = decodeURIComponent(admin?.username ?? "");
const password = decodeURIComponent(admin?.password ?? "");
const suffix = randomBytes(4).toString("hex");
const SOURCE = `restow_relay_src_${suffix}`;
const TARGET = `restow_relay_dst_${suffix}`;
const network = { allowPrivateNetworks: true, approvedAddresses: [], forbiddenTargets: [] };

describe.skipIf(!url)("the pinning relay against a real PostgreSQL with TLS [DB-003]", () => {
  let fingerprint = "";
  let session: PgAdminSession;
  let dir = "";

  const target = (pinned: string | null = fingerprint) => ({
    host,
    port,
    allowUnencrypted: false,
    pinnedFingerprintSha256: pinned,
  });

  beforeAll(async () => {
    const probe = await probeDatabaseFromServer(
      {
        probeId: "00000000-0000-4000-8000-000000000003",
        engine: "postgresql",
        host,
        port,
        path: null,
        database: null,
        authMethod: "password",
        user,
        password,
        allowUnencrypted: false,
        timeoutSeconds: 20,
      },
      network,
    );
    fingerprint = probe.tls.fingerprintSha256 ?? "";
    const opened = await openPgAdminSession(target(), network, { user, password }, "postgres");
    if (!opened.ok) throw new Error(opened.message);
    session = opened.session;
    await session.query(`CREATE DATABASE ${pgQuoteIdent(SOURCE)}`);
    const source = await openPgAdminSession(target(), network, { user, password }, SOURCE);
    if (!source.ok) throw new Error(source.message);
    await source.session.query(
      "CREATE TABLE orders (id int PRIMARY KEY, item text); INSERT INTO orders VALUES (1, 'tea'), (2, 'cake'); CREATE VIEW cheap AS SELECT id FROM orders",
    );
    source.session.close();
    dir = await privateTempDir("restow-relay-test-");
  });

  afterAll(async () => {
    if (session) {
      await session.query(`DROP DATABASE IF EXISTS ${pgQuoteIdent(SOURCE)}`);
      await session.query(`DROP DATABASE IF EXISTS ${pgQuoteIdent(TARGET)}`);
      session.close();
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("dumps through the relay and restores into a new database through another", async () => {
    const [version] = await session.query("SHOW server_version_num");
    const tools = await choosePgTools(Math.floor(Number(version?.[0]) / 10000));
    if (!tools.ok) throw new Error(tools.message);
    const passFile = await writePgPassFile(dir, password);

    const dumping = await openPgRelay({ target: target(), network, maxDurationMs: 120_000 });
    if (!dumping.ok) throw new Error(dumping.message);
    expect(dumping.relay.tls).toMatchObject({ used: true, fingerprintSha256: fingerprint });
    const archive = join(dir, "source.pgdump");
    const statsPath = join(dir, "stats.json");
    const out = createWriteStream(archive);
    const code = await runDbStream(
      {
        tool: tools.tools.path("pg_dump"),
        args: pgDumpArgs(SOURCE),
        env: pgToolEnv({
          socketDir: dumping.relay.socketDir,
          port: dumping.relay.port,
          user,
          passFile,
        }),
        listTool: tools.tools.path("pg_restore"),
        statsPath,
      },
      out,
    );
    await new Promise((resolve) => out.end(resolve));
    const stats = JSON.parse(await readFile(statsPath, "utf8")) as DbStreamStats;
    expect({ code, ok: stats.ok }).toEqual({ code: 0, ok: true });
    expect(stats.sha256).toBe(
      createHash("sha256")
        .update(await readFile(archive))
        .digest("hex"),
    );
    expect(stats.objects).toMatchObject({ TABLE: 1, "TABLE DATA": 1, VIEW: 1 });
    expect((await dumping.relay.ended).reason).toBe("client_closed");

    await session.query(`CREATE DATABASE ${pgQuoteIdent(TARGET)} TEMPLATE template0`);
    const restoring = await openPgRelay({ target: target(), network, maxDurationMs: 120_000 });
    if (!restoring.ok) throw new Error(restoring.message);
    const restored = await new Promise<number | null>((resolve) => {
      const child = spawn(tools.tools.path("pg_restore"), pgRestoreArgs(TARGET), {
        env: pgToolEnv({
          socketDir: restoring.relay.socketDir,
          port: restoring.relay.port,
          user,
          passFile,
        }),
        stdio: ["pipe", "ignore", "pipe"],
      });
      createReadStream(archive).pipe(child.stdin);
      child.on("close", resolve);
    });
    expect(restored).toBe(0);
    const check = await openPgAdminSession(target(), network, { user, password }, TARGET);
    if (!check.ok) throw new Error(check.message);
    expect(await check.session.query("SELECT item FROM orders ORDER BY id")).toEqual([
      ["tea"],
      ["cake"],
    ]);
    check.session.close();
  });

  it("opens no relay when the server shows another certificate", async () => {
    const opened = await openPgRelay({
      target: target(`${"0F:".repeat(31)}0F`),
      network,
      maxDurationMs: 30_000,
    });
    expect(opened).toMatchObject({ ok: false, code: "db_tls_changed" });
  });

  it("answers a failing dump with an error and no success", async () => {
    const [version] = await session.query("SHOW server_version_num");
    const tools = await choosePgTools(Math.floor(Number(version?.[0]) / 10000));
    if (!tools.ok) throw new Error(tools.message);
    const passFile = await writePgPassFile(dir, `wrong-${suffix}`);
    const relay = await openPgRelay({ target: target(), network, maxDurationMs: 60_000 });
    if (!relay.ok) throw new Error(relay.message);
    const statsPath = join(dir, "failed.json");
    const sink = createWriteStream(join(dir, "failed.pgdump"));
    const code = await runDbStream(
      {
        tool: tools.tools.path("pg_dump"),
        args: pgDumpArgs(SOURCE),
        env: pgToolEnv({
          socketDir: relay.relay.socketDir,
          port: relay.relay.port,
          user,
          passFile,
        }),
        listTool: null,
        statsPath,
      },
      sink,
    );
    await new Promise((resolve) => sink.end(resolve));
    const stats = JSON.parse(await readFile(statsPath, "utf8")) as DbStreamStats;
    expect(code).toBe(1);
    expect(stats.ok).toBe(false);
    expect(stats.stderr).toMatch(/password authentication failed/);
    expect(stats.stderr).not.toContain(`wrong-${suffix}`);
    relay.relay.close();
  });
});
