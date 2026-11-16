/**
 * GET /agent/pve/v1/listing against Postgres: the restore points restow-pve caches for the
 * storage plugin's list_volumes. A cluster with 700 guests and the default retention holds
 * about 11,900 restore points; the listing stopped at the newest 10,000, so older points
 * vanished from PVE's storage view and the guests' Backup tab, and volume_size_info reported
 * "not found" for them. Now:
 *
 *   - `?vmid=` lists every active restore point of that VMID, unpaged,
 *   - without it the cluster's listing is paged (`limit`, `cursor`, `next`), the pages
 *     together hold every active restore point exactly once,
 *   - a node before 0.5.0, asking without parameters, gets the newest 10,000 as before.
 */
import { pveGuests } from "@restow/db";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  basic,
  type EndpointFixture,
  startFixture,
  testDatabaseAdminUrl,
} from "../endpoints/testing/fixture.js";

const DATABASE = "restow_api_pve_listing_test";
const canRun = Boolean(testDatabaseAdminUrl);

interface Listing {
  volumes: { volname: string; vmid: number; kind: string; ctime: number; snapshotId: string }[];
  next: string | null;
}

describe.skipIf(!canRun)("the storage plugin's listing of a large cluster", () => {
  let fixture: EndpointFixture;
  let app: Hono;
  let node: { nodeId: string; nodeSecret: string; clusterId: string };

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    const shared = await import("../../db.js");
    const service = await import("./service.js");
    const { pveNodeRoutes } = await import("./node-routes.js");
    const { errorHandler } = await import("../../problem.js");
    app = new Hono();
    app.onError(errorHandler);
    app.route("/agent/pve/v1", pveNodeRoutes);
    const { token } = await service.createEnrollmentToken(
      shared.db,
      fixture.tenantId,
      { label: "admin@contoso.example", userId: fixture.adminId, ip: null },
      { url: "https://restow.test.example" },
    );
    const enrolled = await app.request("/agent/pve/v1/enroll", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.60" },
      body: JSON.stringify({
        token,
        clusterName: "big",
        clusterFingerprint: "f".repeat(64),
        nodeName: "pve1",
        pveVersion: "9.2.1",
        helperVersion: "0.5.0",
        fleecingStorage: "local-lvm",
      }),
    });
    expect(enrolled.status).toBe(201);
    node = (await enrolled.json()) as typeof node;
    const inventory = await call("/inventory", {
      guests: [
        { vmid: 101, kind: "vm", name: "web", node: "pve1", status: "running", disks: [] },
        { vmid: 200, kind: "ct", name: "db", node: "pve1", status: "running" },
      ],
    });
    expect(inventory.status).toBe(200);
    const guests = await fixture.db.select().from(pveGuests);
    const vm = guests.find((g) => g.vmid === 101)?.id;
    const ct = guests.find((g) => g.vmid === 200)?.id;
    // 10,001 restore points of VM 101, three per second (equal backup times, so the cursor
    // must break ties), and some with microseconds; then the three oldest of CT 200 and a
    // pruned one, which no listing names.
    await fixture.db.execute(sql`
      INSERT INTO pve_snapshots (tenant_id, cluster_id, guest_id, sequence, kind, archive_name,
        storage_id, manifest_path, backup_at)
      SELECT ${fixture.tenantId}, ${node.clusterId}, ${vm}, i, 'vm',
        'vm/101/' || i, 'restow', 'm/' || i,
        timestamptz '2026-01-01 00:00:00+00' + make_interval(secs => 10000 + i / 3)
          + CASE WHEN i % 7 = 0 THEN interval '250 microseconds' ELSE interval '0' END
        FROM generate_series(1, 10001) AS i`);
    await fixture.db.execute(sql`
      INSERT INTO pve_snapshots (tenant_id, cluster_id, guest_id, sequence, kind, archive_name,
        storage_id, manifest_path, backup_at, status)
      SELECT ${fixture.tenantId}, ${node.clusterId}, ${ct}, i, 'ct',
        'ct/200/' || i, 'restow', 'c/' || i,
        timestamptz '2026-01-01 00:00:00+00' + make_interval(secs => i),
        CASE WHEN i = 4 THEN 'pruned' ELSE 'active' END
        FROM generate_series(1, 4) AS i`);
  }, 120_000);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  function call(path: string, json?: unknown) {
    return app.request(`/agent/pve/v1${path}`, {
      method: json === undefined ? "GET" : "POST",
      headers: {
        ...basic(node.nodeId, node.nodeSecret),
        ...(json === undefined ? {} : { "content-type": "application/json" }),
      },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  }

  async function listing(query: string): Promise<Listing> {
    const response = await call(`/listing${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Listing;
  }

  it("pages through every active restore point of the cluster exactly once", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Listing = await listing(
        `?limit=4000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(page.volumes.length).toBeLessThanOrEqual(4000);
      seen.push(...page.volumes.map((v) => v.volname));
      cursor = page.next;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(10_004);
    expect(new Set(seen).size).toBe(10_004);
    // Newest first; the three of the newest second come in the order of their ids.
    expect(seen.slice(0, 3).sort()).toEqual(["vm/101/10000", "vm/101/10001", "vm/101/9999"]);
    expect(seen.slice(-3)).toEqual(["ct/200/3", "ct/200/2", "ct/200/1"]);
    expect(seen).not.toContain("ct/200/4");
  });

  it("lists every restore point of one VMID, also those beyond the first page", async () => {
    const ct = await listing("?vmid=200");
    expect(ct.volumes.map((v) => [v.volname, v.vmid, v.kind])).toEqual([
      ["ct/200/3", 200, "ct"],
      ["ct/200/2", 200, "ct"],
      ["ct/200/1", 200, "ct"],
    ]);
    expect(ct.next).toBeNull();
    const vm = await listing("?vmid=101");
    expect(vm.volumes).toHaveLength(10_001);
    expect((await listing("?vmid=999")).volumes).toEqual([]);
  });

  it("gives a node that asks without parameters the newest 10,000, as before", async () => {
    const old = await listing("");
    expect(old.volumes).toHaveLength(10_000);
    expect(old.volumes.some((v) => v.vmid === 200)).toBe(false);
    expect(old.next).not.toBeNull();
    // The rest follows from its cursor: the older of the two VM points of the oldest second
    // (the order of their ids decides which), then the container's.
    const rest = await listing(`?cursor=${encodeURIComponent(old.next ?? "")}`);
    const names = rest.volumes.map((v) => v.volname);
    expect(names.slice(1)).toEqual(["ct/200/3", "ct/200/2", "ct/200/1"]);
    expect(["vm/101/1", "vm/101/2"]).toContain(names[0]);
    expect(old.volumes.map((v) => v.volname)).not.toContain(names[0]);
    expect(rest.next).toBeNull();
    expect((await call("/listing?cursor=nonsense")).status).toBe(422);
  });
});
