/**
 * Postgres-backed tests of the explorer's people list (#49) at the size of a large tenant:
 * people grouped by their directory user, paged by a keyset that stays stable while people are
 * added, the viewer's own entry first, search over names, addresses and account ids, the type
 * filter, sites in their own section, and the entry of one object.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_api_people_test` is recreated there and dropped after). Without it the suite is
 * skipped; docs/TESTING.md lists it under integration.
 */
import { createDb, type Database, protectedObjects, sources, users } from "@restow/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Viewer } from "./access.js";
import { peopleQuerySchema } from "./schemas.js";
import { listPeople, type PersonEntryDto } from "./service.js";
import {
  createExplorerFixture,
  dropDatabase,
  type ExplorerFixture,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "./testing/explorer-fixture.js";

const DATABASE = "restow_api_people_test";
const PEOPLE = 600;
const SITES = 30;

const query = (values: Record<string, string> = {}) => peopleQuerySchema.parse(values);
const pad = (n: number) => String(n).padStart(4, "0");

describe.skipIf(!testDatabaseAdminUrl)("the explorer's people, against Postgres", () => {
  let db: Database;
  let f: ExplorerFixture;
  let m365: string;
  let admin: Viewer;

  async function addPerson(index: number, extra: { email?: string } = {}): Promise<void> {
    const email = extra.email ?? `person${pad(index)}@contoso.test`;
    const [user] = await db
      .insert(users)
      .values({ tenantId: f.tenantId, email, displayName: `Person ${pad(index)}` })
      .returning();
    await db.insert(protectedObjects).values([
      {
        tenantId: f.tenantId,
        sourceId: m365,
        kind: "mailbox",
        externalId: email,
        displayName: `Person ${pad(index)}`,
        userId: user?.id,
      },
      {
        tenantId: f.tenantId,
        sourceId: m365,
        kind: "onedrive",
        externalId: `b!drive-${pad(index)}`,
        displayName: `Person ${pad(index)}`,
        userId: user?.id,
        // Every 50th person has left: only the OneDrive stays, orphaned.
        status: index % 50 === 0 ? "orphaned" : "active",
      },
    ]);
  }

  async function allPages(viewer: Viewer, values: Record<string, string>, limit = 37) {
    const seen: PersonEntryDto[] = [];
    let after: string | null = null;
    let total = 0;
    do {
      const page = await listPeople(
        db,
        f.tenantId,
        viewer,
        query({ ...values, limit: String(limit), ...(after ? { after } : {}) }),
      );
      seen.push(...page.items);
      total = page.total;
      after = page.next;
    } while (after);
    return { seen, total };
  }

  beforeAll(async () => {
    db = createDb(await recreateDatabase(testDatabaseAdminUrl as string, DATABASE));
    f = await createExplorerFixture(db);
    const [source] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(and(eq(sources.tenantId, f.tenantId), eq(sources.kind, "m365")));
    m365 = source?.id as string;
    admin = f.admin;
    for (let index = 0; index < PEOPLE; index += 1) {
      await addPerson(index);
    }
    // The admin's own mailbox: their entry comes first although "Zz" sorts last.
    await addPerson(PEOPLE, { email: "admin@provider.test" });
    await db
      .update(users)
      .set({ displayName: "Zz Admin" })
      .where(and(eq(users.tenantId, f.tenantId), eq(users.email, "admin@provider.test")));
    await db.insert(protectedObjects).values(
      Array.from({ length: SITES }, (_, index) => ({
        tenantId: f.tenantId,
        sourceId: m365,
        kind: "site" as const,
        externalId: `contoso.sharepoint.com,site-${pad(index)}`,
        displayName: `Site ${pad(index)}`,
      })),
    );
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  it("pages through every person once, the own entry first, then by name, a person's objects together", async () => {
    const { seen, total } = await allPages(admin, {});
    // 600 + the admin + Anna (mailbox and OneDrive) + Bob + the IMAP account "Info".
    expect(total).toBe(PEOPLE + 4);
    expect(seen).toHaveLength(total);
    expect(new Set(seen.map((entry) => entry.key)).size).toBe(total);
    expect(seen[0]).toMatchObject({ name: "Zz Admin", own: true });
    const names = seen.slice(1).map((entry) => entry.name.toLowerCase());
    expect(names).toEqual([...names].sort());
    const anna = seen.find((entry) => entry.name === "Anna");
    expect(anna?.objects.map((object) => object.kind)).toEqual(["mailbox", "onedrive"]);
    expect(anna?.address).toBe("anna@contoso.test");
    const person = seen.find((entry) => entry.name === "Person 0001");
    expect(person?.objects.map((object) => object.kind)).toEqual(["mailbox", "onedrive"]);
    expect(seen.some((entry) => entry.objects.some((object) => object.kind === "site"))).toBe(
      false,
    );
  });

  it("stays stable when someone is added between two pages: nothing twice, nothing skipped", async () => {
    const first = await listPeople(db, f.tenantId, admin, query({ limit: "100" }));
    // A person who sorts before the cursor, and one after it.
    await addPerson(9000, { email: "aaa-new@contoso.test" });
    await db
      .update(users)
      .set({ displayName: "Aaa New" })
      .where(and(eq(users.tenantId, f.tenantId), eq(users.email, "aaa-new@contoso.test")));
    await addPerson(9001, { email: "zzz-new@contoso.test" });
    const rest: PersonEntryDto[] = [];
    let after = first.next;
    while (after) {
      const page = await listPeople(db, f.tenantId, admin, query({ limit: "100", after }));
      rest.push(...page.items);
      after = page.next;
    }
    const keys = [...first.items, ...rest].map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(PEOPLE + 4 + 1);
    expect(rest.some((entry) => entry.name === "Person 9001")).toBe(true);
  });

  it("searches names, addresses and account ids, every word, and filters by type", async () => {
    const byName = await listPeople(db, f.tenantId, admin, query({ q: "person 0042" }));
    expect(byName.items.map((entry) => entry.name)).toEqual(["Person 0042"]);
    const byDrive = await listPeople(db, f.tenantId, admin, query({ q: "b!drive-0042" }));
    expect(byDrive.items.map((entry) => entry.name)).toEqual(["Person 0042"]);
    const byAddress = await listPeople(db, f.tenantId, admin, query({ q: "PERSON0043@contoso" }));
    expect(byAddress.items.map((entry) => entry.name)).toEqual(["Person 0043"]);
    // A LIKE wildcard in the search is a plain character.
    expect((await listPeople(db, f.tenantId, admin, query({ q: "%" }))).total).toBe(0);

    const imap = await listPeople(db, f.tenantId, admin, query({ kind: "imap" }));
    expect(imap.items.map((entry) => entry.name)).toEqual(["Info"]);
    const drives = await listPeople(db, f.tenantId, admin, query({ kind: "onedrive", limit: "1" }));
    expect(drives.total).toBe(PEOPLE + 4);
  });

  it("marks a person whose objects are all gone", async () => {
    const [user] = await db
      .insert(users)
      .values({ tenantId: f.tenantId, email: "gone@contoso.test", displayName: "Gone Person" })
      .returning();
    await db.insert(protectedObjects).values({
      tenantId: f.tenantId,
      sourceId: m365,
      kind: "onedrive",
      externalId: "b!drive-gone",
      displayName: "Gone Person",
      userId: user?.id,
      status: "orphaned",
    });
    const page = await listPeople(db, f.tenantId, admin, query({ q: "gone person" }));
    expect(page.items[0]).toMatchObject({ name: "Gone Person", accountDeleted: true });
  });

  it("lists sites in a section of their own, paged the same way", async () => {
    const { seen, total } = await allPages(admin, { section: "sites" }, 7);
    expect(total).toBe(SITES);
    expect(seen.map((entry) => entry.name)).toEqual(
      Array.from({ length: SITES }, (_, index) => `Site ${pad(index)}`),
    );
    expect(seen.every((entry) => entry.objects[0]?.kind === "site")).toBe(true);
  });

  it("shows a person only their own entry, and answers the entry of one object", async () => {
    const mine = await listPeople(db, f.tenantId, f.anna, query({}));
    expect(mine.items.map((entry) => [entry.name, entry.own])).toEqual([["Anna", true]]);
    const of = await listPeople(db, f.tenantId, admin, query({ objectId: f.annaDrive }));
    expect(of.items).toHaveLength(1);
    expect(of.items[0]?.objects.map((object) => object.id).sort()).toEqual(
      [f.annaMailbox, f.annaDrive].sort(),
    );
    expect(of.next).toBeNull();
  });

  it("refuses a cursor it did not hand out", async () => {
    await expect(
      listPeople(db, f.tenantId, admin, query({ after: "not-a-cursor" })),
    ).rejects.toMatchObject({ status: 400 });
  });
});
