/**
 * Postgres-backed test of the setup in demo mode (RESTOW_DEMO,
 * deploy/demo/README.md): the public demo has no operator, so the notice is
 * treated as accepted and there is no setup token. The seed process's own
 * token-authenticated setup call installs the demo account without carrying
 * an acceptance or a setup token, the public state reports the notice as
 * accepted so the web shows no dialog to a visitor who could not accept it
 * anyway, a visitor cannot reach the setup routes at all, and no client
 * address is stored.
 *
 * `config` is read from `process.env` at import time, so demo mode is set in
 * the environment before the application is imported fresh (its own file, its
 * own module registry, same approach as features/jobs/first-backup.demo.pg.test.ts).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server; without it
 * the suite is skipped.
 */
import { randomBytes } from "node:crypto";
import { type Database, auditLog, createDb, settings } from "@restow/db";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../features/snapshots/testing/explorer-fixture.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../testing/database-roles.js";

const DATABASE = "restow_api_setup_disclaimer_demo_test";
const PUBLIC_URL = "http://localhost:3000";
const DEMO_EMAIL = "demo@example.com";
const DEMO_PASSWORD = "public-demo-password-1";
const SEED_TOKEN = randomBytes(16).toString("hex");

const DEMO_SETUP = {
  operatingMode: "local",
  firstAdmin: { name: "Demo", email: DEMO_EMAIL, password: DEMO_PASSWORD },
  mail: {
    transport: "smtp",
    smtp: { host: "mail.example.com", port: 587, security: "starttls", from: "demo@example.com" },
  },
  sendTest: false,
};

describe.skipIf(!testDatabaseAdminUrl)("operator notice in demo mode against Postgres", () => {
  let owner: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64");
    process.env.RESTOW_PUBLIC_URL = PUBLIC_URL;
    vi.stubEnv("RESTOW_DEMO", "true");
    vi.stubEnv("RESTOW_DEMO_EMAIL", DEMO_EMAIL);
    vi.stubEnv("RESTOW_DEMO_PASSWORD", DEMO_PASSWORD);
    vi.stubEnv("RESTOW_DEMO_SEED_TOKEN", SEED_TOKEN);
    owner = createDb(url);
    ({ app } = await import("../app.js"));
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    const shared = await import("../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  }, 30_000);

  function call(
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    return Promise.resolve(
      app.fetch(
        new Request(`${PUBLIC_URL}${path}`, {
          method,
          headers: {
            ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
            ...options.headers,
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        }),
      ),
    );
  }

  it("reports the notice as accepted and no setup token before the seed's setup", async () => {
    const before = (await (await call("GET", "/api/v1/setup/state")).json()) as {
      configured: boolean;
      demo: { enabled: boolean };
      disclaimer: { version: string; accepted: boolean };
      setupToken: { required: boolean };
    };
    expect(before.demo.enabled).toBe(true);
    expect(before.configured).toBe(false);
    expect(before.disclaimer.accepted).toBe(true);
    // The demo is set up by its seed with the seed token, never through the wizard.
    expect(before.setupToken.required).toBe(false);
  });

  it("gives a visitor no way to set up the demo or probe a setup token", async () => {
    for (const path of ["/api/v1/setup", "/api/v1/setup/token"]) {
      const response = await call("POST", path, {
        body: DEMO_SETUP,
        headers: { "x-restow-setup-token": "AAAAA-BBBBB-CCCCC-DDDDD" },
      });
      expect(response.status, path).toBe(403);
    }
    expect(await owner.select().from(settings)).toEqual([]);
  });

  it("lets the seed's setup call install the demo without accepting anything", async () => {
    const response = await call("POST", "/api/v1/setup", {
      body: DEMO_SETUP,
      headers: { "x-restow-demo-seed-token": SEED_TOKEN },
    });
    expect(response.status).toBe(201);

    const [row] = await owner.select().from(settings);
    expect(row?.setupCompletedAt).not.toBeNull();
    const actions = (await owner.select({ action: auditLog.action }).from(auditLog)).map(
      (entry) => entry.action,
    );
    expect(actions).toEqual(["setup.completed"]);

    const after = (await (await call("GET", "/api/v1/setup/state")).json()) as {
      configured: boolean;
      disclaimer: { accepted: boolean };
    };
    expect(after).toMatchObject({ configured: true, disclaimer: { accepted: true } });
  });

  it("stays closed to everyone after the seed's setup, seed token included", async () => {
    const response = await call("POST", "/api/v1/setup", {
      body: DEMO_SETUP,
      headers: { "x-restow-demo-seed-token": SEED_TOKEN },
    });
    expect(response.status).toBe(409);
  });
});
