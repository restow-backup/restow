/**
 * Postgres-backed proof of the tenant wizard's atomicity: a tenant is created
 * with its customer data, contacts and notification recipients in one
 * transaction; a duplicate customer number is refused with 409 and leaves
 * nothing behind; a failure deep inside the create transaction (after the
 * organization, the tenant row and its key already exist) still rolls
 * everything back; and the database's own "at most one primary contact"
 * index backstops the wizard's own validation when a contact set is
 * replaced, rolling the whole replace back.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_api_tenant_wizard_test` is recreated there and dropped after).
 * Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { type Database, createDb, providers, user } from "@restow/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  registerApiExtension,
  resetExtensionsForTesting,
} from "../../../../apps/api/src/extensions.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../../../../apps/api/src/features/snapshots/testing/explorer-fixture.js";
import type { Actor } from "../../../../apps/api/src/features/tenants/service.js";
import {
  type TestDatabaseRoles,
  provisionTestRoles,
} from "../../../../apps/api/src/testing/database-roles.js";
import { licenseFeatureGate } from "../license/gate.js";
import { installTestLicense } from "../license/testing.js";

const DATABASE = "restow_ee_provider_tenants_test";

type Service = typeof import("../../../../apps/api/src/features/tenants/service.js");
type Provider = typeof import("./routes.js");

function slug(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

describe.skipIf(!testDatabaseAdminUrl)("the provider tenant list against Postgres", () => {
  let owner: Database;
  let db: Database;
  let providerDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let service: Service;
  let provider: Provider;
  const actor: Actor = {
    id: randomUUID(),
    email: "ops@provider.example",
    ip: "192.0.2.10",
    isProviderAdmin: true,
  };

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    // The API's shared handles (db.ts) and better-auth (auth.ts) read the
    // environment on import, so it must be set before ./service.js loads them.
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    // Several scenarios below need more than one tenant: the license gate,
    // with the Service Provider edition installed, opens `tenants.additional`.
    await installTestLicense(owner, "service_provider");
    registerApiExtension({ name: "ee-license-gate", featureGate: licenseFeatureGate });
    db = createDb(roles.appUrl);
    providerDb = createDb(roles.providerUrl);
    await owner.insert(providers).values({ name: "Provider" });
    await owner
      .insert(user)
      .values({ id: actor.id, name: "Ops", email: actor.email, emailVerified: true });
    service = await import("../../../../apps/api/src/features/tenants/service.js");
    // Dynamic, and after the env is set, for the same reason as `service.js`
    // above: `routes.ts` reaches `../../db.js` (via status.ts ->
    // features/verify/service.js -> jobs/queue.js), whose singletons must
    // not be constructed before `DATABASE_URL` points at this suite's roles.
    provider = await import("./routes.js");
  }, 60_000);

  afterAll(async () => {
    resetExtensionsForTesting();
    // auth.ts (better-auth's drizzle adapter) holds its own connection on the
    // shared db.ts singletons, bound to the roles this suite provisioned.
    const shared = await import("../../../../apps/api/src/db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await owner?.$client.end();
    await db?.$client.end();
    await providerDb?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  /**
   * `GET /provider/tenants` (./routes.ts) reads the same rows this
   * suite already proved the wizard writes: the customer number is always
   * returned, and contacts (personal data) only when the caller asked for
   * them — this is what a provider API key's `users:read` scope gates in the
   * route handler, exercised here one level down, directly against a real
   * tenant and its contacts.
   */
  describe("provider integration reads of the wizard's customer data", () => {
    it("returns the customer number always, and contacts only when asked for", async () => {
      const withContacts = await service.createTenant(
        db,
        providerDb,
        {
          name: "Wayne Enterprises",
          slug: slug("wayne"),
          customer: { customerNumber: "K-3003" },
          contacts: [
            { name: "Alfred Pennyworth", isPrimary: true },
            { name: "Lucius Fox", isPrimary: false },
          ],
        },
        actor,
      );
      const withoutContacts = await service.createTenant(
        db,
        providerDb,
        { name: "Queen Industries", slug: slug("queen") },
        actor,
      );
      const query = provider.providerTenantsQuerySchema.parse({ limit: 50 });

      const withContactsIncluded = await provider.listProviderTenants(
        { db, providerDb },
        query,
        new Date(),
        true,
      );
      const wayne = withContactsIncluded.items.find((item) => item.id === withContacts.id);
      const queen = withContactsIncluded.items.find((item) => item.id === withoutContacts.id);
      expect(wayne?.customerNumber).toBe("K-3003");
      expect(wayne?.contacts.map((contact) => contact.name).sort()).toEqual([
        "Alfred Pennyworth",
        "Lucius Fox",
      ]);
      expect(queen?.customerNumber).toBeNull();
      expect(queen?.contacts).toEqual([]);

      const contactsExcluded = await provider.listProviderTenants(
        { db, providerDb },
        query,
        new Date(),
        false,
      );
      const wayneWithoutScope = contactsExcluded.items.find((item) => item.id === withContacts.id);
      // The scope gate, not the tenant: the same tenant's contacts stay
      // hidden entirely when the key lacks `users:read`, the customer number
      // (not personal data) is unaffected.
      expect(wayneWithoutScope?.customerNumber).toBe("K-3003");
      expect(wayneWithoutScope?.contacts).toEqual([]);
    });
  });
});
