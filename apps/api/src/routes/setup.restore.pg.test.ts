/**
 * Restoring an installation from a dump in the setup wizard (routes/setup-restore.ts) against
 * Postgres and a stand-in for the updater on a local port, through the real application:
 *
 *   - every restore route needs the setup token (403 without it), and nothing reaches the updater;
 *   - with the token the wizard sees the updater's kept dumps, uploads a dump in parts and starts
 *     the restore; the public state shows how it stands, without the report;
 *   - `POST /setup` (a new installation, with its first admin) answers 409 while the restore runs:
 *     the restore path never creates an administrator;
 *   - activating needs the confirmation, retires the setup token, and once the restored database
 *     is configured the restore routes answer 409.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createDb, type Database } from "@restow/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../features/snapshots/testing/explorer-fixture.js";
import { provisionTestRoles, type TestDatabaseRoles } from "../testing/database-roles.js";
import type { StateView } from "../updater/protocol.js";
import type { RestoreRecord } from "../updater/restore-protocol.js";

const DATABASE = "restow_api_setup_restore_routes_test";
const SETUP_TOKEN = "7QKMZ-RT4VX-9HBNP-2WCAF";
const DUMP = "restow-20261101-020000-0.4.12-to-0.5.0.dump";
const SECRET = randomBytes(24).toString("hex");

function stateWith(restore: RestoreRecord | null): StateView {
  return {
    updaterVersion: "0.5.0",
    phase: "idle",
    run: null,
    history: [],
    events: [],
    capabilities: {
      ready: true,
      blockers: [],
      runner: "helper",
      composeFile: "/opt/restow/docker-compose.yml",
      imageRepository: "ghcr.io/restow-backup/restow",
      webImageRepository: "ghcr.io/restow-backup/restow-web",
      dumps: [{ file: DUMP, bytes: 4096, createdAt: "2026-11-01T02:00:00.000Z" }],
      sourceAllowlist: [],
      signatureChecks: true,
      projectDir: "/opt/restow",
      mounterService: true,
      updateSpace: null,
      checkedAt: "2026-11-05T09:00:00.000Z",
    },
    selfUpdate: null,
    mounterEnable: null,
    restartableServices: [],
    restart: null,
    projectDir: null,
    database: null,
    restore,
    serverTime: "2026-11-05T09:00:00.000Z",
  };
}

describe.skipIf(!testDatabaseAdminUrl)("setup wizard restore routes against Postgres", () => {
  let owner: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let root: string;
  let server: ReturnType<typeof serve> | null = null;
  const calls: string[] = [];
  let restore: RestoreRecord | null = null;

  const headers = (token?: string) => ({
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
    "x-forwarded-for": "198.51.100.10",
    ...(token ? { "x-restow-setup-token": token } : {}),
  });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "restow-setup-restore-routes-"));
    await writeFile(join(root, "secret"), SECRET);
    // The updater, as far as these routes reach it.
    const fake = new Hono();
    fake.use("/v1/*", async (c, next) => {
      if (c.req.header("authorization") !== `Bearer ${SECRET}`) {
        return c.json({ code: "unauthorized", message: "no" }, 401);
      }
      calls.push(`${c.req.method} ${c.req.path}`);
      await next();
      return undefined;
    });
    fake.get("/v1/state", (c) => c.json(stateWith(restore)));
    fake.post("/v1/dumps/uploads", (c) =>
      c.json({ id: "0123456789abcdef0123456789abcdef", bytes: 10, received: 0 }, 201),
    );
    fake.put("/v1/dumps/uploads/:id", async (c) => {
      const bytes = (await c.req.arrayBuffer()).byteLength;
      return c.json({
        id: c.req.param("id"),
        bytes: 10,
        received: Number(c.req.query("offset")) + bytes,
      });
    });
    fake.post("/v1/dumps/uploads/:id/complete", (c) =>
      c.json({
        dump: {
          file: "restow-20261105-090000-uploaded-to-0.5.0.dump",
          bytes: 10,
          createdAt: "2026-11-05T09:00:00.000Z",
        },
      }),
    );
    fake.post("/v1/database/restore", async (c) => {
      const body = (await c.req.json()) as {
        dump: string;
        requestedBy: RestoreRecord["requestedBy"];
      };
      restore = {
        id: "r1",
        status: "awaiting_confirmation",
        phase: "awaiting_confirmation",
        dump: body.dump,
        startedAt: "2026-11-05T09:00:00.000Z",
        finishedAt: null,
        report: null,
        message: null,
        requestedBy: body.requestedBy,
        servicesStopped: true,
      };
      return c.json(stateWith(restore), 202);
    });
    fake.post("/v1/database/restore/activate", (c) => {
      if (restore) {
        restore = { ...restore, status: "running", phase: "activating" };
      }
      return c.json(stateWith(restore), 202);
    });
    await new Promise<void>((resolve) => {
      server = serve({ fetch: fake.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve());
    });
    const port = ((server as ReturnType<typeof serve> | null)?.address() as AddressInfo | null)
      ?.port;

    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64");
    process.env.RESTOW_PUBLIC_URL = "http://localhost:3000";
    process.env.RESTOW_SETUP_TOKEN = SETUP_TOKEN;
    process.env.RESTOW_UPDATER_URL = `http://127.0.0.1:${port}`;
    process.env.RESTOW_UPDATER_SECRET_FILE = join(root, "secret");
    owner = createDb(url);
    ({ app } = await import("../app.js"));
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../db.js");
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
    await owner?.$client.end();
    server?.close();
    for (const name of ["RESTOW_SETUP_TOKEN", "RESTOW_UPDATER_URL", "RESTOW_UPDATER_SECRET_FILE"]) {
      Reflect.deleteProperty(process.env, name);
    }
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
    await rm(root, { recursive: true, force: true });
  });

  it("refuses every restore route without the setup token", async () => {
    for (const [method, path] of [
      ["GET", "/api/v1/setup/restore"],
      ["POST", "/api/v1/setup/restore/uploads"],
      ["POST", "/api/v1/setup/restore/start"],
      ["POST", "/api/v1/setup/restore/activate"],
      ["POST", "/api/v1/setup/restore/abort"],
    ] as const) {
      const response = await app.request(path, {
        method,
        headers: headers("WRONG-TOKEN"),
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  it("lists the kept dumps, takes an upload in parts and starts the restore", async () => {
    const listed = await app.request("/api/v1/setup/restore", { headers: headers(SETUP_TOKEN) });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { available: boolean; dumps: { file: string }[] };
    expect(body.available).toBe(true);
    expect(body.dumps.map((dump) => dump.file)).toEqual([DUMP]);

    const started = await app.request("/api/v1/setup/restore/uploads", {
      method: "POST",
      headers: headers(SETUP_TOKEN),
      body: JSON.stringify({ bytes: 10, sha256: "a".repeat(64) }),
    });
    expect(started.status).toBe(201);
    const part = await app.request(
      "/api/v1/setup/restore/uploads/0123456789abcdef0123456789abcdef?offset=0",
      {
        method: "PUT",
        headers: {
          ...headers(SETUP_TOKEN),
          "content-type": "application/octet-stream",
          "content-length": "10",
        },
        body: Buffer.from("PGDMP12345"),
      },
    );
    expect(part.status).toBe(200);
    expect(((await part.json()) as { received: number }).received).toBe(10);
    const completed = await app.request(
      "/api/v1/setup/restore/uploads/0123456789abcdef0123456789abcdef/complete",
      { method: "POST", headers: headers(SETUP_TOKEN), body: "{}" },
    );
    expect(completed.status).toBe(200);

    const restoring = await app.request("/api/v1/setup/restore/start", {
      method: "POST",
      headers: headers(SETUP_TOKEN),
      body: JSON.stringify({ dump: DUMP }),
    });
    expect(restoring.status).toBe(202);
    const operation = ((await restoring.json()) as { operation: Record<string, unknown> })
      .operation;
    expect(operation.status).toBe("awaiting_confirmation");
    // The requester's address stays with the updater.
    expect(operation).not.toHaveProperty("requestedBy");

    const state = (await (await app.request("/api/v1/setup/state")).json()) as {
      restore: { available: boolean; status: string };
    };
    expect(state.restore).toEqual({
      available: true,
      status: "awaiting_confirmation",
      phase: "awaiting_confirmation",
      message: null,
    });
    expect(state.restore).not.toHaveProperty("report");
  });

  it("refuses a new installation (with its first admin) while the restore runs", async () => {
    const response = await app.request("/api/v1/setup", {
      method: "POST",
      headers: headers(SETUP_TOKEN),
      body: JSON.stringify({ operatingMode: "local" }),
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { type: string }).type).toBe(
      "urn:restow:problem:restore-in-progress",
    );
    const admins = await owner.$client.query('SELECT 1 FROM "user"');
    expect(admins.rows).toHaveLength(0);
  });

  it("activates only with the confirmation, retires the token, and closes once configured", async () => {
    const unconfirmed = await app.request("/api/v1/setup/restore/activate", {
      method: "POST",
      headers: headers(SETUP_TOKEN),
      body: "{}",
    });
    expect(unconfirmed.status).toBe(422);
    const activated = await app.request("/api/v1/setup/restore/activate", {
      method: "POST",
      headers: headers(SETUP_TOKEN),
      body: JSON.stringify({ confirm: true }),
    });
    expect(activated.status).toBe(202);
    expect(calls).toContain("POST /v1/database/restore/activate");
    // The token has served its purpose.
    const again = await app.request("/api/v1/setup/restore", { headers: headers(SETUP_TOKEN) });
    expect(again.status).toBe(403);

    // The restored database is live: configured, so the wizard is closed for good.
    await owner.$client.query("INSERT INTO settings (setup_completed_at) VALUES (now())");
    const closed = await app.request("/api/v1/setup/restore", { headers: headers(SETUP_TOKEN) });
    expect(closed.status).toBe(409);
  });

  it("tells the public setup state why an activated restore needs attention", async () => {
    const { restoreAvailability } = await import("./setup-restore.js");
    const base = restore as RestoreRecord;
    const updaterWith = (record: RestoreRecord) =>
      ({ enabled: true, state: async () => stateWith(record) }) as unknown as Parameters<
        typeof restoreAvailability
      >[0];
    // The token is retired and a restarted api has a new one: the Done step reads this alone.
    expect(
      await restoreAvailability(
        updaterWith({
          ...base,
          status: "needs_attention",
          phase: "starting",
          message: "The api did not become healthy on the restored database.",
        }),
      ),
    ).toEqual({
      available: true,
      status: "needs_attention",
      phase: "starting",
      message: "The api did not become healthy on the restored database.",
    });
    // Nothing of a restore that runs or is done.
    expect(
      (await restoreAvailability(updaterWith({ ...base, status: "done", message: "x" }))).message,
    ).toBeNull();
  });
});
