/**
 * The restic repositories in the stored bytes (0.4.1) against Postgres: a tenant whose backups
 * live in the restic repositories of its machines, file shares and Proxmox VE containers sees
 * them under "Stored" (storage usage, the status summary behind the dashboard tile, the
 * statistics), not only the packs of its chunk store; the other tenant's repositories never
 * count. And the restic route of a container counts what it stores: measured once while the
 * size is unknown, then every upload and deletion.
 *
 * Needs RESTOW_TEST_DATABASE_URL (a superuser); skipped otherwise.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageBackend } from "@restow/core";
import type { EndpointConfig } from "@restow/db";
import { endpoints, fileShares, packs, pveClusters, pveGuests } from "@restow/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EndpointFixture,
  startFixture,
  testDatabaseAdminUrl,
} from "../endpoints/testing/fixture.js";

const DATABASE = "restow_api_repository_bytes_test";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GB = 1_000_000_000;

const CONFIG: EndpointConfig = {
  profile: "server",
  schedule: { kind: "daily", timeOfDay: "22:00", timeZone: "Europe/Berlin" },
  paths: ["/etc"],
  excludes: [],
  hooks: {},
  bandwidthKbps: null,
  onlyOnAcPower: false,
  useVss: false,
};

type Shared = typeof import("../../db.js");

describe.skipIf(!testDatabaseAdminUrl)("restic repositories in the stored bytes", () => {
  let fixture: EndpointFixture;
  let shared: Shared;
  let work: string;
  const now = new Date(Math.floor(Date.now() / HOUR) * HOUR);
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const CHUNK_STORE = 900 + 10_000;
  const MACHINES = 2_000;
  const SHARES = 3_000;
  const CONTAINERS = 10 * GB;
  const TOTAL = CHUNK_STORE + MACHINES + SHARES + CONTAINERS;
  let clusterId = "";

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    shared = await import("../../db.js");
    work = await mkdtemp(join(tmpdir(), "restow-repository-bytes-"));
    const db = fixture.db;
    const tenantId = fixture.tenantId;
    const other = fixture.otherTenantId;

    await db.insert(packs).values([
      { tenantId, path: "packs/a", sha256: "a".repeat(64), size: 900, createdAt: ago(2 * DAY) },
      { tenantId, path: "packs/b", sha256: "b".repeat(64), size: 10_000, createdAt: ago(DAY) },
    ]);
    const endpoint = (owner: string, hostname: string, repositoryBytes: number | null) => ({
      tenantId: owner,
      hostname,
      os: "linux" as const,
      arch: "amd64" as const,
      profile: "server" as const,
      secretHash: hostname.padEnd(32, "0"),
      config: CONFIG,
      repositoryBytes,
      createdAt: ago(10 * DAY),
    });
    await db.insert(endpoints).values([
      endpoint(tenantId, "web", MACHINES),
      // Never measured yet: counts as nothing, a view never lists the repository.
      endpoint(tenantId, "laptop", null),
      endpoint(other, "theirs", 77_777),
    ]);
    const share = (owner: string, name: string, repositoryBytes: number) => ({
      tenantId: owner,
      name,
      protocol: "smb" as const,
      server: "files.example.test",
      shareName: name.toLowerCase(),
      repositoryBytes,
      createdAt: ago(10 * DAY),
    });
    await db
      .insert(fileShares)
      .values([share(tenantId, "Office", SHARES), share(other, "Theirs", 88_888)]);
    const clusters = await db
      .insert(pveClusters)
      .values([
        { tenantId, name: "lab", fingerprint: "f".repeat(64), storageId: "restow" },
        { tenantId: other, name: "theirs", fingerprint: "e".repeat(64), storageId: "restow" },
      ])
      .returning({ id: pveClusters.id, tenantId: pveClusters.tenantId });
    clusterId = clusters.find((row) => row.tenantId === tenantId)?.id as string;
    const otherCluster = clusters.find((row) => row.tenantId === other)?.id as string;
    await db.insert(pveGuests).values([
      {
        tenantId,
        clusterId,
        vmid: 300,
        kind: "ct",
        repositoryBytes: CONTAINERS,
        createdAt: ago(10 * DAY),
      },
      { tenantId, clusterId, vmid: 301, kind: "vm", createdAt: ago(10 * DAY) },
      { tenantId: other, clusterId: otherCluster, vmid: 300, kind: "ct", repositoryBytes: 99_999 },
    ]);
  }, 120_000);

  afterAll(async () => {
    await fixture?.cleanup();
    if (work) {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("adds the repositories to Stored on the storage page, per source", async () => {
    const { storageUsage } = await import("./service.js");
    const usage = await storageUsage(shared.db, fixture.tenantId, { now: () => now });
    expect(usage.physicalBytes).toBe(TOTAL);
    expect(usage.stored).toEqual({
      chunkStore: CHUNK_STORE,
      endpoints: MACHINES,
      fileShares: SHARES,
      pveGuests: CONTAINERS,
    });
    expect(usage.packCount).toBe(2);
    // The chart and the growth follow the chunk store: the repositories keep no history.
    expect(usage.series.at(-1)?.bytes).toBe(CHUNK_STORE);
    expect(usage.growth.days30.addedBytes).toBe(CHUNK_STORE);
  });

  it("counts them in the status summary behind the dashboard tile", async () => {
    const { loadTenantSummary } = await import("../../routes/v1/status.js");
    const summary = await loadTenantSummary(shared.db, fixture.tenantId, now);
    expect(summary.storage).toEqual({ logicalBytes: 0, physicalBytes: TOTAL });
    const { loadTenantFacts } = await import("../dashboard/queries.js");
    const facts = await loadTenantFacts(shared.db, fixture.tenantId, process.env, null);
    expect(facts.repositoryBytes).toBe(MACHINES + SHARES + CONTAINERS);
  });

  it("counts them in the statistics", async () => {
    const { loadStats } = await import("../stats/service.js");
    const today = now.toISOString().slice(0, 10);
    const from = ago(6 * DAY)
      .toISOString()
      .slice(0, 10);
    const { stats } = await loadStats(
      { db: shared.db, providerDb: shared.providerDb, now: () => now },
      { kind: "tenant", tenant: { id: fixture.tenantId, name: "Contoso", slug: "contoso" } },
      { from, to: today },
    );
    expect(stats.kpis.physicalBytes.value).toBe(TOTAL);
  });

  it("counts what a container's restic route stores: measured once, then every change", async () => {
    const { addGuestUsage } = await import("../pve/restic-route.js");
    const [guest] = await fixture.db
      .insert(pveGuests)
      .values({ tenantId: fixture.tenantId, clusterId, vmid: 302, kind: "ct" })
      .returning({ id: pveGuests.id });
    const guestId = guest?.id as string;
    const key = { tenantId: fixture.tenantId, guestId };
    const bytesOf = async () =>
      (
        await fixture.db
          .select({ bytes: pveGuests.repositoryBytes, at: pveGuests.repositoryMeasuredAt })
          .from(pveGuests)
          .where(eq(pveGuests.id, guestId))
      )[0];
    // A repository from before 0.4.1: its files are there, its size is unknown.
    const root = join(work, "store");
    await mkdir(join(root, "pve-guests", guestId, "data", "ab"), { recursive: true });
    await writeFile(join(root, "pve-guests", guestId, "config"), Buffer.alloc(20));
    await writeFile(join(root, "pve-guests", guestId, "data", "ab", "ab01"), Buffer.alloc(100));
    const storage = new LocalStorageBackend(root);

    // Reads and listings change nothing and measure nothing.
    await addGuestUsage(key, storage, "read", 100);
    expect((await bytesOf())?.bytes).toBeNull();
    // The first upload measures the repository, itself included.
    await addGuestUsage(key, storage, "write", 100);
    expect(await bytesOf()).toMatchObject({ bytes: 120 });
    expect((await bytesOf())?.at).toBeInstanceOf(Date);
    // From then on the route counts: a new file, a removed lock; the store is not listed again.
    await writeFile(join(root, "pve-guests", guestId, "data", "ab", "ab02"), Buffer.alloc(9999));
    await addGuestUsage(key, storage, "write", 50);
    expect((await bytesOf())?.bytes).toBe(170);
    await addGuestUsage(key, storage, "delete", 30);
    expect((await bytesOf())?.bytes).toBe(140);
    await addGuestUsage(key, storage, "delete", 1_000);
    expect((await bytesOf())?.bytes).toBe(0);
    // Another tenant cannot count on this guest.
    await addGuestUsage({ tenantId: fixture.otherTenantId, guestId }, storage, "write", 500);
    expect((await bytesOf())?.bytes).toBe(0);
  });
});
