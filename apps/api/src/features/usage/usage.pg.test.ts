/**
 * Postgres-backed tests of the usage figures: protected mailboxes counted per
 * tenant under the counting rule (@restow/core `countProtectedMailboxes`),
 * deleted tenants left out, the cap agreed with a customer shown but never
 * enforced.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_api_usage_test` is recreated there and dropped after). Without it
 * the suite is skipped.
 */
import { randomUUID } from "node:crypto";
import {
  type Database,
  createDb,
  protectedObjects,
  providers,
  settings,
  sources,
  tenants,
  users,
} from "@restow/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { loadUsage } from "./service.js";

const DATABASE = "restow_api_usage_test";

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

describe.skipIf(!testDatabaseAdminUrl)("usage against Postgres", () => {
  let db: Database;
  let f: Fixture;

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    db = createDb(url);
    f = await seed(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  it("counts protected mailboxes per tenant and leaves deleted tenants out", async () => {
    const usage = await loadUsage(db);
    expect(usage.mailboxes).toBe(6);
    expect(usage.tenants.map(({ name, mailboxes, cap }) => ({ name, mailboxes, cap }))).toEqual([
      { name: "Contoso", mailboxes: 4, cap: null },
      { name: "Fabrikam", mailboxes: 2, cap: 3 },
    ]);
    expect(usage.tenants.map((tenant) => tenant.id)).toEqual([f.contoso, f.fabrikam]);
  });
});
