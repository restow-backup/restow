/**
 * Postgres-backed tests of the Microsoft 365 app registration: saved sealed in
 * the secret store (the ciphertext never contains the secret), read back by
 * the same lookup the worker uses, never returned or audited in the clear, the
 * stored secret kept when a save leaves it out, the connection test against a
 * scripted token endpoint with its result kept for the page, and removal.
 *
 * The API's pools run on the provisioned database roles, as in production
 * (src/testing/database-roles.ts): the registration lives in an
 * installation-level row that only the installation role can read.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_api_msapp_test` is recreated there and
 * dropped after, the roles with it). Without it the suite is skipped.
 */
import { randomBytes } from "node:crypto";
import {
  ENTRA_APP_SECRET_KIND,
  ENTRA_APP_TEST_SECRET_KIND,
  EntraAppResolver,
  REQUIRED_PERMISSIONS,
  deriveInstallationSecretsKey,
  kekFromBase64,
} from "@restow/core";
import {
  type Database,
  auditLog,
  createDb,
  findInstallationSecret,
  secrets,
  settings,
} from "@restow/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestDatabaseRoles, provisionTestRoles } from "../../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../../snapshots/testing/explorer-fixture.js";

const DATABASE = "restow_api_msapp_test";
const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const SECRET = "Q8b~Zx.fixture_secret_value_0123456789ab";
const ROTATED = "R9c~Yw.rotated_secret_value_9876543210zy";

type Service = typeof import("./service.js");

const actor = { id: "provider-admin", email: "admin@provider.test", ip: "192.0.2.10" };
const context = { observedOrigin: null };

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}

