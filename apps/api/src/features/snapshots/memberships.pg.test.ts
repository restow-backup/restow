/**
 * Postgres-backed tests of a person's Teams and sites in the explorer (#89), at the size of a
 * person in a tenant with many groups: the group mailboxes and sites the person owns or belongs
 * to (`directory_memberships`), owned ones first, then by name, paged by a keyset that stays
 * stable while memberships come and go, one membership query per page however many groups the
 * person has, each object with its restore points; objects nobody protects and that have no
 * restore point are left out, and anyone who does not see sites gets an empty list.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_api_memberships_test` is recreated there and dropped after). Without it the suite is
 * skipped; docs/TESTING.md lists it under integration.
 */
import { randomUUID } from "node:crypto";
import {
  createDb,
  type Database,
  directoryMemberships,
  protectedObjects,
  snapshots,
  sources,
  users,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Viewer } from "./access.js";
import { personMembershipsQuerySchema } from "./schemas.js";
import { listPersonMemberships, type PersonMembershipDto } from "./service.js";
import {
  createExplorerFixture,
  dropDatabase,
  type ExplorerFixture,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "./testing/explorer-fixture.js";

const DATABASE = "restow_api_memberships_test";
/** Groups of the person; each has a site as well. */
const GROUPS = 120;
/** Of those, the person owns every tenth. */
const OWNED = GROUPS / 10;

const pad = (n: number) => String(n).padStart(4, "0");

describe.skipIf(!testDatabaseAdminUrl)("a person's Teams and sites, against Postgres", () => {
  let db: Database;
  let f: ExplorerFixture;
  let m365: string;
  let personKey: string;
  let restorer: Viewer;
  let personId: string;
  const statements: string[] = [];

  const query = (values: Record<string, string> = {}) =>
    personMembershipsQuerySchema.parse({ key: personKey, ...values });

  async function allPages(viewer: Viewer, limit: number) {
    const seen: PersonMembershipDto[] = [];
    let after: string | null = null;
    let total = 0;
    let pages = 0;
    do {
      const page = await listPersonMemberships(
        db,
        f.tenantId,
        viewer,
        query({ limit: String(limit), ...(after ? { after } : {}) }),
      );
      seen.push(...page.items);
      total = page.total;
      after = page.next;
      pages += 1;
    } while (after);
    return { seen, total, pages };
  }

  beforeAll(async () => {
    db = createDb(await recreateDatabase(testDatabaseAdminUrl as string, DATABASE));
    f = await createExplorerFixture(db);
    restorer = { ...f.bob, role: "tenant_restore" };
    const [source] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(and(eq(sources.tenantId, f.tenantId), eq(sources.kind, "m365")));
    m365 = source?.id as string;
    const [person] = await db
      .insert(users)
      .values({
        tenantId: f.tenantId,
        entraObjectId: "u-person",
        email: "person@contoso.test",
        displayName: "Person",
      })
      .returning();
    personId = person?.id as string;
    personKey = `user:${personId}`;

    // Every group mailbox (excluded: opt-in) with its site (active); every third group mailbox has
    // a restore point from before it was excluded.
    const objects = await db
      .insert(protectedObjects)
      .values(
        Array.from({ length: GROUPS }, (_, index) => [
          {
            tenantId: f.tenantId,
            sourceId: m365,
            kind: "group" as const,
            externalId: `g-${pad(index)}`,
            displayName: `Team ${pad(index)}`,
            status: "excluded" as const,
          },
          {
            tenantId: f.tenantId,
            sourceId: m365,
            kind: "site" as const,
            externalId: `contoso.sharepoint.com,site-${pad(index)},web`,
            displayName: `Team ${pad(index)}`,
            status: "active" as const,
          },
        ]).flat(),
      )
      .returning({ id: protectedObjects.id, externalId: protectedObjects.externalId });
    const groupRows = objects.filter((object) => object.externalId.startsWith("g-"));
    await db.insert(snapshots).values(
      groupRows
        .filter((_, index) => index % 3 === 0)
        .map((object) => ({
          tenantId: f.tenantId,
          protectedObjectId: object.id,
          sequence: 1,
          startedAt: new Date("2026-10-01T08:00:00Z"),
          completedAt: new Date("2026-10-01T08:10:00Z"),
          manifestPath: `tenants/${f.tenantId}/manifests/${randomUUID()}`,
          itemCount: 3,
          byteSize: 300,
        })),
    );
    await db.insert(directoryMemberships).values(
      objects.map((object) => {
        const index = Number(/(\d{4})/.exec(object.externalId)?.[1]);
        return {
          tenantId: f.tenantId,
          protectedObjectId: object.id,
          userId: personId,
          role: index % 10 === 0 ? ("owner" as const) : ("member" as const),
        };
      }),
    );
    // Anna belongs to one group too; she is nobody this list shows to anyone but restorers.
    const annaUser = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, f.tenantId), eq(users.email, "anna@contoso.test")));
    await db.insert(directoryMemberships).values({
      tenantId: f.tenantId,
      protectedObjectId: objects[1]?.id as string,
      userId: annaUser[0]?.id as string,
      role: "owner",
    });

    // Count the membership statements a listing sends (no N+1 across a page): every client the
    // pool hands out reports its queries.
    const counted = new WeakSet<object>();
    db.$client.on("acquire", (client) => {
      if (counted.has(client)) {
        return;
      }
      counted.add(client);
      const original = client.query.bind(client) as (...args: unknown[]) => unknown;
      (client as unknown as { query: (...args: unknown[]) => unknown }).query = (
        ...args: unknown[]
      ) => {
        const first = args[0];
        const text = typeof first === "string" ? first : (first as { text?: string } | null)?.text;
        if (text?.includes("directory_memberships")) {
          statements.push(text);
        }
        return original(...args);
      };
    });
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  it("lists every site and the group mailboxes with a restore point, owned first, then by name", async () => {
    const withBackup = Math.ceil(GROUPS / 3);
    const { seen, total, pages } = await allPages(f.admin, 25);
    expect(total).toBe(GROUPS + withBackup);
    expect(seen).toHaveLength(total);
    expect(new Set(seen.map((entry) => entry.object.id)).size).toBe(total);
    expect(pages).toBe(Math.ceil(total / 25));

    const owned = seen.filter((entry) => entry.role === "owner");
    expect(seen.slice(0, owned.length).every((entry) => entry.role === "owner")).toBe(true);
    // Owned: every tenth team's site, and its group mailbox when it has a restore point.
    expect(owned.filter((entry) => entry.object.kind === "site")).toHaveLength(OWNED);
    const names = seen.slice(owned.length).map((entry) => entry.object.displayName ?? "");
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));

    // Each object comes with its restore points, the same as in its own section.
    const group = seen.find((entry) => entry.object.externalId === "g-0000");
    expect(group).toMatchObject({
      role: "owner",
      object: { kind: "group", status: "excluded", snapshotCount: 1, ownerKey: null },
    });
    expect(group?.object.latestSnapshotId).not.toBeNull();
    // A group mailbox nobody protects and that has no restore point is left out.
    expect(seen.some((entry) => entry.object.externalId === "g-0001")).toBe(false);
    expect(seen.some((entry) => entry.object.externalId.includes("site-0001"))).toBe(true);
  });

  it("sends one membership query per page, however many groups the person has", async () => {
    statements.length = 0;
    const { pages } = await allPages(f.admin, 50);
    expect(statements).toHaveLength(pages);
  });

  it("stays stable when a membership is added between two pages", async () => {
    const first = await listPersonMemberships(db, f.tenantId, f.admin, query({ limit: "40" }));
    const [late] = await db
      .insert(protectedObjects)
      .values({
        tenantId: f.tenantId,
        sourceId: m365,
        kind: "site",
        externalId: "contoso.sharepoint.com,aaa-late,web",
        displayName: "Aaa late site",
      })
      .returning();
    await db.insert(directoryMemberships).values({
      tenantId: f.tenantId,
      protectedObjectId: late?.id as string,
      userId: personId,
      role: "member",
    });
    const rest: PersonMembershipDto[] = [];
    let after = first.next;
    while (after) {
      const page = await listPersonMemberships(
        db,
        f.tenantId,
        f.admin,
        query({ limit: "40", after }),
      );
      rest.push(...page.items);
      after = page.next;
    }
    const ids = [...first.items, ...rest].map((entry) => entry.object.id);
    expect(new Set(ids).size).toBe(ids.length);
    await db.delete(protectedObjects).where(eq(protectedObjects.id, late?.id as string));
  });

  it("shows the list to restore operators, and an empty one to anyone who does not see sites", async () => {
    const forRestorer = await listPersonMemberships(
      db,
      f.tenantId,
      restorer,
      query({ limit: "5" }),
    );
    expect(forRestorer.items).toHaveLength(5);
    const forPerson = await listPersonMemberships(db, f.tenantId, f.anna, query());
    expect(forPerson).toEqual({ key: personKey, items: [], total: 0, next: null });
    // A person without memberships has an empty list, not an error.
    const nobody = await listPersonMemberships(
      db,
      f.tenantId,
      f.admin,
      personMembershipsQuerySchema.parse({ key: `user:${randomUUID()}` }),
    );
    expect(nobody.items).toEqual([]);
  });

  it("refuses a key that is no person and a cursor it did not hand out", async () => {
    expect(personMembershipsQuerySchema.safeParse({ key: "site:abc" }).success).toBe(false);
    await expect(
      listPersonMemberships(db, f.tenantId, f.admin, query({ after: "not-a-cursor" })),
    ).rejects.toMatchObject({ status: 400 });
  });
});
