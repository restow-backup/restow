/**
 * Postgres-backed test of the setup wizard's mail step:
 *
 *   - the public state says whether Microsoft 365 through the backup app can be
 *     offered at all (it cannot without a usable app registration);
 *   - a Graph transport keeps the tenant the wizard named;
 *   - the test message after the setup answers with a reason code the wizard
 *     translates, instead of only a raw English error.
 *
 * One installation, one setup. Drives the real application (apps/api/src/app.ts)
 * on the roles Row Level Security binds. Runs when RESTOW_TEST_DATABASE_URL points
 * at a Postgres server; without it the suite is skipped.
 */
import { randomBytes } from "node:crypto";
import { type Database, createDb, settings } from "@restow/db";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../features/snapshots/testing/explorer-fixture.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../testing/database-roles.js";

const DATABASE = "restow_api_setup_mail_test";
const PUBLIC_URL = "http://localhost:3000";
const SETUP_TOKEN = "7QKMZ-RT4VX-9HBNP-2WCAF";

describe.skipIf(!testDatabaseAdminUrl)("setup wizard mail step against Postgres", () => {
  let owner: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let version: string;

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64");
    process.env.RESTOW_PUBLIC_URL = PUBLIC_URL;
    process.env.RESTOW_SETUP_TOKEN = SETUP_TOKEN;
    owner = createDb(url);
    ({ app } = await import("../app.js"));
    ({ DISCLAIMER_VERSION: version } = await import("../lib/disclaimer.js"));
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await owner?.$client.end();
    Reflect.deleteProperty(process.env, "RESTOW_SETUP_TOKEN");
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  }, 30_000);

  it("does not offer Microsoft 365 through the backup app while no app registration exists", async () => {
    const response = await app.fetch(new Request(`${PUBLIC_URL}/api/v1/setup/state`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      configured: false,
      mailOptions: { graphBackupApp: false },
    });
  });

  it("keeps the Graph tenant and explains the failed test message with a reason", async () => {
    const response = await app.fetch(
      new Request(`${PUBLIC_URL}/api/v1/setup`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-restow-setup-token": SETUP_TOKEN },
        body: JSON.stringify({
          disclaimer: { version, accepted: true },
          operatingMode: "local",
          providerName: "Beispiel IT-Service GmbH",
          language: "de",
          firstAdmin: { name: "Operator", email: "ops@example.com", password: "correct-horse-1x" },
          mail: {
            transport: "graph",
            graph: { sender: "alerts@contoso.com", tenantId: "contoso.onmicrosoft.com" },
          },
          sendTest: true,
        }),
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { testSend: Record<string, unknown> };
    expect(body.testSend).toMatchObject({
      attempted: true,
      ok: false,
      reason: "graph_app_missing",
    });
    const [row] = await owner.select().from(settings).limit(1);
    expect(row?.mailConfig).toEqual({
      transport: "graph",
      sender: "alerts@contoso.com",
      tenantId: "contoso.onmicrosoft.com",
    });

    const state = await app.fetch(new Request(`${PUBLIC_URL}/api/v1/setup/state`));
    expect(await state.json()).toMatchObject({
      configured: true,
      mailOptions: { graphBackupApp: false },
    });
  });
});
