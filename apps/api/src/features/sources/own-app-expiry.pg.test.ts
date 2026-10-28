/**
 * Postgres-backed tests of the expiry date of a source's own Graph app: what `connectOwnApp`
 * keeps in the public `sources.config.ownApp` (the secret's date, a certificate's notAfter,
 * never the old credential's reminder mark), and the PATCH that notes the date without the
 * secret (`updateOwnAppExpiry`): only for an own app with a secret, audited, the reminder
 * mark dropped when the date changes (kept for the same date) and every other config field
 * kept.
 *
 * Microsoft is not asked: the token provider and the verification are replaced, the rest
 * (validation, sealing, the source row, the audit chain) is the real code.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_sources_own_app_expiry_test` is recreated there and dropped after). Without it the
 * suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { ConnectionVerification } from "@restow/core";
import { auditLog, createDb, type Database, providers, sources, tenants } from "@restow/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ProblemError } from "../../problem.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import type { Actor, OwnAppInfo, SourceConfigExt } from "./service.js";

vi.mock("@restow/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@restow/core")>();
  class FakeTokenProvider {
    async getToken(): Promise<string> {
      return "token";
    }
    refreshAfterRefusal(): boolean {
      return false;
    }
  }
  return {
    ...actual,
    ClientCredentialsTokenProvider: FakeTokenProvider,
    verifyTenantConnection: async (): Promise<ConnectionVerification> => ({
      checkedAt: new Date().toISOString(),
      tokenAcquired: true,
      tokenError: null,
      permissions: null,
      testCall: null,
      ok: false,
    }),
  };
});

/** Self-signed certificates built in memory (@restow/core test helper, not part of its API). */
const testing = await vi.importActual<{
  createTestCertificate: (options?: { notBefore?: Date; notAfter?: Date }) => {
    combinedPem: string;
  };
}>("../../../../../packages/core/src/entra/testing/certificate.js");

const DATABASE = "restow_sources_own_app_expiry_test";
const CLIENT_ID = "486a2769-5d9c-402a-8a83-c3bc9b980e47";

type Service = typeof import("./service.js");

const actor = (): Actor => ({
  id: randomUUID(),
  email: "admin@contoso.example",
  ip: "192.0.2.10",
  isProviderAdmin: true,
});

