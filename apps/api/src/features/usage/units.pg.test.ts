/**
 * Postgres-backed tests of the protected units the price per unit counts (usage/units.ts,
 * 0.5.0): servers and clients by their profile, Proxmox VE VMs and containers by their kind,
 * file shares; each only while it is protected now. Revoked or removed machines, retired or
 * excluded guests, retired shares and whatever is in no (enabled) job do not count; another
 * tenant's units never do.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_api_units_test` is recreated there and dropped after). Without it the suite is skipped.
 */
import { randomUUID } from "node:crypto";
import {
  backupJobMembers,
  backupJobs,
  createDb,
  type Database,
  endpoints,
  fileShares,
  providers,
  pveClusters,
  pveGuests,
  pveJobs,
  tenants,
} from "@restow/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../../lib/tenant-context.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { countProtectedUnits, NO_PROTECTED_UNITS } from "./units.js";

const DATABASE = "restow_api_units_test";

function one<T>(rows: readonly T[]): T {
  const [first] = rows;
  if (first === undefined) {
    throw new Error("insert returned no row");
  }
  return first;
}

describe.skipIf(!testDatabaseAdminUrl)("protected units against Postgres", () => {
  let db: Database;
  let contoso: string;
  let fabrikam: string;
  let empty: string;

  const count = (tenantId: string) =>
    withTenantTx(db, tenantId, (tx) => countProtectedUnits(tx, tenantId));

  const tenant = async (providerId: string, name: string) =>
    one(
      await db
        .insert(tenants)
        .values({ providerId, name, slug: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}` })
        .returning(),
    ).id;

  const machine = async (
    tenantId: string,
    profile: "server" | "client",
    extra: Partial<typeof endpoints.$inferInsert> = {},
  ) =>
    one(
      await db
        .insert(endpoints)
        .values({
          tenantId,
          hostname: `host-${randomUUID().slice(0, 8)}`,
          os: "linux",
          arch: "amd64",
          profile,
          secretHash: randomUUID(),
          config: {} as never,
          ...extra,
        })
        .returning(),
    ).id;

  const job = async (tenantId: string, kind: "endpoint" | "share", enabled = true) =>
    one(
      await db
        .insert(backupJobs)
        .values({ tenantId, kind, name: `${kind}-${randomUUID().slice(0, 6)}`, enabled })
        .returning(),
    ).id;

  const share = async (tenantId: string, extra: Partial<typeof fileShares.$inferInsert> = {}) =>
    one(
      await db
        .insert(fileShares)
        .values({
          tenantId,
          name: `share-${randomUUID().slice(0, 8)}`,
          protocol: "smb",
          server: "fs.example.test",
          shareName: "data",
          ...extra,
        })
        .returning(),
    ).id;

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    db = createDb(url);
    const provider = one(await db.insert(providers).values({ name: "Provider" }).returning());
    contoso = await tenant(provider.id, "Contoso");
    fabrikam = await tenant(provider.id, "Fabrikam");
    empty = await tenant(provider.id, "Empty");

    // Machines of Contoso: 2 servers and 1 client in a job count. A server in no job, a revoked
    // server, a removed client (both still members) and a client in no job do not.
    const machines = await job(contoso, "endpoint");
    const member = (endpointId: string) =>
      db.insert(backupJobMembers).values({ tenantId: contoso, jobId: machines, endpointId });
    await member(await machine(contoso, "server"));
    await member(await machine(contoso, "server"));
    await member(await machine(contoso, "client"));
    await machine(contoso, "server");
    await member(
      await machine(contoso, "server", { status: "revoked", revokedAt: new Date("2026-10-01") }),
    );
    await member(await machine(contoso, "client", { removedAt: new Date("2026-10-02") }));
    await machine(contoso, "client");

    // Guests of Contoso: an enabled job with 2 VMs and 1 container, the job for all guests
    // takes a VM in no job of its own. A guest of a paused job, an excluded VM, a VM template, a
    // guest no longer reported, a retired container and a restored copy in no job do not count.
    const cluster = one(
      await db
        .insert(pveClusters)
        .values({ tenantId: contoso, name: "pve", fingerprint: randomUUID(), storageId: "restow" })
        .returning(),
    ).id;
    const pveJob = async (scopeAll: boolean, enabled: boolean) =>
      one(
        await db
          .insert(pveJobs)
          .values({ tenantId: contoso, name: `pve-${randomUUID().slice(0, 6)}`, scopeAll, enabled })
          .returning(),
      ).id;
    const running = await pveJob(false, true);
    const paused = await pveJob(false, false);
    await pveJob(true, true);
    let vmid = 100;
    const guest = (kind: "vm" | "ct", extra: Partial<typeof pveGuests.$inferInsert> = {}) => {
      vmid += 1;
      return db
        .insert(pveGuests)
        .values({ tenantId: contoso, clusterId: cluster, vmid, kind, ...extra });
    };
    await guest("vm", { jobId: running });
    await guest("vm", { jobId: running });
    await guest("ct", { jobId: running });
    await guest("vm");
    await guest("ct", { jobId: paused });
    await guest("vm", { jobId: running, excludedAt: new Date("2026-10-03") });
    await guest("vm", { jobId: running, template: true });
    await guest("vm", { jobId: running, present: false });
    await guest("ct", { jobId: running, retiredAt: new Date("2026-10-04") });
    await guest("vm", { pool: "restow-restore" });

    // Shares of Contoso: 2 in an enabled share job count; one in a paused job, one in no job and
    // a retired one (still a member) do not.
    const shares = await job(contoso, "share");
    const pausedShares = await job(contoso, "share", false);
    const shareMember = (jobId: string, fileShareId: string) =>
      db.insert(backupJobMembers).values({ tenantId: contoso, jobId, fileShareId });
    await shareMember(shares, await share(contoso));
    await shareMember(shares, await share(contoso));
    await shareMember(pausedShares, await share(contoso));
    await share(contoso);
    await shareMember(shares, await share(contoso, { retiredAt: new Date("2026-10-05") }));

    // Fabrikam: one client in a job.
    const fabrikamJob = await job(fabrikam, "endpoint");
    await db.insert(backupJobMembers).values({
      tenantId: fabrikam,
      jobId: fabrikamJob,
      endpointId: await machine(fabrikam, "client"),
    });
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  it("counts each type under its rule and leaves out what is not protected", async () => {
    expect(await count(contoso)).toEqual({
      servers: 2,
      clients: 1,
      vms: 3,
      containers: 1,
      fileShares: 2,
    });
  });

  it("counts every tenant on its own, and nothing for a tenant without units", async () => {
    expect(await count(fabrikam)).toEqual({ ...NO_PROTECTED_UNITS, clients: 1 });
    expect(await count(empty)).toEqual(NO_PROTECTED_UNITS);
  });

  it("stops counting a machine once it is revoked or removed", async () => {
    const [counted] = await db
      .select({ id: endpoints.id })
      .from(endpoints)
      .innerJoin(backupJobMembers, eq(backupJobMembers.endpointId, endpoints.id))
      .where(eq(endpoints.tenantId, fabrikam));
    const id = (counted as { id: string }).id;
    await db.update(endpoints).set({ status: "revoked" }).where(eq(endpoints.id, id));
    expect((await count(fabrikam)).clients).toBe(0);
    await db
      .update(endpoints)
      .set({ status: "active", removedAt: new Date() })
      .where(eq(endpoints.id, id));
    expect((await count(fabrikam)).clients).toBe(0);
    await db.update(endpoints).set({ removedAt: null }).where(eq(endpoints.id, id));
    expect((await count(fabrikam)).clients).toBe(1);
  });
});
