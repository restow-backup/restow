import type { AuditLogEntry, Database } from "@restow/db";
import { createDb, restoreJobs } from "@restow/db";
import { eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ExplorerFixture,
  createExplorerFixture,
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../../features/snapshots/testing/explorer-fixture.js";
import type {
  ApiKeyContext,
  ApiKeyVariables,
  RequireApiKeyOptions,
  requireApiKey,
} from "../../middleware/apiKey.js";
import { ProblemError, errorHandler, notFoundHandler } from "../../problem.js";
import { buildV1 } from "../v1.js";
import { featuresOff } from "./testing/features.js";

const DATABASE = "restow_api_v1_restore_test";
const TOKEN = "rsk_test_fixture";

/**
 * HTTP-level regression tests (round 3) of the v1 restore rule: mailbox and
 * IMAP restores never replace an original. The rule itself
 * (isReplaceModeAllowedFor, features/restore/schemas.ts) and its transaction
 * (features/restore/service.ts) are unit- and Postgres-tested elsewhere
 * (schemas.test.ts, features/restore/restore.pg.test.ts). This file proves
 * the same rule through the real `/api/v1` router (buildV1,
 * registerRestoreRoutes) with an API key, the real service and a real
 * Postgres database, so the refusal cannot be faked by mocking the service.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the
 * database `restow_api_v1_restore_test` is recreated there and dropped
 * after). Without it the suite is skipped. This is a Postgres suite in the
 * sense of docs/TESTING.md's level 2 section, but that section's file list
 * is maintained by the item that owns docs/; it should add this path there.
 */

/**
 * A stand-in for the API-key middleware (same contract as
 * routes/v1/testing/keys.ts) bound to one fixture's tenant, since
 * createExplorerFixture generates a fresh tenant id per run instead of the
 * fixed one that file's fake key table uses.
 */
function requireKeyFor(tenantId: string): typeof requireApiKey {
  return ((
    _scope,
    options: RequireApiKeyOptions = {},
  ): MiddlewareHandler<{
    Variables: ApiKeyVariables;
  }> => {
    return async (c, next) => {
      const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/, "").trim();
      if (token !== TOKEN) {
        throw new ProblemError(401, "Invalid API key");
      }
      if (options.provider) {
        throw new ProblemError(403, "Provider key required");
      }
      c.set("apiKey", {
        keyId: "key-fixture",
        tenantId,
        isProvider: false,
        scopes: ["restore:write"],
      } as ApiKeyContext);
      await next();
    };
  }) as typeof requireApiKey;
}

describe.skipIf(!testDatabaseAdminUrl)("POST /api/v1/restore, mode 'replace'", () => {
  let db: Database;
  let f: ExplorerFixture;
  let app: Hono;

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    const boss = new PgBoss({ connectionString: url });
    await boss.start();
    await boss.createQueue("restore");
    await boss.stop({ graceful: false, wait: true });

    db = createDb(url);
    f = await createExplorerFixture(db);

    const api = buildV1({
      db,
      providerDb: db,
      requireKey: requireKeyFor(f.tenantId),
      requireFeature: featuresOff,
      audit: async () => ({}) as AuditLogEntry,
      version: {
        current: () => ({
          running: "1.4.0",
          commit: null,
          latest: null,
          updateAvailable: null,
          releaseUrl: null,
          updateCheck: "disabled",
          checkedAt: null,
          channel: "stable",
          latestTag: null,
          publishedAt: null,
          checkError: null,
          maintenance: null,
        }),
      },
      now: () => new Date("2026-09-24T09:00:00.000Z"),
    });
    app = new Hono();
    app.onError(errorHandler);
    app.notFound(notFoundHandler);
    app.route("/api/v1", api.app);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  function post(body: Record<string, unknown>) {
    return app.request("/api/v1/restore", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  const REPLACE = (snapshotId: string, path: string) => ({
    snapshotId,
    selection: [{ path }],
    target: { type: "original" },
    mode: "replace",
    reason: "Ticket 9001: restore-replace-not-allowed v1 HTTP regression",
  });

  it("refuses mode 'replace' for an Exchange mailbox target with 422 and the problem type", async () => {
    const res = await post(REPLACE(f.mailbox.second, "mail/Inbox"));
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(await res.json()).toMatchObject({
      status: 422,
      type: "urn:restow:problem:restore-replace-not-allowed",
    });
  });

  it("refuses mode 'replace' for an IMAP target with the same 422 and problem type", async () => {
    const res = await post(REPLACE(f.imap, "mail/INBOX"));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      status: 422,
      type: "urn:restow:problem:restore-replace-not-allowed",
    });
  });

  it("refuses mode 'replace' for a OneDrive target too, and stores nothing", async () => {
    const before = await db.select().from(restoreJobs);
    const res = await post(REPLACE(f.drive, "Documents"));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      status: 422,
      type: "urn:restow:problem:restore-replace-not-allowed",
    });
    expect(await db.select().from(restoreJobs)).toHaveLength(before.length);
  });
});
