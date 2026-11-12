/**
 * Postgres-backed test of the installation's modules (0.5.0, lib/modules.ts): an installation
 * that comes out of the migrations shows every module, a change is stored as the modules that
 * are off and audited with what was switched, a request without a module is refused, and each
 * module says what it still holds across every tenant, whether it is on or off.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (the database
 * `restow_api_modules_test` is recreated there and dropped after, the roles with it).
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  auditLog,
  backupJobs,
  createDb,
  type Database,
  endpoints,
  fileShares,
  providers,
  settings,
  sources,
  tenants,
} from "@restow/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enabledModules, MODULE_IDS, storedModules } from "../../lib/modules.js";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { modulesSchema } from "./modules.js";

const DATABASE = "restow_api_modules_test";
const actor = { id: "provider-admin", email: "admin@provider.test", ip: "192.0.2.10" };

describe("the stored modules", () => {
  it("reads nothing stored as every module on", () => {
    expect(enabledModules({})).toEqual([...MODULE_IDS]);
    expect(enabledModules(null)).toEqual([...MODULE_IDS]);
    expect(enabledModules({ hidden: [] })).toEqual([...MODULE_IDS]);
  });

  it("stores the modules that are off and ignores ids it does not know", () => {
    expect(storedModules(["microsoft365", "pve"])).toEqual({
      hidden: ["imap", "archive", "endpoints"],
    });
    expect(enabledModules({ hidden: ["pve", "tape"] })).toEqual([
      "microsoft365",
      "imap",
      "archive",
      "endpoints",
    ]);
    // A value that would switch everything off is never written; it reads as everything on.
    expect(enabledModules({ hidden: [...MODULE_IDS] })).toEqual([...MODULE_IDS]);
  });

  it("refuses a request without a module, an unknown module and unknown fields", () => {
    expect(modulesSchema.safeParse({ enabled: [] }).success).toBe(false);
    expect(modulesSchema.safeParse({ enabled: ["tape"] }).success).toBe(false);
    expect(modulesSchema.safeParse({}).success).toBe(false);
    expect(modulesSchema.safeParse({ enabled: ["pve"], other: true }).success).toBe(false);
    // Doubles collapse and the order is the list's own.
    expect(modulesSchema.parse({ enabled: ["pve", "imap", "pve"] })).toEqual({
      enabled: ["imap", "pve"],
    });
  });
});

describe.skipIf(!testDatabaseAdminUrl)("the installation's modules against Postgres", () => {
  let db: Database;
  let roles: TestDatabaseRoles | undefined;
  let providerDb: Database;
  let modules: typeof import("./modules.js");

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    db = createDb(url);
    modules = await import("./modules.js");
    providerDb = (await import("../../db.js")).providerDb;
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  const audited = () =>
    db.select().from(auditLog).where(eq(auditLog.action, "settings.modules.updated"));

  it("shows every module before the setup and refuses a change", async () => {
    expect(await modules.loadEnabledModules(providerDb)).toEqual([...MODULE_IDS]);
    await expect(
      modules.updateModules(providerDb, { enabled: ["pve"] }, actor),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("shows every module on an installation that comes out of the migrations", async () => {
    // The row an earlier release wrote: the new column takes its default.
    await db.insert(settings).values({});
    const [row] = await db.select({ modules: settings.modules }).from(settings);
    expect(row?.modules).toEqual({});
    expect(await modules.loadEnabledModules(providerDb)).toEqual([...MODULE_IDS]);
    const { modules: listed } = await modules.getModules(providerDb);
    expect(listed.map((entry) => entry.id)).toEqual([...MODULE_IDS]);
    expect(listed.every((entry) => entry.enabled && entry.data.length === 0)).toBe(true);
  });

  it("stores a change as the modules that are off, and audits what was switched", async () => {
    const saved = await modules.updateModules(
      providerDb,
      { enabled: ["microsoft365", "endpoints"] },
      actor,
    );
    expect(saved.modules.map((entry) => [entry.id, entry.enabled])).toEqual([
      ["microsoft365", true],
      ["imap", false],
      ["archive", false],
      ["endpoints", true],
      ["pve", false],
    ]);
    const [row] = await db.select({ modules: settings.modules }).from(settings);
    expect(row?.modules).toEqual({ hidden: ["imap", "archive", "pve"] });
    expect(await modules.loadEnabledModules(providerDb)).toEqual(["microsoft365", "endpoints"]);

    const entries = await audited();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: actor.email,
      targetType: "settings",
      tenantId: null,
      details: {
        before: [...MODULE_IDS],
        after: ["microsoft365", "endpoints"],
        switchedOn: [],
        switchedOff: ["imap", "archive", "pve"],
      },
    });

    // The same answer again changes nothing and is not audited a second time.
    await modules.updateModules(providerDb, { enabled: ["microsoft365", "endpoints"] }, actor);
    expect(await audited()).toHaveLength(1);

    await modules.updateModules(
      providerDb,
      { enabled: ["microsoft365", "endpoints", "pve"] },
      actor,
    );
    const again = await audited();
    expect(again).toHaveLength(2);
    expect(again.at(-1)?.details).toMatchObject({ switchedOn: ["pve"], switchedOff: [] });
  });

  it("says what a module still holds, on or off, and deletes nothing when one is switched off", async () => {
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const tenantOf = async (name: string) => {
      const [row] = await db
        .insert(tenants)
        .values({
          providerId: provider?.id as string,
          name,
          slug: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}`,
        })
        .returning();
      return row?.id as string;
    };
    const contoso = await tenantOf("Contoso");
    const fabrikam = await tenantOf("Fabrikam");
    await db.insert(sources).values([
      { tenantId: contoso, kind: "imap", name: "Mail server" },
      { tenantId: fabrikam, kind: "imap", name: "Mail server" },
      { tenantId: fabrikam, kind: "m365", name: "Fabrikam 365" },
    ]);
    const machine = (tenantId: string, extra: Partial<typeof endpoints.$inferInsert> = {}) =>
      db.insert(endpoints).values({
        tenantId,
        hostname: `host-${randomUUID().slice(0, 8)}`,
        os: "linux",
        arch: "amd64",
        profile: "server",
        secretHash: randomUUID(),
        config: {} as never,
        ...extra,
      });
    await machine(contoso);
    await machine(fabrikam);
    // Removed from Restow: no longer something the module holds.
    await machine(fabrikam, { removedAt: new Date("2026-10-02") });
    await db.insert(fileShares).values({
      tenantId: contoso,
      name: "Data",
      protocol: "smb",
      server: "fs.example.test",
      shareName: "data",
    });
    await db.insert(backupJobs).values([
      { tenantId: contoso, kind: "endpoint", name: "Servers" },
      { tenantId: contoso, kind: "share", name: "Shares" },
      { tenantId: contoso, kind: "mail", name: "Mail", archive: true },
    ]);

    await modules.updateModules(providerDb, { enabled: ["microsoft365"] }, actor);
    const byId = Object.fromEntries(
      (await modules.getModules(providerDb)).modules.map((entry) => [entry.id, entry]),
    );
    expect(byId.microsoft365).toEqual({
      id: "microsoft365",
      enabled: true,
      data: [{ kind: "connections", count: 1 }],
    });
    expect(byId.imap).toEqual({
      id: "imap",
      enabled: false,
      data: [{ kind: "connections", count: 2 }],
    });
    expect(byId.archive).toEqual({
      id: "archive",
      enabled: false,
      data: [{ kind: "archivingJobs", count: 1 }],
    });
    expect(byId.endpoints).toEqual({
      id: "endpoints",
      enabled: false,
      data: [
        { kind: "machines", count: 2 },
        { kind: "fileShares", count: 1 },
        { kind: "jobs", count: 2 },
      ],
    });
    expect(byId.pve).toEqual({ id: "pve", enabled: false, data: [] });

    // Switched off is hidden, nothing more: every row is still there.
    expect(await db.select({ id: sources.id }).from(sources)).toHaveLength(3);
    expect(await db.select({ id: endpoints.id }).from(endpoints)).toHaveLength(3);
    expect(await db.select({ id: backupJobs.id }).from(backupJobs)).toHaveLength(3);
  });
});
