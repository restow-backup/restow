/**
 * Standalone restore of a Proxmox VE VM restore point (docs/PVE.md): from the
 * chunk store and the manifest alone, the disk comes back as a sparse raw
 * image, bit for bit, with zero blocks as holes; a block that does not match
 * its map fails the disk and leaves no file behind.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BLOCK_FLAG_PRESENT,
  type Dek,
  LocalStorageBackend,
  PVE_BLOCK_SIZE,
  PackWriter,
  buildPveManifest,
  encodeBlockMap,
  encryptChunk,
  storedId,
  zeroEntry,
} from "@restow/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keyring } from "./keyring.js";
import { restoreSnapshot } from "./restore.js";
import { ChunkStore } from "./store.js";

const TENANT = "tenant-pve";
const hmacKey = Buffer.alloc(32, 0x05);
const dek: Dek = { version: 1, material: Buffer.alloc(32, 0x08) };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let root: string;
let backend: LocalStorageBackend;
const blocks = [Buffer.alloc(PVE_BLOCK_SIZE, 0x11), null, Buffer.alloc(1234, 0x33)];
const disk = Buffer.concat(blocks.map((b, i) => b ?? Buffer.alloc(i === 1 ? PVE_BLOCK_SIZE : 0)));

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "restow-cli-pve-"));
  backend = new LocalStorageBackend(join(root, "store"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function storeRestorePoint(tamper: boolean) {
  const writer = new PackWriter(TENANT);
  const put = (data: Buffer) => {
    const id = storedId(hmacKey, data);
    writer.append(id, encryptChunk(dek, data, id));
    return id.toString("hex");
  };
  const entries = blocks.map((b) =>
    b
      ? {
          flags: BLOCK_FLAG_PRESENT,
          sha256: tamper ? sha(Buffer.from("x")) : sha(b),
          chunks: [put(b)],
        }
      : zeroEntry(),
  );
  const map = encodeBlockMap({ diskSize: disk.length, entries });
  const mapId = put(map);
  const conf = Buffer.from("scsi0: local-lvm:vm-101-disk-0,size=8M\n");
  const confId = put(conf);
  await backend.put(`tenants/${TENANT}/packs/00/pack-${tamper ? "b" : "a"}`, writer.finalize());
  return buildPveManifest({
    tenantId: TENANT,
    snapshotId: tamper ? "bad" : "good",
    guestId: "g",
    createdAt: new Date(0),
    sequence: 1,
    state: {
      kind: "pve-vm",
      clusterId: "c",
      vmid: 101,
      node: "pve1",
      archiveName: "vm/101/x",
      storageId: "restow",
    },
    config: { chunks: [confId], size: conf.length, sha256: sha(conf) },
    firewall: null,
    disks: [
      {
        device: "drive-scsi0",
        diskSize: disk.length,
        map: { chunks: [mapId], size: map.length, sha256: sha(map) },
        changedBlocks: 2,
        zeroBlocks: 1,
        bitmapMode: "new",
      },
    ],
    packs: [],
  });
}

describe("standalone restore of a Proxmox VE VM", () => {
  it("writes the disk as a raw image, bit for bit", async () => {
    const manifest = await storeRestorePoint(false);
    const store = await ChunkStore.build(backend, TENANT);
    const outDir = join(root, "out");
    const report = await restoreSnapshot({
      manifest,
      store,
      keyring: new Keyring([dek], hmacKey),
      outDir,
    });
    expect(report.failed).toBe(0);
    expect(report.results.map((r) => r.path)).toEqual([
      "config/qemu-server.conf",
      "disks/drive-scsi0.map",
      "disks/drive-scsi0.raw",
    ]);
    const raw = await readFile(join(outDir, "disks/drive-scsi0.raw"));
    expect(raw.length).toBe(disk.length);
    expect(raw.equals(disk)).toBe(true);
    expect(
      (await readFile(join(outDir, "config/qemu-server.conf"), "utf8")).startsWith("scsi0:"),
    ).toBe(true);
  });

  it("fails a disk whose block does not match its map and leaves nothing", async () => {
    const manifest = await storeRestorePoint(true);
    const store = await ChunkStore.build(backend, TENANT);
    const outDir = join(root, "out-bad");
    const report = await restoreSnapshot({
      manifest,
      store,
      keyring: new Keyring([dek], hmacKey),
      outDir,
    });
    expect(report.failures.map((f) => f.path)).toEqual(["disks/drive-scsi0.raw"]);
    expect(report.failures[0]?.integrity).toBe(true);
    expect((await readdir(join(outDir, "disks"))).sort()).toEqual(["drive-scsi0.map"]);
  });
});
