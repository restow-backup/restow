/**
 * File restore from a VM restore point against Postgres and a local storage target: a VM is
 * backed up through /agent/pve/v1 the way restow-pve does it (its disk is a real GPT image with
 * an EFI partition and ext4, made by mkfs, testdata of @restow/core), and the file restore reads
 * it back through the sandboxed user-space reader (the built @restow/core, a real child process
 * under Node's permission model):
 *
 *   - `/` lists the VM's file systems, below them their folders, page by page, audited,
 *   - a ZIP of a folder and a file whose entries match the image, audited, single use,
 *   - a path that is not there, another tenant's restore point: refused,
 *   - a disk whose bytes are damaged in storage: an error, never a wrong file.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { encodeFrame, PVE_BLOCK_SIZE } from "@restow/core";
import { auditLog, pveDownloads, pveGuests } from "@restow/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readZip } from "../../../../../packages/core/src/restore/testing/zip-reader.js";
import {
  basic,
  type EndpointFixture,
  startFixture,
  testDatabaseAdminUrl,
} from "../endpoints/testing/fixture.js";

const DATABASE = "restow_api_pve_vm_files_test";
const canRun = Boolean(testDatabaseAdminUrl);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

type Shared = typeof import("../../db.js");
type Files = typeof import("./files.js");
type Service = typeof import("./service.js");

const IMAGE = gunzipSync(
  readFileSync(
    new URL(
      "../../../../../packages/core/src/pve/guestfs/testdata/gpt-efi-ext4.img.gz",
      import.meta.url,
    ),
  ),
);

async function readAll(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of Readable.from(stream)) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

describe.skipIf(!canRun)("file restore of a VM restore point", () => {
  let fixture: EndpointFixture;
  let shared: Shared;
  let files: Files;
  let service: Service;
  let app: Hono;
  let node: { nodeId: string; nodeSecret: string };
  let pointId: string;
  const actor = () => ({
    label: "admin@contoso.example",
    userId: fixture.adminId,
    ip: "192.0.2.1",
  });

  const call = (path: string, init: { json?: unknown; body?: Buffer; method?: string } = {}) =>
    app.request(`/agent/pve/v1${path}`, {
      method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
      headers: {
        ...basic(node.nodeId, node.nodeSecret),
        ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.body ? { "content-type": "application/octet-stream" } : {}),
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });

  async function ok<T>(response: Response, status = 200): Promise<T> {
    const text = await response.text();
    expect(response.status, text).toBe(status);
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Back the image up as VM 101's scsi0: every block, as a first backup does. */
  async function backup(image: Buffer, time: string): Promise<string> {
    const run = await ok<{ runId: string }>(
      await call("/runs", {
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
    await ok(
      await call(`/runs/${run.runId}/incremental`, {
        json: { devices: [{ device: "drive-scsi0", size: image.length }] },
      }),
    );
    const blocks = Math.ceil(image.length / PVE_BLOCK_SIZE);
    for (let i = 0; i < blocks; i += 4) {
      const frame = [];
      for (let j = i; j < Math.min(blocks, i + 4); j++) {
        const data = image.subarray(j * PVE_BLOCK_SIZE, (j + 1) * PVE_BLOCK_SIZE);
        const zero = data.every((b) => b === 0);
        frame.push({
          device: "drive-scsi0",
          index: j,
          zero,
          length: data.length,
          sha256: zero ? "0".repeat(64) : sha(data),
          data: zero ? null : data,
        });
      }
      await ok(
        await call(`/runs/${run.runId}/blocks`, { method: "PUT", body: encodeFrame(frame) }),
      );
    }
    const commit = await ok<{ snapshotId: string }>(
      await call(`/runs/${run.runId}/commit`, {
        json: {
          commitId: randomUUID(),
          devices: [
            {
              device: "drive-scsi0",
              size: image.length,
              bitmapMode: "new",
              readBytes: image.length,
              uploadedBytes: image.length,
              changedBlocks: blocks,
            },
          ],
          guestConfig: "memory: 2048\nscsi0: local-lvm:vm-101-disk-0,size=48M\n",
          firewallConfig: null,
        },
      }),
    );
    await call(`/runs/${run.runId}/finish`, { json: { status: "succeeded" } });
    return commit.snapshotId;
  }

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    shared = await import("../../db.js");
    files = await import("./files.js");
    service = await import("./service.js");
    const { pveNodeRoutes } = await import("./node-routes.js");
    const { errorHandler } = await import("../../problem.js");
    app = new Hono();
    app.onError(errorHandler);
    app.route("/agent/pve/v1", pveNodeRoutes);
    const { token } = await service.createEnrollmentToken(shared.db, fixture.tenantId, actor(), {
      url: "https://restow.test.example",
    });
    node = await ok(
      await app.request("/agent/pve/v1/enroll", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.80" },
        body: JSON.stringify({
          token,
          clusterName: "lab",
          clusterFingerprint: "e".repeat(64),
          nodeName: "pve1",
          pveVersion: "9.2.1",
          helperVersion: "0.4.0",
          fleecingStorage: "local-lvm",
        }),
      }),
      201,
    );
    await ok(
      await call("/inventory", {
        json: {
          guests: [
            {
              vmid: 101,
              kind: "vm",
              name: "web",
              node: "pve1",
              status: "running",
              disks: [{ device: "drive-scsi0", size: IMAGE.length }],
            },
          ],
        },
      }),
    );
    pointId = await backup(IMAGE, "2026-10-03T22:00:00Z");
  }, 120_000);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  it("offers the VM restore point for browsing on the guest page", async () => {
    const [guest] = await fixture.db.select().from(pveGuests).where(eq(pveGuests.vmid, 101));
    const detail = await service.guestDetail(shared.db, fixture.tenantId, guest?.id ?? "");
    expect(detail.snapshots.find((s) => s.id === pointId)).toMatchObject({
      kind: "vm",
      browsable: true,
    });
  });

  it("lists the file systems, then their folders, page by page, and audits every page", async () => {
    const root = await files.browseContainerFiles(
      shared.db,
      fixture.tenantId,
      pointId,
      { path: "/", limit: 1000 },
      actor(),
    );
    expect(root.entries.map((e) => [e.name, e.type])).toEqual([
      ["scsi0-p1", "dir"],
      ["scsi0-p2", "dir"],
    ]);
    const anna = await files.browseContainerFiles(
      shared.db,
      fixture.tenantId,
      pointId,
      { path: "/scsi0-p2/home/anna", limit: 1000 },
      actor(),
    );
    expect(anna.entries.map((e) => e.name)).toEqual(["Documents", "notes.txt", "ümlaut-é.txt"]);
    expect(anna.entries[1]).toMatchObject({
      path: "/scsi0-p2/home/anna/notes.txt",
      type: "file",
      size: 11,
    });
    // 300 entries in pages of 120: no gap, no overlap.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const listed = await files.browseContainerFiles(
        shared.db,
        fixture.tenantId,
        pointId,
        { path: "/scsi0-p2/many", limit: 120, ...(cursor ? { cursor } : {}) },
        actor(),
      );
      seen.push(...listed.entries.map((e) => e.name));
      if (!listed.nextCursor) break;
      cursor = listed.nextCursor;
    }
    expect(seen).toHaveLength(300);
    expect(new Set(seen).size).toBe(300);
    const audits = await fixture.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "pve.snapshot.browsed"), eq(auditLog.target, pointId)));
    expect(audits.length).toBeGreaterThanOrEqual(5);
    expect(
      audits.some((a) => (a.details as { path?: string }).path === "/scsi0-p2/home/anna"),
    ).toBe(true);
  });

  it("refuses a path that is not there, and another tenant's restore point", async () => {
    await expect(
      files.browseContainerFiles(
        shared.db,
        fixture.tenantId,
        pointId,
        { path: "/scsi0-p2/nothing", limit: 10 },
        actor(),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      files.prepareContainerDownload(
        shared.db,
        fixture.tenantId,
        pointId,
        { paths: ["/scsi0-p2/etc/none"] },
        actor(),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      files.browseContainerFiles(
        shared.db,
        fixture.otherTenantId,
        pointId,
        { path: "/", limit: 10 },
        actor(),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("streams a ZIP of a folder and a file, once, for the admin who prepared it", async () => {
    const prepared = await files.prepareContainerDownload(
      shared.db,
      fixture.tenantId,
      pointId,
      { paths: ["/scsi0-p2/home/anna", "/scsi0-p2/var/log/big.bin", "/scsi0-p1/EFI"] },
      actor(),
    );
    expect(prepared.items).toBe(3);
    const download = await files.openContainerDownload(
      shared.db,
      fixture.tenantId,
      pointId,
      prepared.id,
      actor(),
    );
    expect(download.fileName).toBe("web-vm101-2026-10-03.zip");
    const entries = readZip(await readAll(download.stream));
    const text = (name: string) => entries.find((e) => e.name === name)?.data.toString("utf8");
    expect(text("anna/notes.txt")).toBe("Hello Anna\n");
    expect(text("anna/Documents/report 2026.txt")).toBe("Quarterly report\n");
    expect(text("EFI/BOOT/BOOTX64.EFI")).toBe("efi\n");
    expect(entries.find((e) => e.name === "big.bin")?.data.length).toBe(300 * 1024 + 123);
    await expect(
      files.openContainerDownload(shared.db, fixture.tenantId, pointId, prepared.id, actor()),
    ).rejects.toMatchObject({ status: 404 });
    const [row] = await fixture.db
      .select()
      .from(pveDownloads)
      .where(eq(pveDownloads.id, prepared.id));
    expect(row?.startedAt).not.toBeNull();
    const audits = await fixture.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "pve.snapshot.downloaded"), eq(auditLog.target, pointId)));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.details).toMatchObject({ kind: "vm", pathCount: 3 });
  });

  it("answers a disk damaged in storage with an error, never with a wrong file", async () => {
    // A second restore point whose ext4 superblock is garbage: the volume is not readable.
    const broken = Buffer.from(IMAGE);
    const ext4Start = 18432 * 512;
    broken.fill(0xa5, ext4Start + 1024, ext4Start + 2048);
    const brokenId = await backup(broken, "2026-10-04T22:00:00Z");
    const root = await files.browseContainerFiles(
      shared.db,
      fixture.tenantId,
      brokenId,
      { path: "/", limit: 100 },
      actor(),
    );
    expect(root.entries.map((e) => e.name)).toEqual(["scsi0-p1"]);
    await expect(
      files.browseContainerFiles(
        shared.db,
        fixture.tenantId,
        brokenId,
        { path: "/scsi0-p2", limit: 10 },
        actor(),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
