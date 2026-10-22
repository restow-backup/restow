/**
 * Postgres-backed tests of the license module: installing and removing keys
 * (signed with a throwaway test key) together with their audit entries, and
 * the gate following the installed key.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_api_license_test` is recreated there and dropped after). Without it
 * the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  auditLog,
  createDb,
  type Database,
  license,
  protectedObjects,
  providers,
  settings,
  sources,
  tenants,
  users,
} from "@restow/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../../../../apps/api/src/features/snapshots/testing/explorer-fixture.js";
import { ProblemError } from "../../../../apps/api/src/problem.js";
import { LICENSE_PUBLIC_KEY_ENV } from "../../../licensing/src/index.js";
import { createTestLicenseSigner } from "../../../licensing/testing/test-signer.mjs";

const DATABASE = "restow_api_license_test";

type Service = typeof import("./service.js");
type GateModule = typeof import("./gate.js");

const vendor = createTestLicenseSigner();
const actor = { id: "admin-user", email: "admin@provider.test", ip: "192.0.2.10" };

function one<T>(rows: readonly T[]): T {
  const [first] = rows;
  if (first === undefined) {
    throw new Error("insert returned no row");
  }
  return first;
}

interface Fixture {
  installationId: string;
  contoso: string;
  fabrikam: string;
}

/**
 * Contoso: Anna (mailbox + OneDrive = 1), Ben (OneDrive only = 1), Carl
 * (excluded mailbox, orphaned OneDrive = 0), a shared mailbox (1) and an IMAP
 * account (1) = 4. Fabrikam (cap 3): two mailboxes = 2. A tenant being deleted
 * counts nothing. Installation total: 6.
 */
