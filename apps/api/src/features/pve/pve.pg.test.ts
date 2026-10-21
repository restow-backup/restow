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
 *   - the listing for the storage plugin and the sealed manifest in storage,
 *   - the progress of a running backup, from the node and from a container's
 *     run credential, and what a container restore point could not read.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  decodeBlockMap,
  encodeFrame,
  generateAgentSecret,
  loadManifest,
  manifestKey,
  PVE_BLOCK_SIZE,
  pveDisksOf,
} from "@restow/core";
import {
  auditLog,
  chunks,
  pveEnrollmentTokens,
  pveGuests,
  pveJobs,
  pveNodes,
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
  basic,
  type EndpointFixture,
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
    const beat = (extra: Record<string, unknown> = {}) =>
      call(node, "/heartbeat", {
        json: {
          helperVersion: "0.3.0",
          pveVersion: "9.2.1",
          fleecingStorage: "local-lvm",
          pluginLoaded: true,
          state: "idle",
          problems: [],
          restoresAllowed: true,
          ...extra,
        },
      });
    // While an update pauses new job starts the node gets no backup task (#46).
    await fixture.db.execute(sql`
      INSERT INTO job_start_pause (mode, phase, version, lead_seconds, request, requested_by,
        deadline_at, expires_at)
      VALUES ('wait', 'draining', '0.4.0', 0, '{}', '{"userId":null,"label":"x","ip":null}',
        now() + interval '1 hour', now() + interval '3 hours')`);
    const held = await json<{ tasks: unknown[] }>(await beat({ activeRuns: [] }));
    expect(held.tasks).toEqual([]);
    const [seen] = await fixture.db
      .select({ facts: pveNodes.facts })
      .from(pveNodes)
      .where(eq(pveNodes.id, node.nodeId));
    expect(seen?.facts).toMatchObject({ activeRuns: [], state: "idle" });
    expect(seen?.facts.activeRunsAt).toEqual(expect.any(String));
    await fixture.db.execute(sql`DELETE FROM job_start_pause`);
    const hb = await json<{ tasks: { id: string; kind: string; params: { vmid: number } }[] }>(
      await beat(),
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
    // The chunk writer's numbers of every frame are summed for the compression and deduplication
    // signals, next to what the node reported at the commit.
    const stats = row?.stats as Record<string, number>;
    expect(stats.uploadedBytes).toBe(data1.length);
    expect(stats.chunkBytesIn).toBeGreaterThanOrEqual(data1.length);
    expect(stats.chunkBytesNew).toBeGreaterThan(0);
    expect(stats.chunkBytesNew).toBeLessThanOrEqual(stats.chunkBytesIn);
    expect(stats.chunkBytesSampled).toBeGreaterThan(0);
    expect(stats.chunkBytesSampledCompressed).toBeGreaterThan(0);
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

  it("shows what each restore point contains and added, and which one was the first", async () => {
    const guest = (await service.overview(shared.db, fixture.tenantId)).guests.find(
      (g) => g.id === guestId,
    );
    // The first backup stored the whole disk, the incremental one only the changed block.
    expect(guest?.backups.first).toMatchObject({ contains: data1.length, added: data1.length });
    expect(guest?.backups.last).toMatchObject({
      contains: data1.length,
      added: PVE_BLOCK_SIZE,
      unreadable: 0,
    });
    expect(guest?.attention).not.toContain("last_backup_incomplete");
    // One follow-up backup so far: the average is what it added.
    expect(guest?.backups.followUp).toEqual({ added: PVE_BLOCK_SIZE, points: 1 });
    const detail = await service.guestDetail(shared.db, fixture.tenantId, guestId);
    expect(detail.followUp).toEqual({ added: PVE_BLOCK_SIZE, points: 1 });
    expect(detail.snapshots.map((p) => [p.backupType, p.added])).toEqual([
      ["incremental", PVE_BLOCK_SIZE],
      ["first", data1.length],
    ]);
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
  it("shows a container's backup as queued, then running, and closes a run whose end the node never reported", async () => {
    const [ct] = await fixture.db.select().from(pveGuests).where(eq(pveGuests.vmid, 200));
    const ctId = ct?.id ?? "";
    const queued = await service.backupNow(
      shared.db,
      fixture.tenantId,
      ctId,
      { verifyRead: false },
      actor(),
    );
    const activityOf = async () =>
      (await service.overview(shared.db, fixture.tenantId)).guests.find((g) => g.vmid === 200)
        ?.activity;
    // The sidebar's slim read (activity.ts) counts what the overview shows.
    const sidebar = async () => {
      const { pveActivity } = await import("./activity.js");
      const slim = await pveActivity(shared.db, fixture.tenantId);
      const { guests } = await service.overview(shared.db, fixture.tenantId);
      expect(slim.connected).toBe(true);
      expect(slim.queued).toBe(guests.filter((g) => g.activity === "queued").length);
      expect(slim.running).toEqual(
        guests
          .filter((g) => g.activity === "running")
          .map((g) => ({ id: g.id, vmid: g.vmid, name: g.name, jobName: g.jobName })),
      );
      return slim;
    };
    expect(await activityOf()).toBe("queued");
    const runsNow = async () => (await sidebar()).running.map((g) => g.vmid);
    expect((await sidebar()).queued).toBe(1);
    expect(await runsNow()).not.toContain(200);
    await call(node, "/heartbeat", { json: { helperVersion: "0.3.0", state: "idle" } });
    const run = await json<{ runId: string }>(
      await call(node, "/runs", {
        json: {
          vmid: 200,
          kind: "ct",
          archiveName: "ct/200/2026-10-11T02:00:00Z",
          storageId: "restow",
          startedAt: "2026-10-11T02:00:00Z",
        },
      }),
      201,
    );
    expect(await activityOf()).toBe("running");
    expect((await sidebar()).queued).toBe(0);
    expect(await runsNow()).toContain(200);
    // "Back up now" belongs to no job's round: the jobs list shows it as a row of its own (#53).
    expect(
      (await service.overview(shared.db, fixture.tenantId)).guests.find((g) => g.vmid === 200),
    ).toMatchObject({ activityJobId: null, activityRunId: run.runId });
    // The node reports the task done, but its run's own end got lost: no restore point, so failed.
    await json(
      await call(node, `/tasks/${queued.taskId}/result`, { json: { status: "done" } }),
      204,
    );
    const [row] = await fixture.db.select().from(pveRuns).where(eq(pveRuns.id, run.runId));
    expect(row).toMatchObject({ status: "failed" });
    expect(row?.errorMessage).toContain("without reporting a restore point");
    const guest = (await service.overview(shared.db, fixture.tenantId)).guests.find(
      (g) => g.vmid === 200,
    );
    expect(guest).toMatchObject({ activity: null, lastRunStatus: "failed" });
    expect(await runsNow()).not.toContain(200);
  });

  it("takes a long error from the node, cut, instead of refusing it", async () => {
    const [ct] = await fixture.db.select().from(pveGuests).where(eq(pveGuests.vmid, 200));
    const queued = await service.backupNow(
      shared.db,
      fixture.tenantId,
      ct?.id ?? "",
      { verifyRead: false },
      actor(),
    );
    await call(node, "/heartbeat", { json: { helperVersion: "0.3.0", state: "idle" } });
    const run = await json<{ runId: string }>(
      await call(node, "/runs", {
        json: {
          vmid: 200,
          kind: "ct",
          archiveName: "ct/200/2026-10-11T03:00:00Z",
          storageId: "restow",
          startedAt: "2026-10-11T03:00:00Z",
        },
      }),
      201,
    );
    const long = `restic backup failed: exit status 1: ${"x".repeat(6000)}`;
    await json(
      await call(node, `/runs/${run.runId}/finish`, { json: { status: "failed", error: long } }),
      204,
    );
    const [row] = await fixture.db.select().from(pveRuns).where(eq(pveRuns.id, run.runId));
    expect(row?.status).toBe("failed");
    expect(row?.errorMessage?.startsWith("restic backup failed")).toBe(true);
    // The task closed with the run; a late result for it is taken (the node stops sending it)
    // and changes nothing: there is no restore point to settle.
    expect(
      (
        await call(node, `/tasks/${queued.taskId}/result`, {
          json: { status: "failed", error: long },
        })
      ).status,
    ).toBe(204);
    const [after] = await fixture.db.select().from(pveRuns).where(eq(pveRuns.id, run.runId));
    expect(after?.status).toBe("failed");
  });

  it("keeps the progress of a running backup, from the node or a container's run credential", async () => {
    const runs = await import("./runs.js");
    const opened = await json<{ runId: string; progressIntervalSeconds: number }>(
      await call(node, "/runs", {
        json: {
          vmid: 101,
          kind: "vm",
          archiveName: "vm/101/2026-10-12T22:00:00Z",
          storageId: "restow",
          startedAt: "2026-10-12T22:00:00Z",
        },
      }),
      201,
    );
    // The open run tells the node to report; an older server says nothing and gets nothing.
    expect(opened.progressIntervalSeconds).toBeGreaterThan(0);
    const progress = (runId: string, body: unknown, auth = basic(node.nodeId, node.nodeSecret)) =>
      app.request(`/agent/pve/v1/runs/${runId}/progress`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await json(
      await progress(opened.runId, { bytesDone: 100, bytesTotal: 1000, bytesUploaded: 40 }),
      204,
    );
    const guestOf = async (vmid: number) =>
      (await service.overview(shared.db, fixture.tenantId)).guests.find((g) => g.vmid === vmid);
    expect(await guestOf(101)).toMatchObject({
      activity: "running",
      activitySince: "2026-10-12T22:00:00.000Z",
      progress: { bytesDone: 100, bytesTotal: 1000, bytesUploaded: 40, bytesPerSecond: null },
    });
    // A report right after the last one is taken, not written.
    await json(await progress(opened.runId, { bytesDone: 200, bytesTotal: 1000 }), 204);
    expect((await guestOf(101))?.progress?.bytesDone).toBe(100);
    // Five seconds later: 500 bytes more, 100 bytes per second.
    const [row] = await fixture.db.select().from(pveRuns).where(eq(pveRuns.id, opened.runId));
    const later = new Date(Date.parse(row?.progress?.at ?? "") + 5_000);
    expect(
      await runs.reportProgress(
        fixture.tenantId,
        node.clusterId,
        opened.runId,
        { bytesDone: 600 },
        later,
      ),
    ).toEqual({ stored: true });
    expect((await guestOf(101))?.progress).toMatchObject({
      bytesDone: 600,
      bytesTotal: null,
      bytesPerSecond: 100,
    });
    // The guest page shows it on the running run.
    const detail = await service.guestDetail(shared.db, fixture.tenantId, row?.guestId ?? "");
    expect(detail.runs.find((r) => r.id === opened.runId)?.progress?.bytesDone).toBe(600);

    // A container backup reports with its run credential, for its own run only.
    const ct = await json<{ runId: string }>(
      await call(node, "/runs", {
        json: {
          vmid: 200,
          kind: "ct",
          archiveName: "ct/200/2026-10-12T22:00:00Z",
          storageId: "restow",
          startedAt: "2026-10-12T22:00:00Z",
        },
      }),
      201,
    );
    const token = generateAgentSecret();
    await fixture.db
      .update(pveRuns)
      .set({ resticTokenHash: token.hash, resticExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(pveRuns.id, ct.runId));
    await json(
      await progress(ct.runId, { bytesDone: 7, bytesTotal: 9 }, basic(ct.runId, token.value)),
      204,
    );
    expect((await guestOf(200))?.progress).toMatchObject({ bytesDone: 7, bytesTotal: 9 });
    expect((await progress(ct.runId, { bytesDone: 8 }, basic(ct.runId, "rsea_wrong"))).status).toBe(
      401,
    );
    // Another run's credential is no node credential either.
    expect(
      (await progress(opened.runId, { bytesDone: 8 }, basic(ct.runId, token.value))).status,
    ).toBe(401);

    // A closed run takes no progress.
    await json(
      await call(node, `/runs/${opened.runId}/finish`, {
        json: { status: "failed", error: "test" },
      }),
      204,
    );
    await expect(
      runs.reportProgress(
        fixture.tenantId,
        node.clusterId,
        opened.runId,
        { bytesDone: 1 },
        new Date(later.getTime() + 10_000),
      ),
    ).rejects.toMatchObject({ status: 409 });

    // The container commits with items restic could not read: the run and the point name them.
    const committed = await json<{ snapshotId: string }>(
      await call(node, `/runs/${ct.runId}/commit`, {
        json: {
          commitId: randomUUID(),
          guestConfig: "arch: amd64\n",
          firewallConfig: null,
          resticSnapshotId: "c".repeat(64),
          resticBytesAdded: 2_500_000,
          resticTotalBytes: 10_000_000,
          resticRoot: "/mnt/vzsnap0",
          resticUnreadable: 2,
          resticUnreadablePaths: ["/var/lib/a", "/var/lib/b"],
          consistency: "restic could not read 2 items (first: /var/lib/a)",
        },
      }),
    );
    const [point] = await fixture.db
      .select()
      .from(pveSnapshots)
      .where(eq(pveSnapshots.id, committed.snapshotId));
    expect(point?.stats).toMatchObject({
      resticUnreadable: 2,
      unreadablePaths: ["/var/lib/a", "/var/lib/b"],
    });
    expect(point?.byteSize).toBe(10_000_000);
    await json(
      await call(node, `/runs/${ct.runId}/finish`, { json: { status: "succeeded" } }),
      204,
    );
    expect(await guestOf(200)).toMatchObject({
      activity: null,
      progress: null,
      attention: expect.arrayContaining(["last_backup_incomplete"]),
    });
  });
  it("counts a job's scheduled round: how many of its guests are done, run and wait (#53)", async () => {
    const job = await service.saveJob(
      shared.db,
      fixture.tenantId,
      null,
      {
        name: "Nightly",
        scopeAll: false,
        schedule: { kind: "daily", timeOfDay: "22:00", timeZone: "UTC" },
        enabled: true,
        settings: {},
      },
      actor(),
    );
    expect(job).toMatchObject({ recommended: false, guestCount: 0, round: null });
    const started = new Date(Date.now() - 60_000);
    await fixture.db.update(pveJobs).set({ lastRunAt: started }).where(eq(pveJobs.id, job.id));
    const [vm] = await fixture.db.select().from(pveGuests).where(eq(pveGuests.vmid, 101));
    const [ct] = await fixture.db.select().from(pveGuests).where(eq(pveGuests.vmid, 200));
    const [node] = await fixture.db.select().from(pveNodes).limit(1);
    for (const guest of [vm, ct]) {
      await fixture.db
        .update(pveGuests)
        .set({ jobId: job.id })
        .where(eq(pveGuests.id, guest?.id ?? ""));
    }
    // The scheduler handed both guests to the node; the VM is done, the container waits.
    await fixture.db.insert(pveTasks).values([
      {
        tenantId: fixture.tenantId,
        nodeId: node?.id ?? "",
        guestId: vm?.id ?? "",
        kind: "backup",
        status: "done",
        params: { vmid: 101, jobId: job.id },
        createdAt: started,
      },
      {
        tenantId: fixture.tenantId,
        nodeId: node?.id ?? "",
        guestId: ct?.id ?? "",
        kind: "backup",
        status: "pending",
        params: { vmid: 200, jobId: job.id },
        createdAt: started,
      },
    ]);
    const overview = await service.overview(shared.db, fixture.tenantId);
    expect(overview.jobs.find((j) => j.id === job.id)).toMatchObject({
      guestCount: 2,
      round: { total: 2, done: 1, failed: 0, running: 0, queued: 1 },
    });
    expect(overview.guests.find((g) => g.vmid === 200)).toMatchObject({
      activity: "queued",
      activityJobId: job.id,
    });
    await fixture.db
      .update(pveTasks)
      .set({ status: "done" })
      .where(eq(pveTasks.guestId, ct?.id ?? ""));
    const after = await service.overview(shared.db, fixture.tenantId);
    expect(after.jobs.find((j) => j.id === job.id)?.round).toBeNull();
  });
  // --- 0.4.2: late task results, vzdump warnings, the Restow server's own VM, restore checks ---

  /** An incremental VM backup of 101 that changed nothing: a quick restore point. */
  async function quickCommit(time: string): Promise<{ runId: string; snapshotId: string }> {
    const run = await openRun(time);
    await json(
      await call(node, `/runs/${run.runId}/incremental`, {
        json: { devices: [{ device: "drive-scsi0", size: data1.length }] },
      }),
    );
    const committed = await json<{ snapshotId: string }>(
      await call(node, `/runs/${run.runId}/commit`, {
        json: {
          commitId: randomUUID(),
          devices: [
            {
              device: "drive-scsi0",
              size: data1.length,
              bitmapMode: "reuse",
              readBytes: 0,
              uploadedBytes: 0,
              changedBlocks: 0,
              zeroBlocks: 0,
              hashSkipped: 0,
            },
          ],
          guestConfig: "scsi0: x\n",
          firewallConfig: null,
        },
      }),
    );
    return { runId: run.runId, snapshotId: committed.snapshotId };
  }

  async function queuedBackup(): Promise<string> {
    const [vm] = await fixture.db.select().from(pveGuests).where(eq(pveGuests.vmid, 101));
    await fixture.db.delete(pveTasks).where(eq(pveTasks.guestId, vm?.id ?? ""));
    const queued = await service.backupNow(
      shared.db,
      fixture.tenantId,
      vm?.id ?? "",
      { verifyRead: false },
      actor(),
    );
    await call(node, "/heartbeat", { json: { helperVersion: "0.4.2", state: "idle" } });
    return queued.taskId;
  }

  it("marks a new restore point for a check right after its backup, unless switched off", async () => {
    const [snap] = await fixture.db
      .select()
      .from(pveSnapshots)
      .where(eq(pveSnapshots.id, first.snapshotId));
    expect(snap?.verifyRequestedAt).not.toBeNull();
    const settings = await import("./settings.js");
    expect(settings.resolvePveSettings({})).toEqual({ verifyAfterBackup: true });
    await fixture.db.execute(
      sql`INSERT INTO settings (pve_settings) VALUES ('{"verifyAfterBackup": false}'::jsonb)`,
    );
    try {
      expect(await settings.verifyAfterBackup(shared.providerDb)).toBe(false);
      await queuedBackup();
      const off = await quickCommit("2026-10-12T22:00:00Z");
      const [row] = await fixture.db
        .select()
        .from(pveSnapshots)
        .where(eq(pveSnapshots.id, off.snapshotId));
      expect(row?.verifyRequestedAt).toBeNull();
      await json(
        await call(node, `/runs/${off.runId}/finish`, { json: { status: "succeeded" } }),
        204,
      );
    } finally {
      await fixture.db.execute(sql`DELETE FROM settings`);
    }
  });

  it("a backup vzdump ended with warnings succeeded with them, also when the result comes late (C5, C6)", async () => {
    // restow-pve 0.4.2: the run reported its end, then the task comes with vzdump's warnings.
    const taskId = await queuedBackup();
    const done = await quickCommit("2026-10-13T22:00:00Z");
    await json(
      await call(node, `/runs/${done.runId}/finish`, { json: { status: "succeeded" } }),
      204,
    );
    const warning = "WARN: unable to set notes - restow: notes are not stored";
    await json(
      await call(node, `/tasks/${taskId}/result`, {
        json: { status: "done", result: { exitStatus: "WARNINGS: 1", warnings: [warning] } },
      }),
      204,
    );
    let [row] = await fixture.db.select().from(pveRuns).where(eq(pveRuns.id, done.runId));
    expect(row?.status).toBe("succeeded");
    expect(row?.stats.warnings).toEqual([warning]);
    // Sent again (the node kept it): nothing doubles.
    await json(
      await call(node, `/tasks/${taskId}/result`, {
        json: { status: "done", result: { warnings: [warning] } },
      }),
      204,
    );
    [row] = await fixture.db.select().from(pveRuns).where(eq(pveRuns.id, done.runId));
    expect(row?.stats.warnings).toEqual([warning]);
    const guest = (await service.overview(shared.db, fixture.tenantId)).guests.find(
      (g) => g.vmid === 101,
    );
    expect(guest).toMatchObject({ lastRunStatus: "succeeded", lastRunWarnings: [warning] });

    // restow-pve 0.4.1 reported the same backup as failed, before the run's end arrived.
    const oldTask = await queuedBackup();
    const old = await quickCommit("2026-10-14T22:00:00Z");
    await json(
      await call(node, `/tasks/${oldTask}/result`, {
        json: { status: "failed", error: 'vzdump ended with "WARNINGS: 1": TASK WARNINGS: 1' },
      }),
      204,
    );
    [row] = await fixture.db.select().from(pveRuns).where(eq(pveRuns.id, old.runId));
    expect(row?.status).toBe("succeeded");
    expect(row?.stats.warnings?.[0]).toContain("WARNINGS");
    const [task] = await fixture.db.select().from(pveTasks).where(eq(pveTasks.id, oldTask));
    expect(task?.status).toBe("done");
  });

  it("a late result settles a committed run the server closed meanwhile, and never fails it (C6)", async () => {
    const taskId = await queuedBackup();
    const run = await quickCommit("2026-10-15T22:00:00Z");
    // The task's time ran out while its run was still open (an outage): the heartbeat leaves it.
    await fixture.db
      .update(pveTasks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(pveTasks.id, taskId));
    await call(node, "/heartbeat", { json: { helperVersion: "0.4.2", state: "idle" } });
    let [task] = await fixture.db.select().from(pveTasks).where(eq(pveTasks.id, taskId));
    expect(task?.status).toBe("delivered");
    // An older server failed task and run; the restore point was committed all along.
    await fixture.db
      .update(pveTasks)
      .set({ status: "failed", errorMessage: "The node did not run the task in time." })
      .where(eq(pveTasks.id, taskId));
    await fixture.db
      .update(pveRuns)
      .set({ status: "failed", errorMessage: "The node did not run the task in time." })
      .where(eq(pveRuns.id, run.runId));
    // The node's result arrives after the outage: taken, and the run succeeded.
    await json(
      await call(node, `/tasks/${taskId}/result`, {
        json: { status: "done", result: { exitStatus: "OK" } },
      }),
      204,
    );
    const [row] = await fixture.db.select().from(pveRuns).where(eq(pveRuns.id, run.runId));
    expect(row).toMatchObject({ status: "succeeded", errorMessage: null });
    expect(row?.stats.warnings).toEqual(["The node did not run the task in time."]);
    [task] = await fixture.db.select().from(pveTasks).where(eq(pveTasks.id, taskId));
    expect(task).toMatchObject({ status: "done", errorMessage: null });
    // A failure the server closes a task with keeps a committed run's success.
    const { finishFailedTaskRun } = await import("./runs.js");
    const next = await queuedBackup();
    const kept = await quickCommit("2026-10-16T22:00:00Z");
    const [open] = await fixture.db.select().from(pveTasks).where(eq(pveTasks.id, next));
    const { withTenantTx } = await import("../../lib/tenant-context.js");
    await withTenantTx(shared.db, fixture.tenantId, (tx) =>
      finishFailedTaskRun(tx, open as never, "boom", new Date()),
    );
    const [keptRow] = await fixture.db.select().from(pveRuns).where(eq(pveRuns.id, kept.runId));
    expect(keptRow).toMatchObject({ status: "succeeded", errorMessage: null });
    expect(keptRow?.stats.warnings).toEqual(["boom"]);
    // A task this node never had stays unknown.
    expect(
      (await call(node, `/tasks/${randomUUID()}/result`, { json: { status: "done" } })).status,
    ).toBe(404);
  });

  it("finds the Restow server's own VM by its SMBIOS UUID and backs it up only when confirmed (C7)", async () => {
    const { resetOwnSmbiosUuid } = await import("./self-guest.js");
    const uuid = "7b0e3c5a-1d2f-4e6a-9b8c-0d1e2f3a4b5c";
    process.env.RESTOW_HOST_SMBIOS_UUID = uuid.toUpperCase();
    resetOwnSmbiosUuid();
    try {
      await json(
        await call(node, "/inventory", {
          json: {
            guests: [
              {
                vmid: 101,
                kind: "vm",
                name: "web",
                node: "pve1",
                disks: [{ device: "drive-scsi0", size: data1.length }],
              },
              { vmid: 102, kind: "vm", name: "restow", node: "pve1", smbiosUuid: uuid },
              { vmid: 200, kind: "ct", name: "db", node: "pve1", privileged: true },
            ],
          },
        }),
      );
    } finally {
      delete process.env.RESTOW_HOST_SMBIOS_UUID;
      resetOwnSmbiosUuid();
    }
    const [self] = await fixture.db.select().from(pveGuests).where(eq(pveGuests.vmid, 102));
    expect(self).toMatchObject({ restowServerDetected: true, selfBackupConfirmedAt: null });
    const [web] = await fixture.db.select().from(pveGuests).where(eq(pveGuests.vmid, 101));
    expect(web?.restowServerDetected).toBe(false);
    const dto = (await service.overview(shared.db, fixture.tenantId)).guests.find(
      (g) => g.vmid === 102,
    );
    expect(dto).toMatchObject({ restowServer: "detected" });
    expect(dto?.attention).toContain("restow_server");
    await expect(
      service.backupNow(
        shared.db,
        fixture.tenantId,
        self?.id ?? "",
        { verifyRead: false },
        actor(),
      ),
    ).rejects.toMatchObject({ status: 409, type: service.PVE_PROBLEMS.restowServer });
    const [job] = await fixture.db.select().from(pveJobs).limit(1);
    await expect(
      service.assignJob(shared.db, fixture.tenantId, self?.id ?? "", job?.id ?? "", actor()),
    ).rejects.toMatchObject({ status: 409 });
    // The recommended job leaves it out.
    expect(
      await service.assignJob(shared.db, fixture.tenantId, self?.id ?? "", job?.id ?? "", actor(), {
        skipRestowServer: true,
      }),
    ).toEqual({ assigned: false });
    const queued = await service.backupNow(
      shared.db,
      fixture.tenantId,
      self?.id ?? "",
      { verifyRead: false, confirmSelfBackup: true },
      actor(),
    );
    expect(queued.alreadyQueued).toBe(false);
    const confirmations = await fixture.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "pve.guest.self_backup_confirmed"));
    expect(confirmations).toHaveLength(1);
    await fixture.db.delete(pveTasks).where(eq(pveTasks.guestId, self?.id ?? ""));
    // An admin flags a guest the UUID cannot find (Restow in a container), and takes it back.
    const [ct] = await fixture.db.select().from(pveGuests).where(eq(pveGuests.vmid, 200));
    await service.setRestowServerFlag(shared.db, fixture.tenantId, ct?.id ?? "", true, actor());
    await expect(
      service.backupNow(shared.db, fixture.tenantId, ct?.id ?? "", { verifyRead: false }, actor()),
    ).rejects.toMatchObject({ status: 409 });
    await service.setRestowServerFlag(shared.db, fixture.tenantId, ct?.id ?? "", false, actor());
    const [unflagged] = await fixture.db.select().from(pveGuests).where(eq(pveGuests.vmid, 200));
    expect(unflagged).toMatchObject({ restowServerFlagged: false, selfBackupConfirmedAt: null });
    await fixture.db.delete(pveGuests).where(eq(pveGuests.vmid, 102));
  });

  it("checks a guest's newest restore point now, or every unchecked one, and an older one exactly (D2)", async () => {
    const [vm] = await fixture.db.select().from(pveGuests).where(eq(pveGuests.vmid, 101));
    await fixture.db.update(pveSnapshots).set({
      verifyRequestedAt: null,
      verify: { checkedAt: new Date().toISOString(), blocks: 1, mismatched: 0, errors: [] },
    });
    const { snapshotId } = await service.requestGuestVerify(
      shared.db,
      fixture.tenantId,
      vm?.id ?? "",
      actor(),
    );
    const points = await fixture.db
      .select()
      .from(pveSnapshots)
      .where(and(eq(pveSnapshots.guestId, vm?.id ?? ""), eq(pveSnapshots.status, "active")));
    const newest = points.reduce((a, b) => (a.sequence > b.sequence ? a : b));
    expect(snapshotId).toBe(newest.id);
    const readiness = await import("./protection.js");
    const { withTenantTx } = await import("../../lib/tenant-context.js");
    const rows = await withTenantTx(shared.db, fixture.tenantId, (tx) =>
      readiness.loadGuestProtection(tx, fixture.tenantId, new Date()),
    );
    expect(rows.rows.find((r) => r.vmid === 101)?.checkRequested).toBe(true);
    // An older restore point: exactly that one waits, its last result is cleared.
    const oldest = points.reduce((a, b) => (a.sequence < b.sequence ? a : b));
    await service.requestVerify(shared.db, fixture.tenantId, oldest.id, actor());
    const [old] = await fixture.db
      .select()
      .from(pveSnapshots)
      .where(eq(pveSnapshots.id, oldest.id));
    expect(old).toMatchObject({ verify: null });
    expect(old?.verifyRequestedAt).not.toBeNull();
    // "Check all unverified": the newest point of each guest without a result and no request.
    await fixture.db.update(pveSnapshots).set({ verifyRequestedAt: null, verify: null });
    const withPoints = await fixture.db.execute<{ n: number }>(
      sql`SELECT count(DISTINCT guest_id)::int AS n FROM pve_snapshots WHERE status = 'active'`,
    );
    expect(await service.requestUnverifiedVerify(shared.db, fixture.tenantId, actor())).toEqual({
      queued: withPoints.rows[0]?.n,
    });
    expect(await service.requestUnverifiedVerify(shared.db, fixture.tenantId, actor())).toEqual({
      queued: 0,
    });
  });

  it("shows the real error of a red restore check in the guest row (B2)", async () => {
    const [vm] = await fixture.db.select().from(pveGuests).where(eq(pveGuests.vmid, 101));
    const error = "drive-scsi0: Fatal: repository does not exist: unable to open config file";
    await fixture.db
      .update(pveSnapshots)
      .set({
        verifyRequestedAt: null,
        verify: { checkedAt: new Date().toISOString(), blocks: 0, mismatched: 0, errors: [error] },
      })
      .where(eq(pveSnapshots.guestId, vm?.id ?? ""));
    const guest = (await service.overview(shared.db, fixture.tenantId)).guests.find(
      (g) => g.vmid === 101,
    );
    expect(guest?.lastVerify).toMatchObject({ state: "red", errors: [error], requested: false });
    const detail = await service.guestDetail(shared.db, fixture.tenantId, vm?.id ?? "");
    expect(detail.guest.lastVerify?.errors).toEqual([error]);
  });

  it("plans a job on weekdays or monthly, like a mail job (E1)", async () => {
    const now = new Date("2026-10-21T12:00:00Z"); // a Wednesday
    const job = await service.saveJob(
      shared.db,
      fixture.tenantId,
      null,
      {
        name: "Workdays",
        scopeAll: false,
        schedule: { kind: "cron", cron: "30 2 * * 1-5", timeZone: "UTC" },
        enabled: true,
        settings: {},
      },
      actor(),
      now,
    );
    expect(job.nextRunAt).toBe("2026-10-22T02:30:00.000Z");
    await expect(
      service.saveJob(
        shared.db,
        fixture.tenantId,
        job.id,
        {
          name: "Workdays",
          scopeAll: false,
          schedule: { kind: "cron", cron: "not a cron", timeZone: "UTC" },
          enabled: true,
          settings: {},
        },
        actor(),
        now,
      ),
    ).rejects.toMatchObject({ status: 422 });
    const { jobSchema } = await import("./schemas.js");
    expect(
      jobSchema.safeParse({
        name: "x",
        schedule: { kind: "interval", intervalMinutes: 30, timeZone: "UTC" },
      }).success,
    ).toBe(false);
    expect(
      jobSchema.safeParse({
        name: "x",
        schedule: { kind: "interval", intervalMinutes: 14 * 24 * 60, timeZone: "UTC" },
      }).success,
    ).toBe(true);
    await service.deleteJob(shared.db, fixture.tenantId, job.id, actor());
  });

  it("keeps the installation's Proxmox VE settings and audits a change (D1)", async () => {
    const settings = await import("./settings.js");
    await fixture.db.execute(sql`INSERT INTO settings DEFAULT VALUES`);
    try {
      expect((await settings.getPveSettings(shared.providerDb)).settings).toEqual({
        verifyAfterBackup: true,
      });
      const saved = await settings.updatePveSettings(
        shared.providerDb,
        { verifyAfterBackup: false },
        { id: fixture.adminId, email: "admin@contoso.example", ip: null },
      );
      expect(saved.settings.verifyAfterBackup).toBe(false);
      expect(await settings.verifyAfterBackup(shared.providerDb)).toBe(false);
      const entries = await fixture.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "settings.pve.updated"));
      expect(entries).toHaveLength(1);
      expect(settings.pveSettingsSchema.safeParse({ other: 1 }).success).toBe(false);
    } finally {
      await fixture.db.execute(sql`DELETE FROM settings`);
    }
  });
});
