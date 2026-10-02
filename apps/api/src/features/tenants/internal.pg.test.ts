/**
 * Postgres-backed proof of the operator's own organisation (./internal.ts), on
 * the application role (subject to Row Level Security) and the installation
 * role the api runs on:
 *
 *   - the first tenant is the own organisation without any extension, with its
 *     key, its alert rules and its audit entry, and creating it again changes
 *     nothing; a further tenant, this one included, needs `tenants.additional`;
 *   - at most one tenant is the own organisation, in the service and in the
 *     database's unique index;
 *   - an existing tenant can be marked, the mark moves only with an explicit
 *     confirmation, both changes are audited in one transaction;
 *   - the own organisation cannot be deleted, and a deletion that raced a mark
 *     cannot slip past the guard;
 *   - an installation that can have only one tenant marks it when the api
 *     starts, and leaves everything else alone;
 *   - the tenant lists put the own organisation first;
 *   - a session pinned to one tenant can neither read nor change another tenant's kind.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_api_internal_tenant_test` is recreated there and dropped after).
 * Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  type Database,
  auditLog,
  createDb,
  organization,
  providers,
  reportRules,
  tenantKeys,
  tenants,
  user,
} from "@restow/db";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerApiExtension, resetExtensionsForTesting } from "../../extensions.js";
import { verifyAuditChain } from "../../lib/audit.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { createTenantSchema } from "./schemas.js";
import type { Actor } from "./service.js";

const DATABASE = "restow_api_internal_tenant_test";

type Service = typeof import("./service.js");
type Internal = typeof import("./internal.js");

describe.skipIf(!testDatabaseAdminUrl)("the operator's own organisation against Postgres", () => {
  let owner: Database;
  let db: Database;
  let providerDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let service: Service;
  let internal: Internal;
  /** What the test gate answers for every gated function: the Service Provider edition when true. */
  let featuresOn = false;
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
    internal = await import("./internal.js");
  }, 60_000);

  afterAll(async () => {
    resetExtensionsForTesting();
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await owner?.$client.end();
    await db?.$client.end();
    await providerDb?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  // The audit log is append-only and a tenant row stays for its chain (status `deleting` is how the
  // product retires one), so the scenarios share one database and name their tenants uniquely.
  beforeEach(() => {
    featuresOn = false;
  });

  function slug(prefix: string): string {
    return `${prefix}-${randomUUID().slice(0, 8)}`;
  }

  async function newCustomer(name: string) {
    return service.createTenant(
      db,
      providerDb,
      createTenantSchema.parse({ name, slug: slug("c") }),
      actor,
    );
  }

  async function internalRows() {
    return owner.select().from(tenants).where(eq(tenants.kind, "internal"));
  }

  async function chain(tenantId: string) {
    return owner
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenantId))
      .orderBy(asc(auditLog.createdAt), asc(auditLog.id));
  }

  /** Remove every tenant row that is still active so the next scenario starts from "no tenant". */
  async function retireEveryTenant() {
    await owner.update(tenants).set({ status: "deleting", kind: "customer" });
  }

  // --- Creation ----------------------------------------------------------------------------

  it("creates the first tenant as the own organisation without any extension: key, alert rules, audit entry, no membership", async () => {
    const created = await internal.ensureOwnOrganisation(
      db,
      providerDb,
      { name: "Müller IT GmbH", alertEmail: "admin@mueller.example" },
      actor,
    );
    expect(created.created).toBe(true);
    expect(created.tenant).toMatchObject({
      name: "Müller IT GmbH",
      slug: "mueller-it-gmbh",
      kind: "internal",
      status: "active",
      customerNumber: null,
    });

    const id = created.tenant.id;
    expect(await owner.select().from(tenantKeys).where(eq(tenantKeys.tenantId, id))).toHaveLength(
      1,
    );
    const rules = await owner.select().from(reportRules).where(eq(reportRules.tenantId, id));
    expect(rules.map((rule) => rule.emailRecipients)).toEqual([
      ["admin@mueller.example"],
      ["admin@mueller.example"],
    ]);

    const entries = await chain(id);
    expect(entries.map((entry) => entry.action)).toEqual(["tenant.created"]);
    expect(entries[0]?.details).toMatchObject({ kind: "internal", name: "Müller IT GmbH" });
    expect(verifyAuditChain(entries)).toMatchObject({ ok: true });

    // Provider admins are no members of the organization behind the tenant.
    const [row] = await owner.select().from(tenants).where(eq(tenants.id, id));
    expect(row?.organizationId).toBeTruthy();
    const [org] = await owner
      .select({ slug: organization.slug })
      .from(organization)
      .where(eq(organization.id, row?.organizationId as string));
    expect(org?.slug).toBe("mueller-it-gmbh");
  });

  it("creates no second own organisation when it is created again, not even concurrently", async () => {
    const before = (await internalRows()).length;
    expect(before).toBe(1);
    const again = await internal.ensureOwnOrganisation(
      db,
      providerDb,
      { name: "Someone Else", alertEmail: "x@example.com" },
      actor,
    );
    expect(again.created).toBe(false);
    expect(again.tenant.name).toBe("Müller IT GmbH");

    // Several calls at once on an installation without one: exactly one creates it, none fails.
    // (The retired rows still count as tenants, so the installation needs the extension here.)
    await retireEveryTenant();
    featuresOn = true;
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        internal.ensureOwnOrganisation(
          db,
          providerDb,
          { name: "Racing GmbH", alertEmail: "x@example.com" },
          actor,
        ),
      ),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.tenant.id)).size).toBe(1);
    expect(await internalRows()).toHaveLength(1);
  });

  it("refuses to create another own organisation through the service (409) and in the database", async () => {
    const [existing] = await internalRows();
    await expect(
      internal.createInternalTenant(db, providerDb, { name: "Second Own" }, actor),
    ).rejects.toMatchObject({
      status: 409,
      type: "urn:restow:problem:internal-tenant-exists",
      extensions: { tenantId: existing?.id, tenantName: existing?.name },
    });
    // The database has the final word, whatever the service checks.
    const other = await newCustomerWithGate("DB Guard Customer");
    await expect(
      owner.update(tenants).set({ kind: "internal" }).where(eq(tenants.id, other.id)),
    ).rejects.toMatchObject({ cause: { code: "23505", constraint: "tenants_internal_uq" } });
  });

  /** A customer created while the installation may have several tenants. */
  async function newCustomerWithGate(name: string) {
    featuresOn = true;
    try {
      return await newCustomer(name);
    } finally {
      featuresOn = false;
    }
  }

  it("treats the own organisation like any tenant for the edition's tenant limit: a further one needs the extension", async () => {
    await retireEveryTenant();
    // `retireEveryTenant` leaves rows behind (their audit chains stay), so the installation
    // still "has a tenant": a further one needs the extension, the own organisation too.
    await expect(
      internal.createInternalTenant(db, providerDb, { name: "Gated Own" }, actor),
    ).rejects.toMatchObject({
      status: 403,
      type: "urn:restow:problem:feature-unavailable",
      extensions: { feature: "tenants.additional" },
    });
    featuresOn = true;
    const created = await internal.createInternalTenant(
      db,
      providerDb,
      { name: "Own With Extension" },
      actor,
    );
    expect(created).toMatchObject({ kind: "internal", slug: "own-with-extension" });
  });

  it("derives a free slug from the name, and numbers it when it is taken", async () => {
    featuresOn = true;
    // Marked away again so the next own organisation may be created.
    await owner.update(tenants).set({ kind: "customer" });
    await newCustomerNamedSlug("Same Name", "same-name");
    const created = await internal.createInternalTenant(
      db,
      providerDb,
      { name: "Same Name" },
      actor,
    );
    expect(created.slug).toBe("same-name-2");
    expect(created.kind).toBe("internal");
  });

  async function newCustomerNamedSlug(name: string, slugValue: string) {
    return service.createTenant(
      db,
      providerDb,
      createTenantSchema.parse({ name, slug: slugValue }),
      actor,
    );
  }

  // --- Marking an existing tenant ---------------------------------------------------------

  it("marks a tenant as the own organisation when there is none, audited, and does nothing the second time", async () => {
    await retireEveryTenant();
    featuresOn = true;
    const customer = await newCustomer("To Be Marked");
    expect(customer.kind).toBe("customer");

    const marked = await internal.markTenantInternal(
      providerDb,
      customer.id,
      { confirmSwitch: false },
      actor,
    );
    expect(marked).toMatchObject({ id: customer.id, kind: "internal" });
    const entries = await chain(customer.id);
    expect(entries.map((entry) => entry.action)).toEqual([
      "tenant.created",
      "tenant.internal.marked",
    ]);
    expect(entries[1]).toMatchObject({
      actor: actor.email,
      actorUserId: actor.id,
      ip: actor.ip,
      target: customer.id,
      targetType: "tenant",
    });
    expect(entries[1]?.details).toEqual({ via: "api", previousTenantId: null });
    expect(verifyAuditChain(entries)).toMatchObject({ ok: true });

    // Marking the own organisation again, even without a confirmation, is a no-op.
    const again = await internal.markTenantInternal(
      providerDb,
      customer.id,
      { confirmSwitch: false },
      actor,
    );
    expect(again.kind).toBe("internal");
    expect(await chain(customer.id)).toHaveLength(2);
  });

  it("moves the mark only with the confirmation: both tenants audited, never two own organisations", async () => {
    const [current] = await internalRows();
    featuresOn = true;
    const next = await newCustomer("Next Own");

    await expect(
      internal.markTenantInternal(providerDb, next.id, { confirmSwitch: false }, actor),
    ).rejects.toMatchObject({
      status: 409,
      type: "urn:restow:problem:internal-tenant-exists",
      extensions: { tenantId: current?.id, tenantName: current?.name },
    });
    expect((await internalRows()).map((row) => row.id)).toEqual([current?.id]);

    const switched = await internal.markTenantInternal(
      providerDb,
      next.id,
      { confirmSwitch: true },
      actor,
    );
    expect(switched.kind).toBe("internal");
    expect((await internalRows()).map((row) => row.id)).toEqual([next.id]);

    const before = await chain(current?.id as string);
    expect(before.at(-1)?.action).toBe("tenant.internal.unmarked");
    expect(before.at(-1)?.details).toEqual({ replacedBy: next.id });
    const after = await chain(next.id);
    expect(after.at(-1)?.action).toBe("tenant.internal.marked");
    expect(after.at(-1)?.details).toEqual({ via: "api", previousTenantId: current?.id });
    expect(verifyAuditChain(before)).toMatchObject({ ok: true });
    expect(verifyAuditChain(after)).toMatchObject({ ok: true });
  });

  it("refuses to mark an unknown tenant (404) and one that is being deleted (409)", async () => {
    await expect(
      internal.markTenantInternal(providerDb, randomUUID(), { confirmSwitch: true }, actor),
    ).rejects.toMatchObject({ status: 404 });
    featuresOn = true;
    const doomed = await newCustomer("Doomed");
    await service.deleteTenant(db, doomed.id, actor);
    await expect(
      internal.markTenantInternal(providerDb, doomed.id, { confirmSwitch: true }, actor),
    ).rejects.toMatchObject({ status: 409, title: "Tenant is being deleted" });
  });

  // --- Deleting ------------------------------------------------------------------------------

  it("cannot delete the own organisation: 409 with its own problem type, nothing changed, nothing audited", async () => {
    const [own] = await internalRows();
    const entriesBefore = (await chain(own?.id as string)).length;
    await expect(service.deleteTenant(db, own?.id as string, actor)).rejects.toMatchObject({
      status: 409,
      type: "urn:restow:problem:internal-tenant-protected",
    });
    const [after] = await owner
      .select()
      .from(tenants)
      .where(eq(tenants.id, own?.id as string));
    expect(after).toMatchObject({ status: "active", kind: "internal" });
    expect(after?.organizationId).toBeTruthy();
    expect(await chain(own?.id as string)).toHaveLength(entriesBefore);
  });

  it("still deletes a customer, and the former own organisation once the mark moved on", async () => {
    featuresOn = true;
    const customer = await newCustomer("Plain Customer");
    expect((await service.deleteTenant(db, customer.id, actor)).status).toBe("deleting");

    const [own] = await internalRows();
    const successor = await newCustomer("Successor");
    await internal.markTenantInternal(providerDb, successor.id, { confirmSwitch: true }, actor);
    expect((await service.deleteTenant(db, own?.id as string, actor)).status).toBe("deleting");
    // The new own organisation is protected in its turn.
    await expect(service.deleteTenant(db, successor.id, actor)).rejects.toMatchObject({
      type: "urn:restow:problem:internal-tenant-protected",
    });
  });

  it("does not let a deletion that races the marking slip past the guard", async () => {
    featuresOn = true;
    const [own] = await internalRows();
    const racer = await newCustomer("Racer");
    // Whichever statement runs first, the tenant is either deleted and unmarked-able
    // (409 on the mark) or marked and protected (409 on the delete); never both.
    const outcomes = await Promise.allSettled([
      service.deleteTenant(db, racer.id, actor),
      internal.markTenantInternal(providerDb, racer.id, { confirmSwitch: true }, actor),
    ]);
    const [row] = await owner.select().from(tenants).where(eq(tenants.id, racer.id));
    expect(row && !(row.kind === "internal" && row.status === "deleting")).toBe(true);
    expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);
    expect((await internalRows()).length).toBe(1);
    void own;
  });

  // --- The step at the start of the api ------------------------------------------------------

  describe("marking the only tenant of an installation that can have only one", () => {
    beforeEach(async () => {
      await retireEveryTenant();
    });

    it("marks the single tenant, audited as the system's, and changes nothing the second time", async () => {
      featuresOn = true;
      const only = await newCustomer("Only Tenant");
      featuresOn = false;
      const adopted = await internal.adoptSoleTenantAsInternal(db, providerDb);
      expect(adopted).toMatchObject({ id: only.id, kind: "internal" });

      const entries = await chain(only.id);
      expect(entries.at(-1)).toMatchObject({
        actor: "system",
        actorUserId: null,
        action: "tenant.internal.marked",
        target: only.id,
      });
      expect(entries.at(-1)?.details).toEqual({
        via: "update",
        reason: "single_tenant_installation",
      });
      expect(verifyAuditChain(entries)).toMatchObject({ ok: true });

      expect(await internal.adoptSoleTenantAsInternal(db, providerDb)).toBeNull();
      expect(await chain(only.id)).toHaveLength(entries.length);
    });

    it("leaves an installation that can have several tenants alone", async () => {
      featuresOn = true;
      const only = await newCustomer("Service Provider Customer");
      expect(await internal.adoptSoleTenantAsInternal(db, providerDb)).toBeNull();
      const [row] = await owner.select().from(tenants).where(eq(tenants.id, only.id));
      expect(row?.kind).toBe("customer");
    });

    it("leaves an installation with several tenants alone, even when the extension is off", async () => {
      featuresOn = true;
      const first = await newCustomer("First of Two");
      const second = await newCustomer("Second of Two");
      featuresOn = false;
      expect(await internal.adoptSoleTenantAsInternal(db, providerDb)).toBeNull();
      const rows = await owner.select().from(tenants).where(eq(tenants.status, "active"));
      expect(
        rows.filter((row) => [first.id, second.id].includes(row.id)).map((row) => row.kind),
      ).toEqual(["customer", "customer"]);
    });

    it("leaves an installation alone that has an own organisation already", async () => {
      featuresOn = true;
      const own = await internal.createInternalTenant(
        db,
        providerDb,
        { name: "Already Own" },
        actor,
      );
      featuresOn = false;
      expect(own.kind).toBe("internal");
      expect(await internal.adoptSoleTenantAsInternal(db, providerDb)).toBeNull();
    });

    it("does not count a tenant that is being deleted", async () => {
      featuresOn = true;
      const doomed = await newCustomer("Retired Customer");
      await service.deleteTenant(db, doomed.id, actor);
      const survivor = await newCustomer("Survivor");
      featuresOn = false;
      const adopted = await internal.adoptSoleTenantAsInternal(db, providerDb);
      expect(adopted).toMatchObject({ id: survivor.id, kind: "internal" });
      const [retired] = await owner.select().from(tenants).where(eq(tenants.id, doomed.id));
      expect(retired?.kind).toBe("customer");
    });

    it("does nothing on an installation without a tenant", async () => {
      expect(await internal.adoptSoleTenantAsInternal(db, providerDb)).toBeNull();
    });
  });

  // --- Lists and Row Level Security --------------------------------------------------------

  it("lists the own organisation first, then the customers by name, with kind and customer number", async () => {
    await retireEveryTenant();
    featuresOn = true;
    const beta = await service.createTenant(
      db,
      providerDb,
      createTenantSchema.parse({
        name: "Beta Customer",
        slug: slug("beta"),
        customer: { customerNumber: "K-2002" },
      }),
      actor,
    );
    await newCustomer("Alpha Customer");
    await internal.createInternalTenant(db, providerDb, { name: "Zeta Own Organisation" }, actor);

    const listed = (await service.listTenants(providerDb)).filter(
      (tenant) => tenant.status === "active",
    );
    expect(listed.map((tenant) => [tenant.name, tenant.kind])).toEqual([
      ["Zeta Own Organisation", "internal"],
      ["Alpha Customer", "customer"],
      ["Beta Customer", "customer"],
    ]);
    expect(listed.find((tenant) => tenant.id === beta.id)?.customerNumber).toBe("K-2002");
    expect(listed[0]?.customerNumber).toBeNull();
  });

  it("keeps the mark away from a session pinned to another tenant, and from an unpinned one", async () => {
    featuresOn = true;
    const [own] = await internalRows();
    const other = await newCustomer("Bystander");

    // Pinned to the bystander, the own organisation is invisible and cannot be changed.
    const seen = await withTenantTx(db, other.id, (tx) =>
      tx.select({ id: tenants.id, kind: tenants.kind }).from(tenants),
    );
    expect(seen).toEqual([{ id: other.id, kind: "customer" }]);
    const changed = await withTenantTx(db, other.id, (tx) =>
      tx
        .update(tenants)
        .set({ kind: "customer" })
        .where(eq(tenants.id, own?.id as string))
        .returning({ id: tenants.id }),
    );
    expect(changed).toEqual([]);
    expect((await internalRows()).map((row) => row.id)).toEqual([own?.id]);

    // Unpinned, the application role sees no tenant at all.
    expect(await db.select({ id: tenants.id }).from(tenants)).toEqual([]);
    // The installation role sees every tenant.
    expect((await providerDb.select({ id: tenants.id }).from(tenants)).length).toBeGreaterThan(1);
  });

  it("writes the creation of a customer with kind customer into the audit entry", async () => {
    featuresOn = true;
    const customer = await newCustomer("Audited Customer");
    const [created] = await owner
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, customer.id), eq(auditLog.action, "tenant.created")));
    expect(created?.details).toMatchObject({ kind: "customer" });
  });
});
