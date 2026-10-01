/**
 * A refused action lands in the real audit chain: the tenant's when the
 * request had one, the installation's otherwise, with the chain intact.
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server.
 */
import { randomUUID } from "node:crypto";
import { type Database, auditLog, createDb, providers, tenants } from "@restow/db";
import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../features/snapshots/testing/explorer-fixture.js";
import { verifyAuditChain } from "./audit.js";
import { recordDenied } from "./denied-audit.js";

const DATABASE = "restow_api_denied_audit_test";

describe.skipIf(!testDatabaseAdminUrl)("refused actions in the audit log", () => {
  let db: Database;
  let tenantId: string;

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    db = createDb(url);
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({
        providerId: provider?.id as string,
        name: "Contoso",
        slug: `contoso-${randomUUID().slice(0, 8)}`,
      })
      .returning();
    tenantId = tenant?.id as string;
  });

  afterAll(async () => {
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  it("appends to the tenant's chain and to the installation's, both verifiable", async () => {
    const base = {
      userId: "user-1",
      actor: "tech@provider.example",
      method: "DELETE",
      route: "/api/v1/tenants/:id",
      reason: "Insufficient role",
      ip: "192.0.2.7",
    };
    await recordDenied(db, { ...base, tenantId });
    await recordDenied(db, { ...base, tenantId: null, reason: "Provider role required" });

    const tenantChain = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenantId))
      .orderBy(auditLog.createdAt);
    expect(tenantChain).toHaveLength(1);
    expect(tenantChain[0]).toMatchObject({
      action: "access.denied",
      actor: "tech@provider.example",
      actorUserId: "user-1",
      target: "DELETE /api/v1/tenants/:id",
      targetType: "route",
      ip: "192.0.2.7",
      details: { reason: "Insufficient role" },
    });
    expect(verifyAuditChain(tenantChain).ok).toBe(true);

    const installation = await db
      .select()
      .from(auditLog)
      .where(isNull(auditLog.tenantId))
      .orderBy(auditLog.createdAt);
    expect(installation.map((entry) => entry.details)).toEqual([
      { reason: "Provider role required" },
    ]);
    expect(verifyAuditChain(installation).ok).toBe(true);
  });
});
