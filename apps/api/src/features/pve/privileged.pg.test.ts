/**
 * Restore points of privileged containers against Postgres. The node restores every container
 * as unprivileged (`unprivileged=1`), Restow's own policy: files with ids above 65535 and
 * device nodes of a privileged container would not restore. Whether a restore point is of a
 * privileged container is read from its own configuration, not from what the guest is now, and
 * the text says that Restow decides it (it blamed PVE). The guest's page says why its restore
 * check and boot test do not run (the planner passes such a guest over: worker
 * maintenance.pg.test.ts).
 */
import { pveGuests, pveJobs, pveSnapshots, pveTasks } from "@restow/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  basic,
  type EndpointFixture,
  startFixture,
  testDatabaseAdminUrl,
} from "../endpoints/testing/fixture.js";

const DATABASE = "restow_api_pve_privileged_test";
const canRun = Boolean(testDatabaseAdminUrl);

describe.skipIf(!canRun)("restore points of privileged containers", () => {
  let fixture: EndpointFixture;
  let shared: typeof import("../../db.js");
  let service: typeof import("./service.js");
  let bootTests: typeof import("./boot-tests.js");
  let guestId = "";
  let privilegedPoint = "";
  let unprivilegedPoint = "";
  const actor = () => ({ label: "admin@contoso.example", userId: fixture.adminId, ip: null });

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    shared = await import("../../db.js");
    service = await import("./service.js");
    bootTests = await import("./boot-tests.js");
    const { pveNodeRoutes } = await import("./node-routes.js");
    const { errorHandler } = await import("../../problem.js");
    const app = new Hono();
    app.onError(errorHandler);
    app.route("/agent/pve/v1", pveNodeRoutes);
    const { token } = await service.createEnrollmentToken(shared.db, fixture.tenantId, actor(), {
      url: "https://restow.test.example",
    });
    const enrolled = await app.request("/agent/pve/v1/enroll", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.70" },
      body: JSON.stringify({
        token,
        clusterName: "lab",
        clusterFingerprint: "d".repeat(64),
        nodeName: "pve1",
        pveVersion: "9.2.1",
        helperVersion: "0.5.0",
        fleecingStorage: "local-lvm",
      }),
    });
    expect(enrolled.status).toBe(201);
    const node = (await enrolled.json()) as {
      nodeId: string;
      nodeSecret: string;
      clusterId: string;
    };
    // CT 200 is privileged now; it was converted from an unprivileged container.
    const inventory = await app.request("/agent/pve/v1/inventory", {
      method: "POST",
      headers: { ...basic(node.nodeId, node.nodeSecret), "content-type": "application/json" },
      body: JSON.stringify({
        guests: [
          { vmid: 200, kind: "ct", name: "db", node: "pve1", status: "running", privileged: true },
        ],
      }),
    });
    expect(inventory.status).toBe(200);
    const [guest] = await fixture.db.select().from(pveGuests).where(eq(pveGuests.vmid, 200));
    expect(guest?.privileged).toBe(true);
    guestId = guest?.id ?? "";
    const point = async (sequence: number, guestConfig: string) => {
      const [row] = await fixture.db
        .insert(pveSnapshots)
        .values({
          tenantId: fixture.tenantId,
          clusterId: node.clusterId,
          guestId,
          sequence,
          kind: "ct",
          archiveName: `ct/200/2026-10-0${sequence}T22:00:00Z`,
          storageId: "restow",
          manifestPath: `ct-200-${sequence}`,
          guestConfig,
          resticSnapshotId: "a".repeat(64),
          backupAt: new Date(`2026-10-0${sequence}T22:00:00Z`),
        })
        .returning();
      return row?.id ?? "";
    };
    unprivilegedPoint = await point(1, "arch: amd64\nhostname: db\nunprivileged: 1\n");
    privilegedPoint = await point(2, "arch: amd64\nhostname: db\n\n[snap]\nunprivileged: 1\n");
  }, 90_000);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  it("refuses a restore point of a privileged container, and says that Restow decides it", async () => {
    await expect(
      service.restoreSnapshot(
        shared.db,
        fixture.tenantId,
        privilegedPoint,
        { targetStorage: "local-lvm", start: false },
        actor(),
      ),
    ).rejects.toMatchObject({
      status: 409,
      type: service.PVE_PROBLEMS.privilegedRestore,
      detail:
        "Restow restores containers only as unprivileged; this restore point is of a privileged container (files with ids above 65535 and device nodes would not restore). Restore it by hand (docs/PVE.md).",
    });
    expect(await fixture.db.select().from(pveTasks)).toEqual([]);
  });

  it("restores an unprivileged restore point of a container that is privileged now", async () => {
    const queued = await service.restoreSnapshot(
      shared.db,
      fixture.tenantId,
      unprivilegedPoint,
      { targetStorage: "local-lvm", start: false },
      actor(),
    );
    const [task] = await fixture.db.select().from(pveTasks).where(eq(pveTasks.id, queued.taskId));
    expect(task?.params).toMatchObject({ volname: "ct/200/2026-10-01T22:00:00Z", kind: "ct" });
    await fixture.db.delete(pveTasks);
    // The page marks each restore point by its own configuration.
    const detail = await service.guestDetail(shared.db, fixture.tenantId, guestId);
    expect(detail.snapshots.map((s) => [s.id, s.privileged])).toEqual([
      [privilegedPoint, true],
      [unprivilegedPoint, false],
    ]);
  });

  it("names the privileged restore point on the guest's page: no restore check, no boot test", async () => {
    const [job] = await fixture.db
      .insert(pveJobs)
      .values({
        tenantId: fixture.tenantId,
        name: "checked",
        scopeAll: false,
        schedule: null,
        settings: {
          restoreTest: { enabled: true, targetStorage: "local-lvm" },
          bootTest: { schedule: "weekly" },
        },
      })
      .returning();
    await fixture.db
      .update(pveGuests)
      .set({ jobId: job?.id ?? null, lastSnapshotId: privilegedPoint })
      .where(eq(pveGuests.id, guestId));
    const page = async () => service.guestDetail(shared.db, fixture.tenantId, guestId);
    expect((await page()).restoreCheck).toMatchObject({ enabled: true, blocker: "privileged" });
    expect((await page()).bootTest).toMatchObject({ blocker: "privileged" });
    await expect(
      bootTests.requestBootTest(shared.db, fixture.tenantId, privilegedPoint, actor()),
    ).rejects.toMatchObject({ status: 409, extensions: { reason: "privileged" } });
    // With the unprivileged one newest, the privileged flag of the guest no longer blocks.
    await fixture.db
      .update(pveGuests)
      .set({ lastSnapshotId: unprivilegedPoint })
      .where(eq(pveGuests.id, guestId));
    expect((await page()).restoreCheck?.blocker).not.toBe("privileged");
    expect((await page()).bootTest.blocker).not.toBe("privileged");
  });
});
