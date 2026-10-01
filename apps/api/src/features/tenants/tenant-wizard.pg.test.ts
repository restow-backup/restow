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
import {
  type Database,
  auditLog,
  createDb,
  organization,
  providers,
  tenantContacts,
  tenantKeys,
  tenantNotificationRecipients,
  tenants,
  user,
} from "@restow/db";
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerApiExtension, resetExtensionsForTesting } from "../../extensions.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { createTenantSchema } from "./schemas.js";
import type { Actor } from "./service.js";

const DATABASE = "restow_api_tenant_wizard_test";

type Service = typeof import("./service.js");

function slug(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

describe.skipIf(!testDatabaseAdminUrl)("the tenant wizard against Postgres", () => {
  let owner: Database;
  let db: Database;
  let providerDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let service: Service;
  /** What the test gate answers for every gated function. */
  let featuresOn = true;
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
    // Several scenarios below need more than one tenant and the weekly report,
    // which the core alone (no extension enabling them) would refuse: a test
    // feature gate stands in for that extension (lib/features.ts).
    registerApiExtension({
      name: "test-gate",
      featureGate: { isEnabled: async () => featuresOn },
    });
    owner = createDb(url);
    db = createDb(roles.appUrl);
    providerDb = createDb(roles.providerUrl);
    await owner.insert(providers).values({ name: "Provider" });
    await owner
      .insert(user)
      .values({ id: actor.id, name: "Ops", email: actor.email, emailVerified: true });
    service = await import("./service.js");
  }, 60_000);

  afterAll(async () => {
    resetExtensionsForTesting();
    // auth.ts (better-auth's drizzle adapter) holds its own connection on the
    // shared db.ts singletons, bound to the roles this suite provisioned.
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await owner?.$client.end();
    await db?.$client.end();
    await providerDb?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  it("creates the first tenant without any extension, and refuses a second one", async () => {
    featuresOn = false;
    try {
      const first = await service.createTenant(
        db,
        providerDb,
        createTenantSchema.parse({ name: "First", slug: slug("first") }),
        actor,
      );
      expect(first.name).toBe("First");
      const before = await tenantCount();
      await expect(
        service.createTenant(
          db,
          providerDb,
          createTenantSchema.parse({ name: "Second", slug: slug("second") }),
          actor,
        ),
      ).rejects.toMatchObject({
        status: 403,
        type: "urn:restow:problem:feature-unavailable",
        extensions: { feature: "tenants.additional" },
      });
      expect(await tenantCount()).toBe(before);
    } finally {
      featuresOn = true;
    }
  });

  async function tenantCount(): Promise<number> {
    const [row] = await owner.select({ value: count() }).from(tenants);
    return row?.value ?? 0;
  }

  it("creates the tenant with its customer data, contacts and notification recipients in one flow", async () => {
    // Parsed through the real request schema, like the route handler does:
    // proves the wizard's payload validates and that the country code is
    // upper-cased before it reaches the service.
    const input = createTenantSchema.parse({
      name: "Contoso GmbH",
      slug: slug("contoso"),
      customer: {
        customerNumber: "K-1001",
        vatId: "DE123456789",
        addressLine1: "Hauptstrasse 1",
        city: "Bergisch Gladbach",
        postalCode: "51465",
        countryCode: "de",
        language: "de",
        timeZone: "Europe/Berlin",
      },
      contacts: [
        {
          name: "Alice Admin",
          role: "IT contact",
          email: "alice@contoso.example",
          isPrimary: true,
        },
        { name: "Bob Billing", email: "bob@contoso.example", isPrimary: false },
      ],
      notificationRecipients: [
        { email: "alerts@contoso.example", categories: ["jobFailures", "readinessRed"] },
      ],
    });
    const created = await service.createTenant(db, providerDb, input, actor);

    const detail = await service.getTenant(db, created.id);
    expect(detail.customer).toMatchObject({
      customerNumber: "K-1001",
      vatId: "DE123456789",
      city: "Bergisch Gladbach",
      // The schema upper-cases the country code.
      countryCode: "DE",
      language: "de",
      timeZone: "Europe/Berlin",
    });
    expect(detail.contacts).toHaveLength(2);
    const primary = detail.contacts.find((contact) => contact.isPrimary);
    expect(primary?.name).toBe("Alice Admin");
    expect(detail.contacts.filter((contact) => contact.isPrimary)).toHaveLength(1);
    expect(detail.notificationRecipients).toEqual([
      expect.objectContaining({
        email: "alerts@contoso.example",
        categories: ["jobFailures", "readinessRed"],
      }),
    ]);

    // The creation audit entry names the contacts and recipients by id, not
    // by their personal data (name, e-mail, phone).
    const [createdEvent] = await owner
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, created.id), eq(auditLog.action, "tenant.created")));
    const details = createdEvent?.details as {
      contactIds?: string[];
      recipientIds?: string[];
    };
    expect(details.contactIds).toHaveLength(2);
    expect(new Set(details.contactIds)).toEqual(new Set(detail.contacts.map((c) => c.id)));
    expect(details.recipientIds).toHaveLength(1);
    expect(new Set(details.recipientIds)).toEqual(
      new Set(detail.notificationRecipients.map((r) => r.id)),
    );
    expect(JSON.stringify(details)).not.toContain("alice@contoso.example");
  });

  it("refuses a duplicate customer number (case-insensitively) and creates nothing", async () => {
    const before = await tenantCount();
    const fabrikamSlug = slug("fabrikam");
    await expect(
      service.createTenant(
        db,
        providerDb,
        // Same customer number as the tenant above, different case.
        { name: "Fabrikam Inc", slug: fabrikamSlug, customer: { customerNumber: "k-1001" } },
        actor,
      ),
    ).rejects.toMatchObject({
      status: 409,
      type: "urn:restow:problem:customer-number-taken",
    });
    expect(await tenantCount()).toBe(before);
    const [leftover] = await owner.select().from(tenants).where(eq(tenants.slug, fabrikamSlug));
    expect(leftover).toBeUndefined();
  });

  it("creates nothing when a failure happens deep inside the create transaction", async () => {
    // Bypasses createTenantSchema's own "no duplicate recipient address" check
    // (calling the service directly, the way the pre-check above cannot) to
    // reach the database's case-insensitive unique index
    // (tenant_notification_recipients_tenant_email_uq) only once the
    // organization, the tenant row and its encryption key already exist
    // inside the same transaction. Proves the whole create — not just the
    // pre-checks — rolls back together.
    const before = await tenantCount();
    const [keysBefore] = await owner.select({ value: count() }).from(tenantKeys);
    const [contactsBefore] = await owner.select({ value: count() }).from(tenantContacts);
    const [recipientsBefore] = await owner
      .select({ value: count() })
      .from(tenantNotificationRecipients);
    const [auditBefore] = await owner.select({ value: count() }).from(auditLog);
    const failSlug = slug("initech");

    await expect(
      service.createTenant(
        db,
        providerDb,
        {
          name: "Initech",
          slug: failSlug,
          contacts: [{ name: "Peter", isPrimary: true }],
          notificationRecipients: [
            { email: "ops@initech.example", categories: ["jobFailures"] },
            { email: "OPS@initech.example", categories: ["weeklyReport"] },
          ],
        },
        actor,
      ),
    ).rejects.toThrow();

    expect(await tenantCount()).toBe(before);
    const [leftoverTenant] = await owner.select().from(tenants).where(eq(tenants.slug, failSlug));
    expect(leftoverTenant).toBeUndefined();
    const [leftoverOrg] = await owner
      .select()
      .from(organization)
      .where(eq(organization.slug, failSlug));
    expect(leftoverOrg).toBeUndefined();
    const [keysAfter] = await owner.select({ value: count() }).from(tenantKeys);
    const [contactsAfter] = await owner.select({ value: count() }).from(tenantContacts);
    const [recipientsAfter] = await owner
      .select({ value: count() })
      .from(tenantNotificationRecipients);
    const [auditAfter] = await owner.select({ value: count() }).from(auditLog);
    expect(keysAfter?.value).toBe(keysBefore?.value);
    expect(contactsAfter?.value).toBe(contactsBefore?.value);
    expect(recipientsAfter?.value).toBe(recipientsBefore?.value);
    expect(auditAfter?.value).toBe(auditBefore?.value);
  });

  it("rolls back a contact replace that would leave two primary contacts", async () => {
    const tenant = await service.createTenant(
      db,
      providerDb,
      { name: "Northwind", slug: slug("northwind"), contacts: [{ name: "Nora", isPrimary: true }] },
      actor,
    );

    // Bypasses the wizard's own "exactly one primary" schema check to prove
    // the database's partial unique index (tenant_contacts_tenant_primary_uq)
    // is a real backstop: the delete-then-insert of the whole set rolls back
    // together, so the tenant keeps its original, valid contact.
    await expect(
      service.replaceTenantContacts(
        db,
        tenant.id,
        [
          { name: "A", isPrimary: true },
          { name: "B", isPrimary: true },
        ],
        actor,
      ),
    ).rejects.toThrow();

    const detail = await service.getTenant(db, tenant.id);
    expect(detail.contacts).toHaveLength(1);
    expect(detail.contacts[0]?.name).toBe("Nora");
  });

  it("refuses a duplicate customer number on an edit and leaves the tenant unchanged", async () => {
    const holder = await service.createTenant(
      db,
      providerDb,
      { name: "Holder", slug: slug("holder"), customer: { customerNumber: "K-2002" } },
      actor,
    );
    const other = await service.createTenant(
      db,
      providerDb,
      { name: "Other", slug: slug("other") },
      actor,
    );

    await expect(
      service.updateTenantCustomer(db, providerDb, other.id, { customerNumber: "k-2002" }, actor),
    ).rejects.toMatchObject({ status: 409, type: "urn:restow:problem:customer-number-taken" });

    const detail = await service.getTenant(db, other.id);
    expect(detail.customer.customerNumber).toBeNull();
    const holderDetail = await service.getTenant(db, holder.id);
    expect(holderDetail.customer.customerNumber).toBe("K-2002");
  });
});