describe.skipIf(!testDatabaseAdminUrl)("Microsoft 365 app registration against Postgres", () => {
  let db: Database;
  let appDb: Database;
  let workerDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let service: Service;
  let providerDb: Database;
  const masterKey = randomBytes(32).toString("base64");

  const rows = (kind: string) =>
    db
      .select()
      .from(secrets)
      .where(and(isNull(secrets.tenantId), eq(secrets.kind, kind)));
  const entries = (action: string) =>
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), isNull(auditLog.tenantId)));

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    // The API's shared handles and configuration read the environment on import.
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = masterKey;
    for (const name of ["ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET", "ENTRA_CLIENT_CERT_PATH"]) {
      delete process.env[name];
    }
    db = createDb(url);
    appDb = createDb(roles.appUrl);
    workerDb = createDb(roles.providerUrl);
    await db.insert(settings).values({
      singleton: true,
      operatingMode: "public",
      publicUrl: "https://restow.example.com",
    });
    service = await import("./service.js");
    providerDb = (await import("../../../db.js")).providerDb;
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await Promise.all([db?.$client.end(), appDb?.$client.end(), workerDb?.$client.end()]);
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  it("starts empty", async () => {
    const view = await service.getMicrosoftApp(providerDb, context);
    expect(view).toMatchObject({
      source: "none",
      clientId: null,
      credential: { kind: null, set: false },
      redirectUris: {
        adminConsent: "https://restow.example.com/api/v1/sources/m365/consent/callback",
        signIn: "https://restow.example.com/api/auth/callback/microsoft",
      },
      lastTest: null,
    });
  });

  it("seals the registration and never returns or audits the secret", async () => {
    const view = await service.saveMicrosoftApp(
      providerDb,
      {
        clientId: CLIENT_ID,
        clientSecret: SECRET,
        certificatePem: undefined,
        secretExpiresAt: "2028-09-23T00:00:00.000Z",
        homeTenantId: "contoso.onmicrosoft.com",
        authorityHost: null,
      },
      actor,
      context,
    );
    expect(view).toMatchObject({
      source: "database",
      clientId: CLIENT_ID,
      homeTenantId: "contoso.onmicrosoft.com",
      credential: { kind: "secret", set: true, expiresAt: "2028-09-23T00:00:00.000Z" },
      updatedBy: "admin@provider.test",
    });
    expect(JSON.stringify(view)).not.toContain(SECRET);

    const [row] = await rows(ENTRA_APP_SECRET_KIND);
    expect(row?.tenantId).toBeNull();
    expect(row?.ciphertext).not.toContain(SECRET);
    expect(Buffer.from(row?.ciphertext ?? "", "base64").toString("latin1")).not.toContain(SECRET);

    const [saved] = await entries("settings.microsoft_app.saved");
    expect(saved).toMatchObject({
      actor: "admin@provider.test",
      target: CLIENT_ID,
      targetType: "app_registration",
      ip: "192.0.2.10",
    });
    expect(saved?.details).toMatchObject({ created: true, credentialChanged: true });
    expect(JSON.stringify(saved)).not.toContain(SECRET);
  });

  it("is readable on the installation pool only, the way the worker reads it", async () => {
    // Row Level Security hides installation rows from the application role.
    expect(await findInstallationSecret(appDb, ENTRA_APP_SECRET_KIND)).toBeNull();

    const resolver = new EntraAppResolver({
      environment: {},
      loadStored: () => findInstallationSecret(workerDb, ENTRA_APP_SECRET_KIND),
      installationKey: () => deriveInstallationSecretsKey(kekFromBase64(masterKey)),
    });
    const resolution = await resolver.resolve();
    expect(resolution.status === "ready" && resolution.app.credentials).toEqual({
      clientId: CLIENT_ID,
      credential: { type: "secret", clientSecret: SECRET },
    });
  });

  it("keeps the stored secret when a save leaves it out", async () => {
    await service.saveMicrosoftApp(
      providerDb,
      {
        clientId: CLIENT_ID,
        clientSecret: undefined,
        certificatePem: undefined,
        secretExpiresAt: "2028-09-23T00:00:00.000Z",
        homeTenantId: "fabrikam.onmicrosoft.com",
        authorityHost: null,
      },
      actor,
      context,
    );
    const resolution = await (await import("../../sources/entra.js")).resolveEntraApp();
    expect(resolution.status === "ready" && resolution.app.credentials.credential).toEqual({
      type: "secret",
      clientSecret: SECRET,
    });
    expect(resolution.status === "ready" && resolution.app.homeTenantId).toBe(
      "fabrikam.onmicrosoft.com",
    );
    const saves = await entries("settings.microsoft_app.saved");
    expect(saves).toHaveLength(2);
    expect(saves[1]?.details).toMatchObject({
      created: false,
      changes: ["homeTenantId"],
      credentialChanged: false,
    });
    expect(await rows(ENTRA_APP_SECRET_KIND)).toHaveLength(1);
  });

  it("tests the registration, keeps the result and names the Mail.Read pitfall", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      const roles = [
        ...REQUIRED_PERMISSIONS.filter((permission) => permission !== "Mail.ReadWrite"),
        "Mail.Read",
      ];
      return new Response(JSON.stringify({ access_token: jwt({ roles }), expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await service.testMicrosoftApp(providerDb, { tenantId: null }, actor, {
      fetchImpl,
    });
    expect(asked).toEqual([
      "https://login.microsoftonline.com/fabrikam.onmicrosoft.com/oauth2/v2.0/token",
    ]);
    expect(result).toMatchObject({
      ok: false,
      tokenAcquired: true,
      reason: "permissions_missing",
      tenantId: "fabrikam.onmicrosoft.com",
      permissions: {
        missing: ["Mail.ReadWrite"],
        readOnlyInstead: [{ expected: "Mail.ReadWrite", granted: "Mail.Read" }],
      },
    });

    const view = await service.getMicrosoftApp(providerDb, context);
    expect(view.lastTest?.checkedAt).toBe(result.checkedAt);
    const [test] = await rows(ENTRA_APP_TEST_SECRET_KIND);
    expect(test?.ciphertext).not.toContain("Mail.ReadWrite");
    const [tested] = await entries("settings.microsoft_app.tested");
    expect(tested?.details).toMatchObject({ ok: false, reason: "permissions_missing" });
    expect(JSON.stringify(tested)).not.toContain(SECRET);
  });

  it("forgets the last test once another secret is saved", async () => {
    const view = await service.saveMicrosoftApp(
      providerDb,
      {
        clientId: CLIENT_ID,
        clientSecret: ROTATED,
        certificatePem: undefined,
        secretExpiresAt: null,
        homeTenantId: "fabrikam.onmicrosoft.com",
        authorityHost: null,
      },
      actor,
      context,
    );
    expect(view.lastTest).toBeNull();
    expect(view.credential.expiresAt).toBeNull();
    expect(JSON.stringify(view)).not.toContain(ROTATED);
  });

  it("removes the registration and its test", async () => {
    const view = await service.removeMicrosoftApp(providerDb, actor, context);
    expect(view.source).toBe("none");
    expect(await rows(ENTRA_APP_SECRET_KIND)).toHaveLength(0);
    expect(await rows(ENTRA_APP_TEST_SECRET_KIND)).toHaveLength(0);
    const [removed] = await entries("settings.microsoft_app.removed");
    expect(removed?.details).toEqual({ clientId: CLIENT_ID, credentialKind: "secret" });

    // Removing again changes nothing and writes no second entry.
    await service.removeMicrosoftApp(providerDb, actor, context);
    expect(await entries("settings.microsoft_app.removed")).toHaveLength(1);
  });

  it("refuses a test while nothing is saved", async () => {
    const error = await service
      .testMicrosoftApp(providerDb, { tenantId: "contoso.com" }, actor)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      status: 409,
      type: "urn:restow:problem:microsoft-app-not-configured",
    });
  });
});
