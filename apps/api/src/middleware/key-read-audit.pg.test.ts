/**
 * Postgres-backed test of the read audit of API keys on the feature routes
 * they share with the web UI: a key reads a protected object's snapshots
 * through the jobs feature (`GET /api/v1/jobs/objects/:id/snapshots`, a path
 * the integration API does not serve), and the read lands in the tenant's
 * audit chain under the integration API's action name, written by the
 * application role that Row Level Security binds.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_api_key_read_audit_test` is recreated there
 * and dropped after, the roles with it). Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  type Database,
  auditLog,
  createDb,
  protectedObjects,
  providers,
  sources,
  tenants,
  user,
} from "@restow/db";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../features/snapshots/testing/explorer-fixture.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../testing/database-roles.js";

const DATABASE = "restow_api_key_read_audit_test";

describe.skipIf(!testDatabaseAdminUrl)("API-key reads on feature routes against Postgres", () => {
  let db: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let tenantId: string;
  let objectId: string;
  let token: string;
  let keyId: string;
  let verifyAuditChain: typeof import("../lib/audit.js").verifyAuditChain;

  const chain = () =>
    db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenantId))
      .orderBy(asc(auditLog.createdAt), asc(auditLog.id));

  const reads = () =>
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, "api.objects.read")));

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    // The API's shared handles and configuration read the environment on import.
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    db = createDb(url);

    const keys = await import("../features/apikeys/service.js");
    const { jobsRoutes } = await import("../features/jobs/routes.js");
    const { errorHandler } = await import("../problem.js");
    ({ verifyAuditChain } = await import("../lib/audit.js"));

    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({ providerId: provider?.id ?? "", name: "Contoso", slug: "contoso-gmbh" })
      .returning();
    tenantId = tenant?.id ?? "";
    const [source] = await db
      .insert(sources)
      .values({ tenantId, kind: "m365", name: "Contoso M365", status: "active" })
      .returning();
    const [object] = await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId: source?.id ?? "",
        kind: "mailbox",
        externalId: "ada@contoso.example",
        displayName: "Ada",
      })
      .returning();
    objectId = object?.id ?? "";

    const adminId = randomUUID();
    await db.insert(user).values({
      id: adminId,
      name: "Admin",
      email: "admin@contoso.example",
      emailVerified: true,
    });
    const created = await keys.createKey(
      db,
      { kind: "tenant", tenantId },
      { name: "RMM", scopes: ["items:read"], expiresInDays: null },
      { userId: adminId, label: "admin@contoso.example", ip: "192.0.2.10" },
    );
    token = created.token;
    keyId = created.id;

    app = new Hono();
    app.onError(errorHandler);
    app.route("/api/v1/jobs", jobsRoutes);
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  const asKey = (path: string) =>
    app.request(path, {
      headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.7" },
    });

  it("records the read in the tenant's audit chain", async () => {
    const res = await asKey(`/api/v1/jobs/objects/${objectId}/snapshots?limit=5`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { object: { id: string } }).object.id).toBe(objectId);

    const [entry, ...more] = await reads();
    expect(more).toHaveLength(0);
    expect(entry).toMatchObject({
      tenantId,
      actor: `api-key:${keyId}`,
      actorUserId: null,
      action: "api.objects.read",
      target: objectId,
      targetType: "protected_object",
      ip: "203.0.113.7",
    });
    expect(entry?.details).toEqual({
      keyId,
      route: "GET /api/v1/jobs/objects/:id/snapshots",
      filters: { limit: "5" },
    });
    expect(verifyAuditChain(await chain()).ok).toBe(true);
  });

  it("records nothing for a read that found nothing", async () => {
    const before = (await reads()).length;
    const res = await asKey(`/api/v1/jobs/objects/${randomUUID()}/snapshots`);
    expect(res.status).toBe(404);
    expect(await reads()).toHaveLength(before);
  });
});
