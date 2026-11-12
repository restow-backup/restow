/**
 * The size and space guard of Proxmox VE VM block backups (#99, docs/STORAGE.md "Unusually large
 * runs"), against Postgres and a local storage target, driven through /agent/pve/v1 the way
 * restow-pve drives it: the blocks a VM backup sends are measured before every pack the server
 * stores, in the plaintext of the new chunks (after deduplication), against the guest's earlier
 * VM runs.
 *
 *   - a run without a base restore point (the first backup) begins a new chain: never flagged,
 *     the history starts with it;
 *   - a run past its limit goes on with one notice in `warn` mode (the default) and is held in
 *     `hold` mode: the frame is refused with 403 `run-size-held`, the run ends `storage.run_held`;
 *   - a lost dirty bitmap (every block sent again, unchanged) adds nothing new: not flagged;
 *   - the space rule always holds.
 *
 * Small disks (4 blocks of 4 MiB) and a tenant limit of 2 × the median, at least 1 MiB, keep the
 * data small. Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server.
 */
import { createHash, randomUUID } from "node:crypto";
import { encodeFrame, PVE_BLOCK_SIZE, RUN_SIZE_HELD_PROBLEM } from "@restow/core";
import {
  notifications,
  pveGuests,
  pveRuns,
  runSizeHistory,
  runSizeHolds,
  runSizeRuns,
  runSizeSettings,
} from "@restow/db";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  basic,
  type EndpointFixture,
  keepLittleFree,
  startFixture,
  testDatabaseAdminUrl,
} from "../endpoints/testing/fixture.js";

const DATABASE = "restow_api_pve_vm_size_guard_test";
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const BLOCKS = 4;
const DEVICE = "drive-scsi0";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

interface Node {
  nodeId: string;
  nodeSecret: string;
  clusterId: string;
}

/** One block of 4 MiB whose content depends on `seed` (no two seeds share a chunk). */
function blockOf(seed: number): Buffer {
  const out = Buffer.alloc(PVE_BLOCK_SIZE);
  for (let i = 0; i < out.length; i += 4096) {
    out.writeUInt32BE((i * 2654435761 + seed * 7919) >>> 0, i);
    out.writeUInt32BE(seed >>> 0, i + 4);
  }
  return out;
}