async function seed(db: Database): Promise<Fixture> {
  const provider = one(await db.insert(providers).values({ name: "Provider" }).returning());
  const installation = one(await db.insert(settings).values({ singleton: true }).returning());

  const tenant = async (name: string, extra: Partial<typeof tenants.$inferInsert> = {}) =>
    one(
      await db
        .insert(tenants)
        .values({
          providerId: provider.id,
          name,
          slug: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}`,
          ...extra,
        })
        .returning(),
    ).id;

  const contoso = await tenant("Contoso");
  const fabrikam = await tenant("Fabrikam", { mailboxCap: 3 });
  const leaving = await tenant("Leaving", { status: "deleting" });

  const source = async (tenantId: string, kind: "m365" | "imap") =>
    one(
      await db
        .insert(sources)
        .values({ tenantId, kind, name: `${kind}-${randomUUID().slice(0, 6)}`, status: "active" })
        .returning(),
    ).id;

  const person = async (tenantId: string, email: string) =>
    one(await db.insert(users).values({ tenantId, email }).returning()).id;

  const protect = async (
    tenantId: string,
    sourceId: string,
    kind: "mailbox" | "onedrive" | "imap",
    userId: string | null,
    status: "active" | "excluded" | "orphaned" = "active",
  ) => {
    await db
      .insert(protectedObjects)
      .values({ tenantId, sourceId, kind, userId, status, externalId: randomUUID() });
  };

  const contosoM365 = await source(contoso, "m365");
  const contosoImap = await source(contoso, "imap");
  const anna = await person(contoso, "anna@contoso.test");
  const ben = await person(contoso, "ben@contoso.test");
  const carl = await person(contoso, "carl@contoso.test");
  await protect(contoso, contosoM365, "mailbox", anna);
  await protect(contoso, contosoM365, "onedrive", anna);
  await protect(contoso, contosoM365, "onedrive", ben);
  await protect(contoso, contosoM365, "mailbox", carl, "excluded");
  await protect(contoso, contosoM365, "onedrive", carl, "orphaned");
  await protect(contoso, contosoM365, "mailbox", null);
  await protect(contoso, contosoImap, "imap", null);

  const fabrikamM365 = await source(fabrikam, "m365");
  await protect(fabrikam, fabrikamM365, "mailbox", null);
  await protect(fabrikam, fabrikamM365, "mailbox", null);

  const leavingM365 = await source(leaving, "m365");
  for (let index = 0; index < 5; index += 1) {
    await protect(leaving, leavingM365, "mailbox", null);
  }

  return { installationId: installation.id, contoso, fabrikam };
}

describe.skipIf(!testDatabaseAdminUrl)("license against Postgres", () => {
  let db: Database;
  let f: Fixture;
  let service: Service;
  let gate: GateModule;

  const keyFor = (keyedEdition: "business" | "service_provider", installationId: string) =>
    vendor.sign({ edition: keyedEdition, licensee: "Example GmbH", installationId });

  const licenseAudit = (action: string) =>
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), isNull(auditLog.tenantId)));

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    // The API's shared handle (db.ts) reads DATABASE_URL on import; the
    // verification key is resolved once per process from the environment.
    process.env.DATABASE_URL = url;
    process.env[LICENSE_PUBLIC_KEY_ENV] = vendor.publicKey;
    // The secret store seals a key entered on the Community build with the master key.
    process.env.RESTOW_MASTER_KEY ??= randomBytes(32).toString("base64");
    db = createDb(url);
    f = await seed(db);
    service = await import("./service.js");
    gate = await import("./gate.js");
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../../../apps/api/src/db.js");
    await shared.db.$client.end();
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  it("describes a keyless installation", async () => {
    const state = await service.getLicenseState(db);
    expect(state).toEqual({
      edition: "community",
      source: "environment",
      environmentEdition: "community",
      installationId: f.installationId,
      key: null,
      verification: expect.objectContaining({ status: "ready", source: "environment" }),
      runAsCommunity: false,
    });
  });

  it("rejects keys for another installation and tampered keys", async () => {
    const foreign = keyFor("business", randomUUID());
    const mismatch = await service.installLicense(db, foreign, actor).catch((e) => e);
    expect(mismatch).toBeInstanceOf(ProblemError);
    expect((mismatch as ProblemError).extensions).toMatchObject({
      reason: "installation_mismatch",
      installationId: f.installationId,
    });

    const [prefix, , signature] = keyFor("business", f.installationId).split(".");
    const forgedPayload = Buffer.from('{"edition":"service_provider"}').toString("base64url");
    const tampered = await service
      .installLicense(db, `${prefix}.${forgedPayload}.${signature}`, actor)
      .catch((e) => e);
    expect((tampered as ProblemError).extensions).toEqual({ reason: "bad_signature" });
    expect(await db.select().from(license)).toHaveLength(0);
  });

  it("installs a key, audits it, and the spine's edition gating follows", async () => {
    const state = await service.installLicense(db, keyFor("business", f.installationId), actor);
    expect(state).toMatchObject({
      edition: "business",
      source: "key",
      environmentEdition: "community",
      key: { licensee: "Example GmbH", installationId: f.installationId },
    });
    expect(state.key?.keyId).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    expect(await gate.currentEdition(db)).toBe("business");
    expect(await gate.hasCapability(db, "archive.legalHold")).toBe(true);
    expect(await gate.licenseFeatureGate.isEnabled(db, "tenants.additional")).toBe(false);

    const [entry] = await licenseAudit("license.installed");
    expect(entry).toMatchObject({
      actor: actor.email,
      actorUserId: actor.id,
      target: f.installationId,
      targetType: "installation",
      ip: actor.ip,
    });
    expect(entry?.details).toMatchObject({
      edition: "business",
      previousEdition: "community",
      mailboxesInUse: 6,
      tenants: 2,
    });
  });

  it("treats installing the active key again as a no-op", async () => {
    const token = keyFor("business", f.installationId);
    await service.installLicense(db, token, actor);
    const before = (await licenseAudit("license.installed")).length;
    await service.installLicense(db, token, actor);
    expect(await licenseAudit("license.installed")).toHaveLength(before);
    expect(await db.select().from(license).where(eq(license.active, true))).toHaveLength(1);
  });

  it("replaces the active key with a new one of another edition", async () => {
    const state = await service.installLicense(
      db,
      keyFor("service_provider", f.installationId),
      actor,
    );
    expect(state).toMatchObject({ edition: "service_provider", source: "key" });
    expect(await gate.licenseFeatureGate.isEnabled(db, "tenants.additional")).toBe(true);
    expect(await db.select().from(license).where(eq(license.active, true))).toHaveLength(1);
    const entry = (await licenseAudit("license.replaced")).find(
      (row) => (row.details as { edition?: string } | null)?.edition === "service_provider",
    );
    expect(entry?.details).toMatchObject({
      edition: "service_provider",
      previousEdition: "business",
      entitlement: { entitled: true },
    });
  });

  it("removes the key, falls back to the environment and audits the removal", async () => {
    const state = await service.removeLicense(db, actor);
    expect(state).toMatchObject({ edition: "community", source: "environment", key: null });
    expect(await gate.currentEdition(db)).toBe("community");
    const [entry] = await licenseAudit("license.removed");
    expect(entry?.details).toMatchObject({
      edition: "service_provider",
      fallbackEdition: "community",
    });

    const again = await service.removeLicense(db, actor).catch((e) => e);
    expect((again as ProblemError).status).toBe(404);
  });

  it("accepts a key an older issuer gave a mailbox_limit, and the value has no effect", async () => {
    const legacy = vendor.signPayload({
      ...vendor.payload({
        edition: "business",
        licensee: "Legacy GmbH",
        installationId: f.installationId,
      }),
      mailbox_limit: 5,
    });
    const state = await service.installLicense(db, legacy, actor);
    expect(state).toMatchObject({ edition: "business", source: "key" });
    const [row] = await db.select().from(license).where(eq(license.active, true));
    expect(row?.mailboxLimit).toBeNull();
  });

  describe("update periods (0.4.5)", () => {
    const releaseEnv = { RESTOW_VERSION: "1.8.0", RESTOW_RELEASED_AT: "2028-03-01T09:00:00Z" };
    const withEnv = async <T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> => {
      const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
      Object.assign(process.env, env);
      try {
        return await run();
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    };
    const periodKey = (
      updatesUntil: string,
      edition: "business" | "service_provider" = "business",
    ) =>
      vendor.sign({
        edition,
        licensee: "Example GmbH",
        installationId: f.installationId,
        series: "1",
        updatesUntil,
      });

    it("replaces a still valid key of the same edition (a renewal) and keeps the history", async () => {
      await service.installLicense(db, keyFor("business", f.installationId), actor);
      const rowsBefore = (await db.select().from(license)).length;
      const state = await service.installLicense(db, periodKey("2027-11-30"), actor);
      expect(state.key?.updates).toEqual({
        series: "1",
        until: "2027-11-30",
        coversRunning: true,
        reason: "development_build",
      });
      const rows = await db.select().from(license);
      expect(rows).toHaveLength(rowsBefore + 1);
      expect(rows.filter((row) => row.active)).toHaveLength(1);
      expect(rows.find((row) => row.active)).toMatchObject({
        edition: "business",
        series: "1",
        updatesUntil: "2027-11-30",
        signingKeyId: null,
      });
      const entry = (await licenseAudit("license.replaced")).find(
        (row) => (row.details as { updatesUntil?: string } | null)?.updatesUntil === "2027-11-30",
      );
      expect(entry?.details).toMatchObject({
        edition: "business",
        previousEdition: "business",
        series: "1",
        updatesUntil: "2027-11-30",
        previousUpdates: { series: "1", updatesUntil: null },
        entitlement: { entitled: true, reason: "development_build" },
      });
    });

    it("refuses a key whose update period ended before the running release", async () => {
      const refused = await withEnv(releaseEnv, () =>
        service.installLicense(db, periodKey("2027-11-30", "service_provider"), actor),
      ).catch((e) => e);
      expect(refused).toBeInstanceOf(ProblemError);
      expect((refused as ProblemError).extensions).toMatchObject({
        reason: "outside_update_period",
        updatesUntil: "2027-11-30",
        version: "1.8.0",
      });
      // The key in effect stays.
      expect(await gate.currentEdition(db)).toBe("business");
    });

    it("installs a renewal that covers the running release", async () => {
      const state = await withEnv(releaseEnv, () =>
        service.installLicense(db, periodKey("2028-11-30"), actor),
      );
      expect(state.key?.updates).toMatchObject({ until: "2028-11-30", coversRunning: true });
    });

    it("runs a release the key does not cover as Community with RESTOW_RUN_AS_COMMUNITY", async () => {
      await service.installLicense(db, periodKey("2027-11-30"), actor);
      const state = await withEnv({ ...releaseEnv, RESTOW_RUN_AS_COMMUNITY: "1" }, () =>
        service.getLicenseState(db),
      );
      expect(state).toMatchObject({ edition: "community", runAsCommunity: true });
      expect(state.key?.updates).toMatchObject({ until: "2027-11-30", coversRunning: false });
      expect(
        await withEnv({ ...releaseEnv, RESTOW_RUN_AS_COMMUNITY: "1" }, () =>
          gate.currentEdition(db),
        ),
      ).toBe("community");
      // Without the variable nothing changes at runtime.
      expect(await withEnv(releaseEnv, () => gate.currentEdition(db))).toBe("business");
    });

    it("tells the update check which releases the key covers", async () => {
      const { licenseUpdateCoverage } = await import("./coverage.js");
      await service.installLicense(db, periodKey("2027-11-30"), actor);
      const coverage = await licenseUpdateCoverage(db);
      expect(coverage).toMatchObject({ coveredUntil: "2027-11-30", series: "1" });
      expect(coverage?.covers({ version: "1.6.0", releasedAt: "2027-11-30T23:00:00Z" })).toBe(true);
      expect(coverage?.covers({ version: "1.7.0", releasedAt: "2027-12-01T00:00:00Z" })).toBe(
        false,
      );
      // Running as Community already: nothing further to hold back.
      expect(
        await withEnv({ ...releaseEnv, RESTOW_RUN_AS_COMMUNITY: "1" }, () =>
          licenseUpdateCoverage(db),
        ),
      ).toBeNull();
    });

    it("lets the start check refuse that release before any migration, and only that one", async () => {
      const { runStartupLicenseCheck } = await import("./startup-check.js");
      const url = process.env.DATABASE_URL as string;
      const logs: string[] = [];
      const log = (_level: string, message: string) => {
        logs.push(message);
      };
      const check = (env: Record<string, string>) =>
        runStartupLicenseCheck({ DATABASE_MIGRATION_URL: url, ...env }, { log });
      expect(await check(releaseEnv)).toBe(1);
      expect(logs.at(-1)).toContain("2027-11-30");
      expect(await check({ ...releaseEnv, RESTOW_RUN_AS_COMMUNITY: "1" })).toBe(0);
      expect(
        await check({ RESTOW_VERSION: "1.6.0", RESTOW_RELEASED_AT: "2027-11-30T12:00:00Z" }),
      ).toBe(0);
      expect(await check({})).toBe(0);
      // A beta licence starts every 1.x release.
      await service.installLicense(db, keyFor("business", f.installationId), actor);
      expect(await check(releaseEnv)).toBe(0);
    });
  });

  describe("a key entered on the Community build", () => {
    const pending = () => import("../../../../apps/api/src/lib/pending-license-key.js");

    it("is verified and installed by the full build, then removed", async () => {
      const { storePendingLicenseKey, hasPendingLicenseKey } = await pending();
      await service.removeLicense(db, actor).catch(() => undefined);
      const token = keyFor("service_provider", f.installationId);
      // Wrapped by a mail client: whitespace does not matter.
      await storePendingLicenseKey(db, `${token.slice(0, 30)}\n  ${token.slice(30)}`);
      expect(await service.applyPendingLicenseKey(db)).toBe("installed");
      expect(await hasPendingLicenseKey(db)).toBe(false);
      expect(await gate.currentEdition(db)).toBe("service_provider");
      const entries = await licenseAudit("license.installed");
      expect(entries.at(-1)).toMatchObject({ actor: "system", actorUserId: null });
      expect(await service.applyPendingLicenseKey(db)).toBe("none");
    });

    it("is dropped, and the rejection audited, when it does not verify", async () => {
      const { storePendingLicenseKey, hasPendingLicenseKey } = await pending();
      await storePendingLicenseKey(db, keyFor("business", randomUUID()));
      expect(await service.applyPendingLicenseKey(db)).toBe("rejected");
      expect(await hasPendingLicenseKey(db)).toBe(false);
      const [entry] = await licenseAudit("license.pending_key.rejected");
      expect(entry?.details).toEqual({ reason: "installation_mismatch" });
      // The installed key stays in effect.
      expect(await gate.currentEdition(db)).toBe("service_provider");
    });

    it("is picked up when the license page is opened", async () => {
      const { storePendingLicenseKey } = await pending();
      await storePendingLicenseKey(db, keyFor("business", f.installationId));
      expect(await service.getLicenseState(db)).toMatchObject({
        edition: "business",
        source: "key",
      });
    });
  });
});
