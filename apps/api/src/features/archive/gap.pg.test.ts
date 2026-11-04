/**
 * The restore explorer's source "From the archive" (#48) and the archive's place in the
 * menu, against Postgres on the application role (Row Level Security): which archived mail
 * of a mailbox counts as arriving after its newest backup, that only administrators read
 * it, that every listing is audited (on whose behalf too), and when the archive is offered
 * to a tenant at all (GET /navigation).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (the
 * database `restow_api_archive_gap_test` is recreated there and dropped after).
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  archiveItemMailboxes,
  archiveItems,
  auditLog,
  backupJobs,
  createDb,
  type Database,
  protectedObjects,
  providers,
  snapshots,
  sources,
  tenants,
  users,
} from "@restow/db";
import { and, desc, eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "../../auth.js";
import { type Role, roleSatisfies, type TenantRole } from "../../middleware/rbac.js";
import type { TenantEnv } from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { isArchiveOffered } from "./availability.js";

const DATABASE = "restow_api_archive_gap_test";
const ROLE_HEADER = "x-test-role";
const BACKUP_START = new Date("2026-11-03T20:00:00Z");
const hours = (n: number) => new Date(BACKUP_START.getTime() + n * 3_600_000);

function access(minimum: TenantRole, userId: string): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    const role = (c.req.header(ROLE_HEADER) ?? "tenant_admin") as Role;
    if (!roleSatisfies(role, minimum)) {
      throw new ProblemError(403, "Insufficient role");
    }
    c.set("tenantId", c.req.header("x-restow-tenant") ?? "");
    c.set("role", role);
    c.set("user", { id: userId, email: "admin@contoso.example" } as unknown as SessionUser);
    await next();
  };
}

describe("isArchiveOffered", () => {
  it("offers the archive once it holds mail, or once a capture of the edition is in use", () => {
    expect(isArchiveOffered({ hasItems: false, available: false, captureActive: false })).toBe(
      false,
    );
    expect(isArchiveOffered({ hasItems: false, available: true, captureActive: false })).toBe(
      false,
    );
    expect(isArchiveOffered({ hasItems: false, available: false, captureActive: true })).toBe(
      false,
    );
    expect(isArchiveOffered({ hasItems: false, available: true, captureActive: true })).toBe(true);
    expect(isArchiveOffered({ hasItems: true, available: false, captureActive: false })).toBe(true);
  });
});

describe.skipIf(!testDatabaseAdminUrl)("archive gap and availability against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let contoso: string;
  let fabrikam: string;
  let northwind: string;
  let anna: string;
  let ben: string;
  let drive: string;
  let gateOpen = false;
  const adminId = randomUUID();
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    appDb = createDb(roles.appUrl);
    const { buildArchiveRoutes } = await import("./routes.js");
    const { buildNavigationRoutes } = await import("../navigation/routes.js");
    const { errorHandler } = await import("../../problem.js");
    const { registerApiExtension } = await import("../../extensions.js");
    registerApiExtension({
      name: "test-archive-gate",
      featureGate: {
        isEnabled: async (_pool, feature) => gateOpen && feature === "archive.mailboxCapture",
      },
    });

    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const created = await owner
      .insert(tenants)
      .values([
        { providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" },
        { providerId: provider?.id ?? "", name: "Fabrikam", slug: "fabrikam" },
        { providerId: provider?.id ?? "", name: "Northwind", slug: "northwind" },
      ])
      .returning();
    contoso = created[0]?.id ?? "";
    fabrikam = created[1]?.id ?? "";
    northwind = created[2]?.id ?? "";
    const [source] = await owner
      .insert(sources)
      .values({ tenantId: contoso, kind: "m365", name: "Contoso 365", status: "active" })
      .returning();
    const [annaUser] = await owner
      .insert(users)
      .values({ tenantId: contoso, email: "anna@contoso.example", displayName: "Anna" })
      .returning();
    const objects = await owner
      .insert(protectedObjects)
      .values([
        {
          tenantId: contoso,
          sourceId: source?.id ?? "",
          kind: "mailbox" as const,
          externalId: "anna-entra-id",
          userId: annaUser?.id,
        },
        {
          tenantId: contoso,
          sourceId: source?.id ?? "",
          kind: "mailbox" as const,
          externalId: "admin@contoso.example",
        },
        {
          tenantId: contoso,
          sourceId: source?.id ?? "",
          kind: "onedrive" as const,
          externalId: "b!drive",
        },
      ])
      .returning();
    anna = objects[0]?.id ?? "";
    ben = objects[1]?.id ?? "";
    drive = objects[2]?.id ?? "";
    // Anna's newest backup started at BACKUP_START; an older one and a running one around it.
    await owner.insert(snapshots).values([
      {
        tenantId: contoso,
        protectedObjectId: anna,
        sequence: 1,
        startedAt: hours(-48),
        completedAt: hours(-47),
        manifestPath: "m/1",
      },
      {
        tenantId: contoso,
        protectedObjectId: anna,
        sequence: 2,
        startedAt: BACKUP_START,
        completedAt: hours(1),
        manifestPath: "m/2",
      },
      { tenantId: contoso, protectedObjectId: anna, sequence: 3, startedAt: hours(6) },
    ]);

    const item = async (
      label: string,
      values: {
        tenantId?: string;
        own?: string | null;
        via?: "journal" | "graph_sync" | "file_import";
        at: Date;
        flags?: string[];
        supersedes?: string;
      },
    ) => {
      const [row] = await owner
        .insert(archiveItems)
        .values({
          tenantId: values.tenantId ?? contoso,
          protectedObjectId: values.own === undefined ? anna : values.own,
          messageId: `<${label}@contoso.example>`,
          itemHash: randomUUID(),
          chainHash: randomUUID(),
          receivedAt: values.at,
          capturedVia: values.via ?? "graph_sync",
          storagePath: `x/${label}`,
          subject: label,
          envelope: { from: "sender@example.org", to: ["anna@contoso.example"] },
          flags: values.flags ?? [],
          supersedesItemId: values.supersedes ?? null,
          sizeBytes: 100,
          chunks: ["c1"],
        })
        .returning();
      ids[label] = row?.id ?? "";
      return ids[label] as string;
    };
    await item("after", { at: hours(2) });
    await item("atStart", { at: BACKUP_START });
    await item("before", { at: hours(-1) });
    await item("late", { at: hours(3), flags: ["captured-late"] });
    await item("imported", { at: hours(4), via: "file_import" });
    const journal = await item("journal", { own: null, via: "journal", at: hours(5) });
    await owner
      .insert(archiveItemMailboxes)
      .values({ tenantId: contoso, archiveItemId: journal, protectedObjectId: anna });
    const weak = await item("weak", { at: hours(6) });
    await item("strong", { via: "journal", at: hours(6), supersedes: weak });
    await item("bens", { own: ben, at: hours(2) });
    await item("fabrikams", { tenantId: fabrikam, own: null, via: "journal", at: hours(2) });
    // Northwind: a mail job that archives, no item yet.
    await owner
      .insert(backupJobs)
      .values({ tenantId: northwind, kind: "mail", name: "Mail", archive: true });

    app = new Hono();
    app.onError(errorHandler);
    app.route(
      "/archive",
      buildArchiveRoutes({ db: appDb, requireAdmin: access("tenant_admin", adminId) }),
    );
    app.route(
      "/navigation",
      buildNavigationRoutes({
        db: appDb,
        requireMember: access("tenant_user", adminId),
        installation: owner,
      }),
    );
  }, 60_000);

  afterEach(() => {
    gateOpen = false;
  });

  afterAll(async () => {
    const { resetExtensionsForTesting } = await import("../../extensions.js");
    resetExtensionsForTesting();
    const shared = await import("../../db.js");
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
    await appDb?.$client.end();
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    if (roles) {
      await roles.drop(testDatabaseAdminUrl as string);
    }
  }, 60_000);

  const as = (tenantId: string, role: Role = "tenant_admin") => ({
    "x-restow-tenant": tenantId,
    [ROLE_HEADER]: role,
  });

  type Gap = {
    since: string | null;
    snapshotId: string | null;
    total: number;
    items: { id: string; subject: string; source: string }[];
  };

  it("lists the mailbox's mail that arrived since its newest backup began, newest first", async () => {
    const res = await app.request(`/archive/gap?object=${anna}`, { headers: as(contoso) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Gap;
    expect(body.since).toBe(BACKUP_START.toISOString());
    expect(body.snapshotId).toBeTruthy();
    // Not the one from before, the takeover, the imported file, the superseded capture,
    // Ben's mail or another tenant's.
    expect(body.items.map((entry) => entry.subject)).toEqual([
      "strong",
      "journal",
      "after",
      "atStart",
    ]);
    expect(body.total).toBe(4);
    expect(body.items[1]?.source).toBe("journal");

    const page = (await (
      await app.request(`/archive/gap?object=${anna}&limit=1&offset=1`, { headers: as(contoso) })
    ).json()) as Gap;
    expect(page.items.map((entry) => entry.subject)).toEqual(["journal"]);
    expect(page.total).toBe(4);
  });

  it("counts every item of a mailbox without a backup as the gap", async () => {
    const body = (await (
      await app.request(`/archive/gap?object=${ben}`, { headers: as(contoso) })
    ).json()) as Gap;
    expect(body.since).toBeNull();
    expect(body.items.map((entry) => entry.subject)).toEqual(["bens"]);
  });

  it("audits every listing as an archive search, on behalf of the mailbox's owner", async () => {
    await app.request(`/archive/gap?object=${anna}`, { headers: as(contoso) });
    const [entry] = await owner
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, contoso), eq(auditLog.action, "archive.searched")))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(entry).toMatchObject({
      actorUserId: adminId,
      target: anna,
      targetType: "protected_object",
      onBehalfOf: "anna@contoso.example",
    });
    expect(entry?.details).toMatchObject({
      view: "restore_gap",
      mailbox: anna,
      since: BACKUP_START.toISOString(),
      results: 4,
      total: 4,
    });

    // The administrator's own mailbox is read on nobody's behalf.
    await app.request(`/archive/gap?object=${ben}`, { headers: as(contoso) });
    const [own] = await owner
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, contoso), eq(auditLog.target, ben)))
      .limit(1);
    expect(own?.onBehalfOf).toBeNull();
  });

  it("is for administrators only and only for mailboxes and IMAP accounts of the tenant", async () => {
    for (const role of ["tenant_user", "tenant_restore"] as const) {
      const res = await app.request(`/archive/gap?object=${anna}`, {
        headers: as(contoso, role),
      });
      expect(res.status).toBe(403);
    }
    expect(
      (await app.request(`/archive/gap?object=${drive}`, { headers: as(contoso) })).status,
    ).toBe(404);
    // Another tenant cannot see Contoso's mailbox (Row Level Security).
    expect(
      (await app.request(`/archive/gap?object=${anna}`, { headers: as(fabrikam) })).status,
    ).toBe(404);
    expect((await app.request("/archive/gap?object=nope", { headers: as(contoso) })).status).toBe(
      422,
    );
  });

  it("offers the archive in the menu by the tenant's own state, to administrators only", async () => {
    const offered = async (tenantId: string, role: Role = "tenant_admin") => {
      const res = await app.request("/navigation", { headers: as(tenantId, role) });
      expect(res.status).toBe(200);
      return ((await res.json()) as { offers: { archive: boolean } }).offers.archive;
    };
    // Contoso holds archived mail: offered whatever the edition says.
    expect(await offered(contoso)).toBe(true);
    expect(await offered(contoso, "tenant_restore")).toBe(false);
    expect(await offered(contoso, "tenant_user")).toBe(false);
    // Northwind archives in a job but holds nothing yet: only while the edition captures.
    expect(await offered(northwind)).toBe(false);
    gateOpen = true;
    expect(await offered(northwind)).toBe(true);
    // Fabrikam holds one item; a tenant without items and without an archiving job is not.
    expect(await offered(fabrikam)).toBe(true);
    await owner.delete(archiveItems).where(eq(archiveItems.tenantId, fabrikam));
    expect(await offered(fabrikam)).toBe(false);
  });
});