describe.skipIf(!testDatabaseAdminUrl)(
  "the size and space guard of Proxmox VE VM backups (#99) [ALERT-011]",
  () => {
    let fixture: EndpointFixture;
    let app: Hono;
    let node: Node;
    let guestId = "";
    let sequence = 0;
    /** The disk as the guest has it now: the seed of each block. */
    const seeds = [1, 2, 3, 4];
    let nextSeed = 100;

    beforeAll(async () => {
      fixture = await startFixture(DATABASE);
      await keepLittleFree(fixture.db);
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
        { label: "admin@contoso.example", userId: fixture.adminId, ip: "192.0.2.1" },
        { url: "https://restow.test.example" },
      );
      const enrolled = await app.request("/agent/pve/v1/enroll", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.10" },
        body: JSON.stringify({
          token,
          clusterName: "lab",
          clusterFingerprint: "b".repeat(64),
          nodeName: "pve1",
          pveVersion: "9.2.1",
          helperVersion: "0.5.0",
          fleecingStorage: "local-lvm",
        }),
      });
      expect(enrolled.status).toBe(201);
      node = (await enrolled.json()) as Node;
      const inventory = await call("/inventory", {
        json: {
          guests: [
            {
              vmid: 101,
              kind: "vm",
              name: "web",
              node: "pve1",
              status: "running",
              disks: [{ device: DEVICE, size: BLOCKS * PVE_BLOCK_SIZE }],
            },
          ],
        },
      });
      expect(inventory.status).toBe(200);
      const [guest] = await fixture.db.select().from(pveGuests).where(eq(pveGuests.vmid, 101));
      guestId = guest?.id ?? "";
    }, 90_000);

    afterAll(async () => {
      await fixture?.cleanup();
    });

    beforeEach(async () => {
      await fixture.db.delete(runSizeHolds);
      await fixture.db.delete(notifications);
      // Twice the median of the guest's VM runs, at least 1 MiB: a small disk trips it.
      await setTenant({ factor: 2, minBytes: MIB });
    });

    async function setTenant(settings: Record<string, unknown>) {
      await fixture.db
        .delete(runSizeSettings)
        .where(
          and(eq(runSizeSettings.tenantId, fixture.tenantId), isNull(runSizeSettings.objectKind)),
        );
      await fixture.db
        .insert(runSizeSettings)
        .values({ tenantId: fixture.tenantId, settings, updatedBy: "test" });
    }

    function call(path: string, init: { method?: string; json?: unknown; body?: Buffer } = {}) {
      return app.request(`/agent/pve/v1${path}`, {
        method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
        headers: {
          ...basic(node.nodeId, node.nodeSecret),
          ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
          ...(init.body ? { "content-type": "application/octet-stream" } : {}),
        },
        body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      });
    }

    function frame(indexes: number[]): Buffer {
      return encodeFrame(
        indexes.map((index) => {
          const data = blockOf(seeds[index] as number);
          return {
            device: DEVICE,
            index,
            zero: false,
            length: data.length,
            sha256: sha(data),
            data,
          };
        }),
      );
    }

    /** Open a VM backup run and ask for the incremental base; the mode the server answered. */
    async function open(blocks = BLOCKS): Promise<{ runId: string; mode: string }> {
      sequence += 1;
      const time = `2026-10-${String(10 + sequence).padStart(2, "0")}T22:00:00Z`;
      const opened = await call("/runs", {
        json: {
          vmid: 101,
          kind: "vm",
          archiveName: `vm/101/${time}`,
          storageId: "restow",
          startedAt: time,
        },
      });
      expect(opened.status).toBe(201);
      const { runId } = (await opened.json()) as { runId: string };
      const incremental = await call(`/runs/${runId}/incremental`, {
        json: { devices: [{ device: DEVICE, size: blocks * PVE_BLOCK_SIZE }] },
      });
      const answer = (await incremental.json()) as { devices: { mode: string }[] };
      return { runId, mode: answer.devices[0]?.mode ?? "" };
    }

    const put = (runId: string, indexes: number[]) =>
      call(`/runs/${runId}/blocks`, { method: "PUT", body: frame(indexes) });

    async function commitAndFinish(
      runId: string,
      changed: number,
      size = BLOCKS * PVE_BLOCK_SIZE,
      uploaded = changed,
    ) {
      const committed = await call(`/runs/${runId}/commit`, {
        json: {
          commitId: randomUUID(),
          devices: [
            {
              device: DEVICE,
              size,
              bitmapMode: "reuse",
              readBytes: uploaded * PVE_BLOCK_SIZE,
              uploadedBytes: uploaded * PVE_BLOCK_SIZE,
              changedBlocks: changed,
              zeroBlocks: 0,
              hashSkipped: 0,
            },
          ],
          guestConfig: "scsi0: local-lvm:vm-101-disk-0,size=16M\n",
          firewallConfig: null,
        },
      });
      expect(committed.status, await committed.clone().text()).toBe(200);
      const finished = await call(`/runs/${runId}/finish`, { json: { status: "succeeded" } });
      expect(finished.status).toBe(204);
    }

    /** A usual incremental: one block changed. */
    async function incremental() {
      const run = await open();
      seeds[0] = nextSeed++;
      expect((await put(run.runId, [0])).status).toBe(200);
      await commitAndFinish(run.runId, 1);
    }

    /** A run that changes every block: four times the usual. */
    async function changeEverything(runId: string) {
      for (let index = 0; index < BLOCKS; index++) {
        seeds[index] = nextSeed++;
      }
      return put(runId, [0, 1, 2, 3]);
    }

    const holds = () => fixture.db.select().from(runSizeHolds);
    const notices = () =>
      fixture.db
        .select()
        .from(notifications)
        .where(eq(notifications.event, "backup.unusually_large_notice"));

    it("takes the first backup (no base) as the start of a new chain, never as unusually large", async () => {
      const run = await open();
      expect(run.mode).toBe("new");
      // The whole disk: far more than any limit, and still no notice, no hold.
      expect((await put(run.runId, [0, 1, 2, 3])).status).toBe(200);
      await commitAndFinish(run.runId, BLOCKS);
      expect(await holds()).toEqual([]);
      expect(await notices()).toEqual([]);
      const [measured] = await fixture.db
        .select()
        .from(runSizeRuns)
        .where(eq(runSizeRuns.runId, run.runId));
      expect(measured).toMatchObject({ objectKind: "pve_guest", exemption: "new_repository" });
      // Three usual incrementals of one block each: the history (4 MiB new each).
      for (let index = 0; index < 3; index++) {
        await incremental();
      }
      expect(await holds()).toEqual([]);
      expect(await notices()).toEqual([]);
    });

    it("lets a run past its limit go on with one notice (warn, the default)", async () => {
      const run = await open();
      expect(run.mode).toBe("use");
      // 16 MiB new against a median of 4 MiB: past the limit of 8 MiB.
      expect((await changeEverything(run.runId)).status).toBe(200);
      await commitAndFinish(run.runId, BLOCKS);
      expect(await holds()).toEqual([]);
      const [notice, ...more] = await notices();
      expect(more).toEqual([]);
      expect(notice?.details).toMatchObject({
        guardObjectKind: "pve_guest",
        guardObjectId: guestId,
        runId: run.runId,
        objectName: "web",
        mode: "warn",
        limitBytes: 8 * MIB,
      });
      const [measured] = await fixture.db
        .select()
        .from(runSizeRuns)
        .where(eq(runSizeRuns.runId, run.runId));
      expect(measured?.noticedAt).not.toBeNull();
      // Back to usual runs for the next tests.
      for (let index = 0; index < 3; index++) {
        await incremental();
      }
    });

    it("compares a run after a lost dirty bitmap by what it adds: the unchanged blocks again are nothing new", async () => {
      await setTenant({ factor: 2, minBytes: MIB, mode: "hold" });
      const run = await open();
      // The node lost its bitmap and sends every block again; none changed.
      expect((await put(run.runId, [0, 1, 2, 3])).status).toBe(200);
      await commitAndFinish(run.runId, 0, BLOCKS * PVE_BLOCK_SIZE, BLOCKS);
      expect(await holds()).toEqual([]);
      expect(await notices()).toEqual([]);
      // The history counts what the run added to the chunk store, not the 16 MiB it sent.
      expect((await runSizeHistory(fixture.db, "pve_guest", guestId, 10))[0]).toBe(0);
    });

    it("holds a run past its limit in `hold` mode: 403 run-size-held, the run ends held", async () => {
      await setTenant({ factor: 2, minBytes: MIB, mode: "hold" });
      const run = await open();
      const refused = await changeEverything(run.runId);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ type: RUN_SIZE_HELD_PROBLEM });
      const [hold] = await holds();
      expect(hold).toMatchObject({
        objectKind: "pve_guest",
        objectId: guestId,
        objectName: "web",
        runId: run.runId,
        reason: "size",
        status: "pending",
        limitBytes: 8 * MIB,
      });
      const bell = await fixture.db
        .select()
        .from(notifications)
        .where(eq(notifications.event, "backup.unusually_large"));
      expect(bell).toHaveLength(1);
      // restow-pve takes the 403 as final: vzdump fails, the node ends the run.
      const finished = await call(`/runs/${run.runId}/finish`, {
        json: { status: "failed", error: `Restow server answered 403 Backup held` },
      });
      expect(finished.status).toBe(204);
      const [row] = await fixture.db.select().from(pveRuns).where(eq(pveRuns.id, run.runId));
      expect(row?.status).toBe("failed");
      expect(row?.failure).toMatchObject({ code: "storage.run_held" });
      // The next run of the guest waits as well, at its first pack.
      const next = await open();
      seeds[0] = nextSeed++;
      expect((await put(next.runId, [0])).status).toBe(403);
      expect((await holds())[0]?.refusedRuns).toBe(1);
      await call(`/runs/${next.runId}/finish`, { json: { status: "failed", error: "held" } });
    });

    it("always holds a run for space, also in `warn` mode", async () => {
      const { tenantChunkStore } = await import("./store.js");
      const store = await tenantChunkStore(fixture.tenantId);
      // The target reports 32 MiB free: less than the 64 MiB it keeps after this upload.
      const space = vi
        .spyOn(store.write.primary, "freeSpace")
        .mockResolvedValue({ freeBytes: 32 * MIB, totalBytes: 100 * GIB });
      try {
        const run = await open();
        seeds[1] = nextSeed++;
        const refused = await put(run.runId, [1]);
        expect(refused.status).toBe(403);
        expect(await holds()).toMatchObject([{ reason: "space", runId: run.runId }]);
        await call(`/runs/${run.runId}/finish`, { json: { status: "failed", error: "held" } });
        const [row] = await fixture.db.select().from(pveRuns).where(eq(pveRuns.id, run.runId));
        expect(row?.failure).toMatchObject({ code: "storage.run_held" });
      } finally {
        space.mockRestore();
      }
    });

    it("takes a run whose disks have no base (resized) as a new chain, also in `hold` mode", async () => {
      await setTenant({ factor: 2, minBytes: MIB, mode: "hold" });
      // The disk grew by a block: no base for it, the whole disk is sent and stored again.
      seeds.push(nextSeed++);
      for (let index = 0; index < BLOCKS + 1; index++) {
        seeds[index] = nextSeed++;
      }
      const run = await open(BLOCKS + 1);
      expect(run.mode).toBe("new");
      expect((await put(run.runId, [0, 1, 2, 3, 4])).status).toBe(200);
      await commitAndFinish(run.runId, BLOCKS + 1, (BLOCKS + 1) * PVE_BLOCK_SIZE);
      expect(await holds()).toEqual([]);
      const [measured] = await fixture.db
        .select()
        .from(runSizeRuns)
        .where(eq(runSizeRuns.runId, run.runId));
      expect(measured?.exemption).toBe("new_repository");
      // The history starts again with it.
      expect(await runSizeHistory(fixture.db, "pve_guest", guestId, 10)).toEqual([]);
    });
  },
);