describe.skipIf(!testDatabaseAdminUrl)("the expiry date of a source's own app", () => {
  let db: Database;
  let service: Service;
  let tenantId: string;

  async function m365Source(name: string): Promise<string> {
    const created = await service.createSource(db, tenantId, { kind: "m365", name }, actor());
    return created.id;
  }

  async function ownAppOf(id: string): Promise<OwnAppInfo | null | undefined> {
    const [row] = await db
      .select({ config: sources.config })
      .from(sources)
      .where(eq(sources.id, id));
    return (row?.config as SourceConfigExt | undefined)?.ownApp;
  }

  /** One Entra tenant per source, so a second connect is a rotation, not a rebinding. */
  const entraTenants = new Map<string, string>();

  async function connect(id: string, input: Record<string, unknown>) {
    if (!entraTenants.has(id)) {
      entraTenants.set(id, randomUUID());
    }
    return service.connectOwnApp(db, db, tenantId, id, actor(), {
      tenantId: entraTenants.get(id) as string,
      clientId: CLIENT_ID,
      credentialKind: "secret",
      clientSecret: "s3cret-value",
      ...input,
    });
  }

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    db = createDb(url);
    service = await import("./service.js");
    const secretStore = await import("../../lib/secrets.js");
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
    await db.transaction((tx) => secretStore.createTenantKey(tx, tenantId));
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  it("keeps the secret's date on connect, and a rotation drops the old reminder", async () => {
    const id = await m365Source("Secret app");
    const result = await connect(id, { secretExpiresAt: "2027-03-01T00:00:00.000Z" });
    expect(result.source.m365?.ownApp).toMatchObject({
      clientId: CLIENT_ID,
      credentialKind: "secret",
      secretExpiresAt: "2027-03-01T00:00:00.000Z",
      certificateNotAfter: null,
    });

    // The worker's mark of a reminder, written as it writes it.
    await db
      .update(sources)
      .set({
        config: sql`jsonb_set(${sources.config}, '{ownApp,expiryAlert}', ${JSON.stringify({
          expiresAt: "2027-03-01T00:00:00.000Z",
          stage: "soon30",
          at: "2027-01-30T10:00:00.000Z",
        })}::jsonb)`,
      })
      .where(eq(sources.id, id));
    expect((await ownAppOf(id))?.expiryAlert).toMatchObject({ stage: "soon30" });

    // A new secret without a date: unknown, and no mark carried over.
    await connect(id, { clientSecret: "new-s3cret", secretExpiresAt: null });
    const rotated = await ownAppOf(id);
    expect(rotated).toMatchObject({ secretExpiresAt: null, certificateNotAfter: null });
    expect(rotated).not.toHaveProperty("expiryAlert");

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "source.own_app.connected"), eq(auditLog.target, id)))
      .limit(1);
    expect(entry?.details).toMatchObject({ secretExpiresAt: "2027-03-01T00:00:00.000Z" });
  });

  it("keeps a certificate's notAfter and no secret date", async () => {
    const id = await m365Source("Certificate app");
    const notAfter = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000);
    notAfter.setUTCMilliseconds(0);
    const { combinedPem } = testing.createTestCertificate({
      notBefore: new Date(Date.now() - 60 * 60 * 1000),
      notAfter,
    });
    await connect(id, {
      credentialKind: "certificate",
      clientSecret: null,
      certificatePem: combinedPem,
      // Ignored for a certificate: its own end counts.
      secretExpiresAt: "2027-03-01T00:00:00.000Z",
    });
    const info = await ownAppOf(id);
    expect(info).toMatchObject({ credentialKind: "certificate", secretExpiresAt: null });
    expect(Date.parse(info?.certificateNotAfter ?? "")).toBe(notAfter.getTime());

    // The PATCH is for a secret only.
    const refused = await service
      .updateOwnAppExpiry(db, tenantId, id, actor(), "2027-03-01T00:00:00.000Z")
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProblemError);
    expect((refused as ProblemError).status).toBe(409);
  });

  it("notes the date without the secret, drops the mark, keeps the rest and audits it", async () => {
    const id = await m365Source("Old secret app");
    await connect(id, {});
    await db
      .update(sources)
      .set({
        config: sql`jsonb_set(${sources.config}, '{ownApp,expiryAlert}', ${JSON.stringify({
          expiresAt: "2026-11-01T00:00:00.000Z",
          stage: "soon7",
          at: "2026-10-25T10:00:00.000Z",
        })}::jsonb) || '{"entraTenantHint":"contoso.example"}'::jsonb`,
      })
      .where(eq(sources.id, id));
    const before = await ownAppOf(id);

    const dto = await service.updateOwnAppExpiry(
      db,
      tenantId,
      id,
      actor(),
      "2027-11-01T00:00:00.000Z",
    );
    expect(dto.m365?.ownApp?.secretExpiresAt).toBe("2027-11-01T00:00:00.000Z");
    const after = await ownAppOf(id);
    expect(after).not.toHaveProperty("expiryAlert");
    expect(after).toMatchObject({
      clientId: before?.clientId,
      credentialKind: "secret",
      updatedAt: before?.updatedAt,
      updatedBy: before?.updatedBy,
    });
    const [row] = await db
      .select({ config: sources.config })
      .from(sources)
      .where(eq(sources.id, id));
    expect((row?.config as SourceConfigExt | undefined)?.entraTenantHint).toBe("contoso.example");

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "source.own_app.expiry_updated"), eq(auditLog.target, id)))
      .limit(1);
    expect(entry).toMatchObject({ tenantId, targetType: "source" });
    expect(entry?.details).toMatchObject({
      clientId: CLIENT_ID,
      previous: null,
      secretExpiresAt: "2027-11-01T00:00:00.000Z",
    });

    // Clearing it again: unknown.
    await service.updateOwnAppExpiry(db, tenantId, id, actor(), null);
    expect((await ownAppOf(id))?.secretExpiresAt).toBeNull();
  });

  it("keeps the mark when the same date is saved again, drops it for another date", async () => {
    const id = await m365Source("Unchanged date app");
    await connect(id, { secretExpiresAt: "2026-11-15T00:00:00.000Z" });
    const mark = {
      expiresAt: "2026-11-15T00:00:00.000Z",
      stage: "soon30",
      at: "2026-10-20T10:00:00.000Z",
    };
    await db
      .update(sources)
      .set({
        config: sql`jsonb_set(${sources.config}, '{ownApp,expiryAlert}', ${JSON.stringify(mark)}::jsonb)`,
      })
      .where(eq(sources.id, id));

    // Saved unchanged (the dialog fills in the stored date): the stage stays reminded.
    await service.updateOwnAppExpiry(db, tenantId, id, actor(), "2026-11-15T00:00:00.000Z");
    expect(await ownAppOf(id)).toMatchObject({
      secretExpiresAt: "2026-11-15T00:00:00.000Z",
      expiryAlert: mark,
    });

    // Another date: the reminders start over.
    await service.updateOwnAppExpiry(db, tenantId, id, actor(), "2027-05-15T00:00:00.000Z");
    const changed = await ownAppOf(id);
    expect(changed?.secretExpiresAt).toBe("2027-05-15T00:00:00.000Z");
    expect(changed).not.toHaveProperty("expiryAlert");
  });

  it("refuses a source without an own app", async () => {
    const id = await m365Source("Consent source");
    const refused = await service
      .updateOwnAppExpiry(db, tenantId, id, actor(), "2027-03-01T00:00:00.000Z")
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProblemError);
    expect((refused as ProblemError).status).toBe(409);
  });
});
