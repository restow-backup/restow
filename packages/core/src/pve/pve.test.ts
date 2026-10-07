import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BLOCK_FLAG_PRESENT,
  BLOCK_FLAG_ZERO,
  type BlockMap,
  PVE_BLOCK_SIZE,
  PveFormatError,
  blockCount,
  blockLength,
  decodeBlockMap,
  decodeFrame,
  encodeBlockMap,
  encodeFrame,
  encodeHashList,
  hashListDigest,
  mapChunkIds,
} from "./formats.js";
import {
  IncompleteDiskError,
  archiveNameOf,
  buildBlockMap,
  buildPveManifest,
  parseArchiveName,
  pveDisksOf,
  sampleDataBlocks,
} from "./model.js";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const id = (n: number) => sha(`chunk-${n}`);
const golden = (name: string) =>
  readFileSync(new URL(`../../../../agent/internal/pve/testdata/${name}`, import.meta.url));

describe("formats shared with restow-pve", () => {
  it("decodes the frame the Go helper encodes", () => {
    const blocks = decodeFrame(golden("frame.bin"));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      device: "drive-scsi0",
      index: 2,
      zero: false,
      length: 5,
      sha256: sha("short"),
    });
    expect(blocks[0]?.data?.toString()).toBe("short");
    expect(blocks[1]).toMatchObject({ index: 1, zero: true, length: PVE_BLOCK_SIZE, data: null });
    expect(encodeFrame(blocks).equals(golden("frame.bin"))).toBe(true);
  });

  it("encodes the hash list byte for byte as the Go helper", () => {
    const map: BlockMap = {
      diskSize: 2 * PVE_BLOCK_SIZE + 10,
      entries: [
        { flags: BLOCK_FLAG_PRESENT, sha256: sha("block zero"), chunks: [id(1)] },
        { flags: BLOCK_FLAG_ZERO, sha256: "0".repeat(64), chunks: [] },
        { flags: BLOCK_FLAG_PRESENT, sha256: sha("short"), chunks: [id(2)] },
      ],
    };
    expect(encodeHashList(map).equals(golden("hashes.bin"))).toBe(true);
    expect(hashListDigest(map)).toBe(sha(golden("hashes.bin")));
  });

  it("refuses malformed frames", () => {
    expect(() => decodeFrame(Buffer.from("nope"))).toThrow(PveFormatError);
    const frame = golden("frame.bin");
    expect(() => decodeFrame(frame.subarray(0, frame.length - 1))).toThrow(PveFormatError);
    expect(() => decodeFrame(Buffer.concat([frame, Buffer.from([0])]))).toThrow(/trailing/);
  });

  it("round-trips block maps and lists their chunks once", () => {
    const map: BlockMap = {
      diskSize: 3 * PVE_BLOCK_SIZE,
      entries: [
        { flags: BLOCK_FLAG_PRESENT, sha256: sha("a"), chunks: [id(1), id(2)] },
        { flags: BLOCK_FLAG_ZERO, sha256: "0".repeat(64), chunks: [] },
        { flags: BLOCK_FLAG_PRESENT, sha256: sha("a"), chunks: [id(1), id(2)] },
      ],
    };
    const bytes = encodeBlockMap(map);
    expect(decodeBlockMap(bytes)).toEqual(map);
    expect(mapChunkIds(map)).toEqual([id(1), id(2)]);
    expect(() => decodeBlockMap(bytes.subarray(0, bytes.length - 2))).toThrow(PveFormatError);
    expect(blockCount(PVE_BLOCK_SIZE + 1)).toBe(2);
    expect(blockLength(PVE_BLOCK_SIZE + 1, 1)).toBe(1);
  });
});

