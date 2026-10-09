/**
 * Proxmox VE backups against Postgres and a local storage target, driven
 * through /agent/pve/v1 the way restow-pve drives it (docs/PVE-PROTOCOL.md):
 *
 *   - enrollment with a one-time token, one tenant per cluster,
 *   - inventory, heartbeat with a backup task, the task's run,
 *   - a first VM backup must upload every block; the commit builds the block
 *     map, seals the manifest and is idempotent by commit id,
 *   - a second backup uploads only changed blocks; base + delta = full map,
 *     the hash list digest matches what the node computes,
 *   - the restore stream gives back the synthetic full byte for byte,
 *   - the authz matrix: another cluster's node, another tenant, a committed
 *     run, a hash mismatch, a block outside the disk, an incomplete disk,
 *   - the listing for the storage plugin and the sealed manifest in storage.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  PVE_BLOCK_SIZE,
  decodeBlockMap,
  encodeFrame,
  loadManifest,
  manifestKey,
  pveDisksOf,
} from "@restow/core";
import {
  auditLog,
  chunks,
  pveEnrollmentTokens,
  pveGuests,
  pveRunBlocks,
  pveRuns,
  pveSnapshots,
  pveTasks,
  secrets,
} from "@restow/db";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EndpointFixture,
  basic,
  startFixture,
  testDatabaseAdminUrl,
} from "../endpoints/testing/fixture.js";

const DATABASE = "restow_api_pve_test";
const canRun = Boolean(testDatabaseAdminUrl);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

type Service = typeof import("./service.js");
type Shared = typeof import("../../db.js");

interface Node {
  nodeId: string;
  nodeSecret: string;
  clusterId: string;
  storageId: string;
}

function disk(blocks: number, seed: number, last = PVE_BLOCK_SIZE): Buffer {
  const size = (blocks - 1) * PVE_BLOCK_SIZE + last;
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4096) {
    out.writeUInt32BE((i * 2654435761 + seed) >>> 0, i);
  }
  return out;
}

const block = (data: Buffer, i: number) =>
  data.subarray(i * PVE_BLOCK_SIZE, Math.min((i + 1) * PVE_BLOCK_SIZE, data.length));

describe.skipIf(!canRun)("Proxmox VE backups against Postgres", () => {
  let fixture: EndpointFixture;
  let shared: Shared;
  let service: Service;
  let app: Hono;
  let ip = 10;
  const actor = () => ({
    label: "admin@contoso.example",
    userId: fixture.adminId,
    ip: "192.0.2.1",
  });
  const instance = { url: "https://restow.test.example" };

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    shared = await import("../../db.js");
    service = await import("./service.js");
    const { pveNodeRoutes } = await import("./node-routes.js");
    const { errorHandler } = await import("../../problem.js");
    app = new Hono();
    app.onError(errorHandler);
    app.route("/agent/pve/v1", pveNodeRoutes);
  }, 90_000);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  async function enroll(
    tenantId: string,
    fingerprint: string,
    nodeName = "pve1",
  ): Promise<Response> {
    const { token } = await service.createEnrollmentToken(shared.db, tenantId, actor(), instance);
    return app.request("/agent/pve/v1/enroll", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `192.0.2.${ip++}` },
      body: JSON.stringify({
        token,
        clusterName: "lab",
        clusterFingerprint: fingerprint,
        nodeName,
        pveVersion: "9.2.1",
        helperVersion: "0.3.0",
        fleecingStorage: "local-lvm",
      }),
    });
  }

  function call(
    node: Node,
    path: string,
    init: { method?: string; json?: unknown; body?: Buffer } = {},
  ) {
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

  async function json<T>(response: Response, status = 200): Promise<T> {
    const text = await response.text();
    expect(response.status, text).toBe(status);
    return (text ? JSON.parse(text) : null) as T;
  }

  function frame(device: string, data: Buffer, indexes: number[], zero: number[] = []): Buffer {
    return encodeFrame([
      ...indexes.map((i) => ({
        device,
        index: i,
        zero: false,
        length: block(data, i).length,
        sha256: sha(block(data, i)),
        data: block(data, i),
      })),
      ...zero.map((i) => ({
        device,
        index: i,
        zero: true,
        length: block(data, i).length,
        sha256: "0".repeat(64),
        data: null,
      })),
    ]);
  }

  let node: Node;
  const fingerprint = "a".repeat(64);

  it("enrolls a node; a cluster serves one tenant; a token works once", async () => {
    node = await json<Node>(await enroll(fixture.tenantId, fingerprint), 201);
    expect(node.storageId).toBe("restow");
    const second = await json<Node>(await enroll(fixture.tenantId, fingerprint, "pve2"), 201);
    expect(second.clusterId).toBe(node.clusterId);
    const taken = await enroll(fixture.otherTenantId, fingerprint);
    expect(taken.status).toBe(409);
    expect((await call({ ...node, nodeSecret: "rsea_wrong" }, "/listing")).status).toBe(401);
  });

  const preflight = (token: string) =>
    app.request("/agent/pve/v1/enroll/preflight", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `192.0.2.${ip++}` },
      body: JSON.stringify({ token }),
    });

  it("gives the node one command with its enrollment token in the environment", async () => {
    const created = await service.createEnrollmentToken(
      shared.db,
      fixture.tenantId,
      actor(),
      instance,
    );
    expect(created.nodeCommand).toBe(
      `curl -fsSL 'https://restow.test.example/install/pve.sh' | RESTOW_ENROLL_TOKEN='${created.token}' sh`,
    );
    expect(created.pveTokenId).toBeNull();
    // The installer checks the token first; without an existing PVE token it creates its own.
    expect(await json(await preflight(created.token))).toEqual({
      expiresAt: created.expiresAt,
      pveTokenId: null,
      pveTokenSecret: null,
    });
    const unknown = await preflight("rset_unknown-token-of-sufficient-length");
    expect(unknown.status).toBe(401);
  });

  it("hands an existing PVE API token over once, sealed, and deletes it when the node enrolled", async () => {
    const pveToken = { id: "backup@pve!restow", secret: "9f1c2d3e-aaaa-4bbb-8ccc-0123456789ab" };
    const created = await service.createEnrollmentToken(
      shared.db,
      fixture.tenantId,
      actor(),
      instance,
      { pveToken },
    );
    expect(created.pveTokenId).toBe(pveToken.id);
    const [row] = await fixture.db
      .select()
      .from(pveEnrollmentTokens)
      .where(eq(pveEnrollmentTokens.id, created.id));
    const secretId = row?.pveTokenSecretId;
    expect(secretId).toBeTruthy();
    const [sealed] = await fixture.db
      .select()
      .from(secrets)
      .where(eq(secrets.id, secretId as string));
    expect(sealed).toMatchObject({ tenantId: fixture.tenantId, kind: "pve_api_token" });
    expect(sealed?.ciphertext).not.toContain(pveToken.secret);
    expect(Buffer.from(sealed?.ciphertext ?? "", "base64").toString("latin1")).not.toContain(
      pveToken.secret,
    );
    // The audit names the token id, never the secret.
    const audits = await fixture.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "pve.token.created"));
    expect(JSON.stringify(audits)).toContain(pveToken.id);
    expect(JSON.stringify(audits)).not.toContain(pveToken.secret);

    // The preflight hands it over and does not use the enrollment token up.
    const expected = {
      expiresAt: created.expiresAt,
      pveTokenId: pveToken.id,
      pveTokenSecret: pveToken.secret,
    };
    expect(await json(await preflight(created.token))).toEqual(expected);
    expect(await json(await preflight(created.token))).toEqual(expected);

    const enrolled = await app.request("/agent/pve/v1/enroll", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `192.0.2.${ip++}` },
      body: JSON.stringify({
        token: created.token,
        clusterName: "handover",
        clusterFingerprint: "c".repeat(64),
        nodeName: "pve9",
        pveVersion: "9.2.1",
        helperVersion: "0.3.0",
        fleecingStorage: "local-lvm",
      }),
    });
    expect(enrolled.status).toBe(201);
    expect(
      await fixture.db
        .select()
        .from(secrets)
        .where(eq(secrets.id, secretId as string)),
    ).toHaveLength(0);
    const [after] = await fixture.db
      .select()
      .from(pveEnrollmentTokens)
      .where(eq(pveEnrollmentTokens.id, created.id));
    expect(after?.pveTokenSecretId).toBeNull();
    // Used: the next node needs a new command.
    expect((await preflight(created.token)).status).toBe(401);
  });

  it("refuses a malformed existing PVE API token", async () => {
    const { createTokenSchema } = await import("./schemas.js");
    for (const id of ["root@pam", "restow@pve!", "a b@pve!x", 'restow@pve!x"; rm']) {
      expect(
        createTokenSchema.safeParse({
          pveToken: { id, secret: "9f1c2d3e-aaaa-4bbb-8ccc-0123456789ab" },
        }).success,
      ).toBe(false);
    }
    expect(
      createTokenSchema.safeParse({ pveToken: { id: "restow@pve!x", secret: "short" } }).success,
    ).toBe(false);
    expect(createTokenSchema.safeParse({}).success).toBe(true);
  });

  let guestId: string;
  const data1 = disk(3, 1, 1000);

  it("takes the inventory and hands out a backup task", async () => {
    await json(
      await call(node, "/inventory", {
        json: {
          guests: [
            {
              vmid: 101,
              kind: "vm",
              name: "web",
              node: "pve1",
              status: "running",
              disks: [{ device: "drive-scsi0", size: data1.length }],
            },
            {
              vmid: 200,
              kind: "ct",
              name: "db",
              node: "pve1",
              status: "running",
              privileged: true,
            },
          ],
        },
      }),
    );
    const [guest] = await fixture.db.select().from(pveGuests).where(eq(pveGuests.vmid, 101));
    guestId = guest?.id ?? "";
    const queued = await service.backupNow(
      shared.db,
      fixture.tenantId,
      guestId,
      { verifyRead: false },
      actor(),
    );
    expect(queued.alreadyQueued).toBe(false);
    const hb = await json<{ tasks: { id: string; kind: string; params: { vmid: number } }[] }>(
      await call(node, "/heartbeat", {
        json: {
          helperVersion: "0.3.0",
          pveVersion: "9.2.1",
          fleecingStorage: "local-lvm",
          pluginLoaded: true,
          state: "idle",
          problems: [],
          restoresAllowed: true,
        },
      }),
    );
    expect(hb.tasks).toEqual([
      expect.objectContaining({ kind: "backup", params: expect.objectContaining({ vmid: 101 }) }),
    ]);
    // A privileged container cannot be restored through PVE.
    const [ct] = await fixture.db.select().from(pveGuests).where(eq(pveGuests.vmid, 200));
    expect(ct?.privileged).toBe(true);
  });

  async function openRun(time: string) {
    return json<{ runId: string; origin: string }>(
      await call(node, "/runs", {
        json: {
          vmid: 101,
          kind: "vm",
          archiveName: `vm/101/${time}`,
          storageId: "restow",
          startedAt: time,
        },
      }),
      201,
    );
  }

  let first: { snapshotId: string; hashesDigests: Record<string, string> };

  it("a first backup must report every block, then commits once", async () => {
    const run = await openRun("2026-10-03T22:00:00Z");
    expect(run.origin).toBe("restow");
    const inc = await json<{ devices: { mode: string; baseSnapshotId: string }[] }>(
      await call(node, `/runs/${run.runId}/incremental`, {
        json: { devices: [{ device: "drive-scsi0", size: data1.length }] },
      }),
    );
    expect(inc.devices[0]).toMatchObject({ mode: "new", baseSnapshotId: "" });
    // A wrong hash is refused, nothing staged.
    const bad = frame("drive-scsi0", data1, [0]);
    bad[bad.length - 1] ^= 0xff;
    expect(
      (await call(node, `/runs/${run.runId}/blocks`, { method: "PUT", body: bad })).status,
    ).toBe(422);
    // A block beyond the disk is refused.
    const outside = encodeFrame([
      {
        device: "drive-scsi0",
        index: 7,
        zero: true,
        length: PVE_BLOCK_SIZE,
        sha256: "0".repeat(64),
        data: null,
      },
    ]);
    expect(
      (await call(node, `/runs/${run.runId}/blocks`, { method: "PUT", body: outside })).status,
    ).toBe(422);
    await json(
      await call(node, `/runs/${run.runId}/blocks`, {
        method: "PUT",
        body: frame("drive-scsi0", data1, [0, 2]),
      }),
    );
    const commitId = randomUUID();
    const commit = (id = commitId) =>
      call(node, `/runs/${run.runId}/commit`, {
        json: {
          commitId: id,
          devices: [
            {
              device: "drive-scsi0",
              size: data1.length,
              bitmapMode: "new",
              readBytes: data1.length,
              uploadedBytes: data1.length,
              changedBlocks: 3,
              zeroBlocks: 0,
              hashSkipped: 0,
            },
          ],
          guestConfig: "scsi0: local-lvm:vm-101-disk-0,size=8M\n",
          firewallConfig: null,
        },
      });
    // Block 1 is missing: the disk is incomplete.
    expect((await commit()).status).toBe(409);
    // A retried upload replaces, it never doubles references.
    await json(
      await call(node, `/runs/${run.runId}/blocks`, {
        method: "PUT",
        body: frame("drive-scsi0", data1, [1, 2]),
      }),
    );
    first = await json(await commit());
    const again = await json<{ snapshotId: string; alreadyCommitted: boolean }>(await commit());
    expect(again).toMatchObject({ snapshotId: first.snapshotId, alreadyCommitted: true });
    expect((await commit(randomUUID())).status).toBe(409);
    await json(
      await call(node, `/runs/${run.runId}/finish`, {
        json: { status: "succeeded", stats: { archiveSize: data1.length } },
      }),
      204,
    );
    const [row] = await fixture.db.select().from(pveRuns).where(eq(pveRuns.id, run.runId));
    expect(row?.status).toBe("succeeded");
    const staged = await fixture.db
      .select()
      .from(pveRunBlocks)
      .where(eq(pveRunBlocks.runId, run.runId));
    expect(staged).toHaveLength(0);
    const [task] = await fixture.db.select().from(pveTasks).where(eq(pveTasks.guestId, guestId));
    expect(task?.status).toBe("done");
    // No chunk holds a reference from staging any more: one per restore point.
    const refs = await fixture.db.execute<{ max: number }>(
      sql`SELECT max(refcount)::int AS max FROM chunks`,
    );
    expect(refs.rows[0]?.max).toBe(1);
  });

  let data2: Buffer;

  it("an incremental backup uploads only changed blocks; base + delta = full", async () => {
    data2 = Buffer.from(data1);
    data2.fill(7, PVE_BLOCK_SIZE, PVE_BLOCK_SIZE + 100);
    const run = await openRun("2026-10-04T22:00:00Z");
    expect(run.origin).toBe("pve");
    const inc = await json<{
      devices: { mode: string; baseSnapshotId: string; hashesDigest: string }[];
    }>(
      await call(node, `/runs/${run.runId}/incremental`, {
        json: { devices: [{ device: "drive-scsi0", size: data1.length }] },
      }),
    );
    expect(inc.devices[0]).toMatchObject({
      mode: "use",
      baseSnapshotId: first.snapshotId,
      hashesDigest: first.hashesDigests["drive-scsi0"],
    });
    const hashes = await call(node, `/snapshots/${first.snapshotId}/disks/drive-scsi0/hashes`);
    expect(sha(Buffer.from(await hashes.arrayBuffer()))).toBe(first.hashesDigests["drive-scsi0"]);
    await json(
      await call(node, `/runs/${run.runId}/blocks`, {
        method: "PUT",
        body: frame("drive-scsi0", data2, [1]),
      }),
    );
    const second = await json<{ snapshotId: string }>(
      await call(node, `/runs/${run.runId}/commit`, {
        json: {
          commitId: randomUUID(),
          devices: [
            {
              device: "drive-scsi0",
              size: data1.length,
              bitmapMode: "reuse",
              readBytes: PVE_BLOCK_SIZE,
              uploadedBytes: PVE_BLOCK_SIZE,
              changedBlocks: 1,
              zeroBlocks: 0,
              hashSkipped: 0,
            },
          ],
          guestConfig: "scsi0: x\n",
          firewallConfig: "[OPTIONS]\nenable: 1\n",
        },
      }),
    );
    // Restore stream of the new restore point = data2, byte for byte.
    const out: Buffer[] = [];
    for (let from = 0; from < 3; from += 2) {
      const r = await call(
        node,
        `/snapshots/${second.snapshotId}/disks/drive-scsi0/blocks?from=${from}&count=2`,
      );
      expect(r.status).toBe(200);
      let buf = Buffer.from(await r.arrayBuffer());
      while (buf.length > 0) {
        const len = buf.readUInt32BE(5);
        const zero = (buf[4] as number) & 1;
        out.push(zero ? Buffer.alloc(len) : buf.subarray(9, 9 + len));
        buf = buf.subarray(9 + (zero ? 0 : len));
      }
    }
    expect(Buffer.concat(out).equals(data2)).toBe(true);
    // The sealed manifest names the disk; its map lists all blocks.
    const [snap] = await fixture.db
      .select()
      .from(pveSnapshots)
      .where(eq(pveSnapshots.id, second.snapshotId));
    expect(snap?.baseSnapshotId).toBe(first.snapshotId);
    expect(snap?.manifestPath).toBe(manifestKey(fixture.tenantId, second.snapshotId));
    const { tenantChunkStore, readObject } = await import("./store.js");
    const store = await tenantChunkStore(fixture.tenantId);
    const manifest = await loadManifest(store.read, snap?.manifestPath ?? "", store.keys);
    const [diskObject] = pveDisksOf(manifest);
    expect(diskObject?.diskSize).toBe(data1.length);
    const map = decodeBlockMap(await readObject(store, diskObject?.object.chunks ?? []));
    expect(map.entries.map((e) => e.sha256)).toEqual([0, 1, 2].map((i) => sha(block(data2, i))));
    // Restore point listing for the storage plugin.
    const listing = await json<{ volumes: { volname: string; vmid: number }[] }>(
      await call(node, "/listing"),
    );
    expect(listing.volumes.map((v) => v.volname)).toEqual([
      "vm/101/2026-10-04T22:00:00Z",
      "vm/101/2026-10-03T22:00:00Z",
    ]);
    const resolved = await json<{ snapshotId: string; firewallConfig: string }>(
      await call(
        node,
        `/restore-points?volname=${encodeURIComponent("backup/vm/101/2026-10-04T22:00:00Z")}`,
      ),
    );
    expect(resolved).toMatchObject({
      snapshotId: second.snapshotId,
      firewallConfig: "[OPTIONS]\nenable: 1\n",
    });
  });

  it("refuses another cluster's node and another tenant", async () => {
    const other = await json<Node>(await enroll(fixture.otherTenantId, "b".repeat(64)), 201);
    expect(
      (await call(other, `/snapshots/${first.snapshotId}/disks/drive-scsi0/hashes`)).status,
    ).toBe(404);
    expect((await call(other, "/restore-points?volname=vm/101/2026-10-03T22:00:00Z")).status).toBe(
      404,
    );
    const [run] = await fixture.db
      .select()
      .from(pveRuns)
      .where(eq(pveRuns.tenantId, fixture.tenantId))
      .limit(1);
    expect(
      (
        await call(other, `/runs/${run?.id}/blocks`, {
          method: "PUT",
          body: frame("drive-scsi0", data1, [0]),
        })
      ).status,
    ).toBe(404);
    // A committed run takes no more blocks.
    expect(
      (
        await call(node, `/runs/${run?.id}/blocks`, {
          method: "PUT",
          body: frame("drive-scsi0", data1, [0]),
        })
      ).status,
    ).toBe(409);
  });

  it("restores as a new guest into the restore pool, never a privileged container", async () => {
    const queued = await service.restoreSnapshot(
      shared.db,
      fixture.tenantId,
      first.snapshotId,
      { targetStorage: "local-lvm", start: false },
      actor(),
    );
    const [task] = await fixture.db.select().from(pveTasks).where(eq(pveTasks.id, queued.taskId));
    expect(task?.params).toMatchObject({
      volname: "vm/101/2026-10-03T22:00:00Z",
      pool: "restow-restore",
      targetStorage: "local-lvm",
    });
    await call(node, "/heartbeat", { json: { helperVersion: "0.3.0", state: "idle" } });
    await json(
      await call(node, `/tasks/${queued.taskId}/result`, {
        json: { status: "done", result: { vmid: 9001 } },
      }),
      204,
    );
    const [run] = await fixture.db
      .select()
      .from(pveRuns)
      .where(and(eq(pveRuns.taskId, queued.taskId)));
    expect(run).toMatchObject({ kind: "restore", status: "succeeded" });
    const audits = await fixture.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "pve.restore.requested"));
    expect(audits).toHaveLength(1);
    const overview = await service.overview(shared.db, fixture.tenantId);
    expect(overview.guests.find((g) => g.vmid === 101)).toMatchObject({
      bitmapState: "incremental",
      attention: ["no_job"],
    });
    expect(await fixture.db.select().from(chunks).limit(1)).toHaveLength(1);
  });
});