describe("buildBlockMap", () => {
  const size = 3 * PVE_BLOCK_SIZE + 100;
  const full = (n: number) => ({
    index: n,
    zero: false,
    sha256: sha(`b${n}`),
    chunks: [id(n)],
    length: blockLength(size, n),
  });

  it("a first backup must report every block", () => {
    expect(() => buildBlockMap("drive-scsi0", size, null, [full(0), full(1)])).toThrow(
      IncompleteDiskError,
    );
    const map = buildBlockMap("drive-scsi0", size, null, [full(0), full(1), full(2), full(3)]);
    expect(map.entries.map((e) => e.chunks[0])).toEqual([id(0), id(1), id(2), id(3)]);
  });

  it("base plus delta equals the full map", () => {
    const base = buildBlockMap("d", size, null, [full(0), full(1), full(2), full(3)]);
    const changed = {
      index: 2,
      zero: false,
      sha256: sha("new"),
      chunks: [id(9)],
      length: PVE_BLOCK_SIZE,
    };
    const zeroed = {
      index: 1,
      zero: true,
      sha256: "0".repeat(64),
      chunks: [],
      length: PVE_BLOCK_SIZE,
    };
    const next = buildBlockMap("d", size, base, [changed, zeroed]);
    expect(next.entries[0]).toEqual(base.entries[0]);
    expect(next.entries[1]?.flags).toBe(BLOCK_FLAG_ZERO);
    expect(next.entries[2]?.chunks).toEqual([id(9)]);
    expect(next.entries[3]).toEqual(base.entries[3]);
    // The base is not modified (it belongs to another restore point).
    expect(base.entries[2]?.chunks).toEqual([id(2)]);
    // A base of another size is no base.
    expect(() => buildBlockMap("d", size + PVE_BLOCK_SIZE, base, [changed])).toThrow(
      IncompleteDiskError,
    );
  });

  it("refuses blocks outside the disk or of the wrong length", () => {
    expect(() => buildBlockMap("d", size, null, [{ ...full(0), index: 9 }])).toThrow(/outside/);
    expect(() => buildBlockMap("d", size, null, [{ ...full(3), length: PVE_BLOCK_SIZE }])).toThrow(
      /expected 100/,
    );
  });
});

describe("restore point naming and manifests", () => {
  it("parses archive and volume names", () => {
    const t = new Date("2026-10-03T22:00:00Z");
    expect(archiveNameOf("vm", 101, t)).toBe("vm/101/2026-10-03T22:00:00Z");
    expect(parseArchiveName("backup/ct/200/2026-10-03T22:00:00Z")).toMatchObject({
      kind: "ct",
      vmid: 200,
    });
    expect(parseArchiveName("vm/101/../../etc")).toBeNull();
    expect(parseArchiveName("vzdump-qemu-101.vma.zst")).toBeNull();
  });

  it("builds a manifest whose disks can be found again", () => {
    const manifest = buildPveManifest({
      tenantId: "t",
      snapshotId: "s",
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
      config: { chunks: [id(1)], size: 10, sha256: sha("x") },
      firewall: null,
      disks: [
        {
          device: "drive-scsi0",
          diskSize: 1024,
          map: { chunks: [id(2)], size: 60, sha256: sha("m") },
          changedBlocks: 1,
          zeroBlocks: 0,
          bitmapMode: "new",
        },
      ],
      packs: [],
    });
    expect(manifest.source.type).toBe("pve");
    expect(manifest.objects.map((o) => o.path)).toEqual([
      "config/qemu-server.conf",
      "disks/drive-scsi0.map",
    ]);
    expect(pveDisksOf(manifest)).toEqual([
      expect.objectContaining({ device: "drive-scsi0", diskSize: 1024 }),
    ]);
  });

  it("samples data blocks only", () => {
    const map: BlockMap = {
      diskSize: 4 * PVE_BLOCK_SIZE,
      entries: [0, 1, 2, 3].map((n) =>
        n === 1
          ? { flags: BLOCK_FLAG_ZERO, sha256: "0".repeat(64), chunks: [] }
          : { flags: BLOCK_FLAG_PRESENT, sha256: sha(String(n)), chunks: [id(n)] },
      ),
    };
    expect(sampleDataBlocks(map, 10)).toEqual([0, 2, 3]);
    expect(sampleDataBlocks(map, 2, () => 0)).toHaveLength(2);
  });
});
