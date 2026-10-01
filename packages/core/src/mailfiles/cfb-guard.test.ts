import { readFileSync, readdirSync } from "node:fs";
import { CFB } from "@tutao/oxmsg";
import { describe, expect, it } from "vitest";
import { MAX_DIRECTORY_ENTRIES, MAX_STORAGE_DEPTH, checkCompoundFile } from "./cfb-guard.js";
import { buildMsg } from "./testing/builders.js";
import { type CfbEntrySpec, ENTRY, HEADER, buildCfb, entryNamed } from "./testing/cfb.js";

const testdata = new URL("./testdata/", import.meta.url);

/** A small compound file with a mini stream, a big stream and a nested storage. */
function sample(sectorShift: 9 | 12 = 9) {
  return buildCfb({
    sectorShift,
    entries: [
      { name: "__properties_version1.0", data: Buffer.alloc(100, 1) },
      { name: "big", data: Buffer.alloc(9000, 65) },
      { name: "small", data: Buffer.alloc(200, 66) },
      { name: "tiny", data: Buffer.alloc(10, 67) },
      { name: "folder" },
      { name: "inner", parent: 5, data: Buffer.alloc(5000, 68) },
    ],
  });
}

function refused(bytes: Buffer): string {
  const result = checkCompoundFile(bytes);
  expect(result.ok).toBe(false);
  return (result as { detail: string }).detail;
}

/** A generated MSG large enough that its FAT does not fit the header (130 FAT sectors, one DIFAT sector). */
function largeMsg(): Promise<Buffer> {
  return buildMsg({
    from: { address: "a@example.test" },
    to: [{ address: "b@example.test" }],
    subject: "large",
    body: "b",
    attachments: [{ filename: "a.bin", content: Buffer.alloc(8 * 1024 * 1024, 7) }],
  });
}

describe("checkCompoundFile with honest files", () => {
  it("accepts every Outlook fixture except the damaged one", () => {
    const names = readdirSync(testdata).filter((name) => name.endsWith(".msg"));
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const name of names) {
      const result = checkCompoundFile(readFileSync(new URL(name, testdata)));
      expect(result.ok, name).toBe(name !== "corrupt-endless-loop.msg");
    }
  });

  it("accepts a generated MSG, with and without attachments", async () => {
    const plain = await buildMsg({
      from: { address: "a@example.test" },
      to: [{ address: "b@example.test" }],
      subject: "s",
      body: "b",
    });
    const withAttachment = await buildMsg({
      from: { address: "a@example.test" },
      to: [{ address: "b@example.test" }],
      subject: "s",
      body: "b",
      html: "<p>b</p>",
      attachments: [{ filename: "a.bin", content: Buffer.alloc(300_000, 7) }],
    });
    expect(checkCompoundFile(plain).ok).toBe(true);
    expect(checkCompoundFile(withAttachment).ok).toBe(true);
  });

  it("accepts a compound file of a reference writer (CFB) and of the test builder", () => {
    const cfb = CFB.utils.cfb_new();
    CFB.utils.cfb_add(cfb, "/small", Buffer.from("hello"));
    CFB.utils.cfb_add(cfb, "/big", Buffer.alloc(70_000, 3));
    const reference = Buffer.from(CFB.write(cfb, { type: "buffer" }) as Uint8Array);
    expect(checkCompoundFile(reference).ok).toBe(true);
    expect(checkCompoundFile(sample().bytes)).toMatchObject({ ok: true, streams: 5 });
    expect(checkCompoundFile(sample(12).bytes)).toMatchObject({
      ok: true,
      sectorSize: 4096,
      streams: 5,
    });
  });

  it("accepts a generated MSG large enough to need DIFAT sectors", async () => {
    const msg = await largeMsg();
    expect(msg.readUInt32LE(HEADER.fatSectors)).toBeGreaterThan(109);
    expect(msg.readUInt32LE(HEADER.difatSectors)).toBeGreaterThanOrEqual(1);
    expect(checkCompoundFile(msg).ok).toBe(true);
  }, 60_000);

  it("accepts files whose FAT needs more than one sector", () => {
    const { bytes } = buildCfb({
      entries: [{ name: "large", data: Buffer.alloc(200_000, 9) }],
    });
    expect(checkCompoundFile(bytes)).toMatchObject({ ok: true, streams: 1 });
  });
});

describe("checkCompoundFile with hostile files", () => {
  it("refuses a directory chain that loops (the file that exhausted the heap)", () => {
    const { bytes, layout } = sample();
    const last = layout.directorySectors[layout.directorySectors.length - 1] as number;
    bytes.writeUInt32LE(last, layout.fatEntryOffset(last));
    expect(refused(bytes)).toContain("used twice");
  });

  it("refuses a stream chain that loops back to its start", () => {
    const { bytes, layout } = sample();
    const big = entryNamed(layout, "big");
    bytes.writeUInt32LE(
      big.chain[0] as number,
      layout.fatEntryOffset(big.chain[big.chain.length - 1] as number),
    );
    // The chain is walked for the size the entry names: make the stream claim more sectors than it has.
    bytes.writeUInt32LE(big.size + 3 * 512, layout.entryOffset(big.index) + ENTRY.sizeLow);
    expect(refused(bytes)).toContain("used twice");
  });

  it("refuses a mini stream chain that loops", () => {
    const { bytes, layout } = sample();
    const small = entryNamed(layout, "small");
    bytes.writeUInt32LE(
      small.chain[0] as number,
      layout.miniFatEntryOffset(small.chain[small.chain.length - 1] as number),
    );
    expect(refused(bytes)).toContain("mini sector that is used twice");
  });

  it("refuses a mini stream container chain that loops", () => {
    const { bytes, layout } = sample();
    const sectors = layout.miniStreamSectors;
    bytes.writeUInt32LE(
      sectors[0] as number,
      layout.fatEntryOffset(sectors[sectors.length - 1] as number),
    );
    expect(refused(bytes)).toContain("mini stream");
  });

  it("refuses two streams that share their sectors", () => {
    const { bytes, layout } = sample();
    const big = entryNamed(layout, "big");
    const inner = entryNamed(layout, "inner");
    bytes.writeUInt32LE(big.startSector, layout.entryOffset(inner.index) + ENTRY.startSector);
    expect(refused(bytes)).toContain("used twice");
  });

  it("refuses two small streams that share a mini sector", () => {
    const { bytes, layout } = sample();
    const small = entryNamed(layout, "small");
    const tiny = entryNamed(layout, "tiny");
    bytes.writeUInt32LE(small.startSector, layout.entryOffset(tiny.index) + ENTRY.startSector);
    expect(refused(bytes)).toContain("mini sector");
  });

  it("refuses a stream that claims more than the file holds", () => {
    for (const size of [0x7fffffff, 1 << 30, 5_000_000]) {
      const { bytes, layout } = sample();
      const big = entryNamed(layout, "big");
      bytes.writeUInt32LE(size, layout.entryOffset(big.index) + ENTRY.sizeLow);
      expect(refused(bytes), String(size)).toMatch(/larger than the file|longer than the sectors/);
    }
  });

  it("refuses sizes of 2 GiB and more, also in the high dword", () => {
    const { bytes, layout } = sample();
    const big = entryNamed(layout, "big");
    bytes.writeUInt32LE(0x80000000, layout.entryOffset(big.index) + ENTRY.sizeLow);
    expect(refused(bytes)).toContain("2 GiB");
    const other = sample();
    other.bytes.writeUInt32LE(1, other.layout.entryOffset(big.index) + ENTRY.sizeHigh);
    expect(refused(other.bytes)).toContain("2 GiB");
  });

  it("refuses a small stream that claims more mini sectors than it has", () => {
    const { bytes, layout } = sample();
    const small = entryNamed(layout, "small");
    bytes.writeUInt32LE(4000, layout.entryOffset(small.index) + ENTRY.sizeLow);
    // 4000 bytes stay below the cutoff but need 63 mini sectors, the chain has 4.
    expect(refused(bytes)).toContain("longer than the mini sectors");
  });

  it("refuses a directory whose links loop", () => {
    const { bytes, layout } = sample();
    const folder = entryNamed(layout, "folder");
    // The storage becomes its own child.
    bytes.writeUInt32LE(folder.index, layout.entryOffset(folder.index) + ENTRY.child);
    expect(refused(bytes)).toContain("loops back");
    const second = sample();
    // A sibling link that points back to the first entry.
    second.bytes.writeUInt32LE(1, second.layout.entryOffset(3) + ENTRY.right);
    expect(refused(second.bytes)).toContain("loops back");
  });

  it("refuses storages nested deeper than the limit", () => {
    const entries: CfbEntrySpec[] = [];
    for (let depth = 0; depth <= MAX_STORAGE_DEPTH + 2; depth++) {
      entries.push({ name: `d${depth}`, ...(depth > 0 ? { parent: depth } : {}) });
    }
    expect(refused(buildCfb({ entries }).bytes)).toContain("nested");
    const shallow = entries.slice(0, MAX_STORAGE_DEPTH - 2);
    expect(checkCompoundFile(buildCfb({ entries: shallow }).bytes).ok).toBe(true);
  });

  it("refuses links and sectors outside the file", () => {
    const outsideLink = sample();
    outsideLink.bytes.writeUInt32LE(900_000, outsideLink.layout.entryOffset(0) + ENTRY.child);
    expect(refused(outsideLink.bytes)).toContain("outside the directory");

    const outsideSector = sample();
    const big = entryNamed(outsideSector.layout, "big");
    outsideSector.bytes.writeUInt32LE(
      0x00ffffff,
      outsideSector.layout.entryOffset(big.index) + ENTRY.startSector,
    );
    expect(refused(outsideSector.bytes)).toContain("outside the file");

    const chainOut = sample();
    const inner = entryNamed(chainOut.layout, "inner");
    chainOut.bytes.writeUInt32LE(
      0x00ffffff,
      chainOut.layout.fatEntryOffset(inner.chain[0] as number),
    );
    expect(refused(chainOut.bytes)).toContain("outside the file");
  });

  it("refuses a special sector number inside a chain", () => {
    const { bytes, layout } = sample();
    const big = entryNamed(layout, "big");
    bytes.writeUInt32LE(0xffffffff, layout.fatEntryOffset(big.chain[0] as number));
    expect(refused(bytes)).toContain("special sector");
  });

  it("refuses absurd header counts without allocating for them", () => {
    const huge = sample();
    huge.bytes.writeUInt32LE(0x7fffffff, HEADER.fatSectors);
    expect(refused(huge.bytes)).toContain("FAT sectors");

    // A DIFAT chain that points to itself, with a count of two billion.
    const difat = sample();
    difat.bytes.writeUInt32LE(110, HEADER.fatSectors);
    difat.bytes.writeUInt32LE(difat.layout.directorySectors[0] as number, HEADER.firstDifat);
    difat.bytes.writeUInt32LE(0x7fffffff, HEADER.difatSectors);
    expect(refused(difat.bytes)).toMatch(/FAT sector list|FAT sectors|used twice|outside/);

    // A mini FAT that loops, with a count of two billion mini FAT sectors.
    const mini = sample();
    mini.bytes.writeUInt32LE(0x7fffffff, HEADER.miniFatSectors);
    const miniFat = mini.layout.miniFatSectors[0] as number;
    mini.bytes.writeUInt32LE(miniFat, mini.layout.fatEntryOffset(miniFat));
    expect(refused(mini.bytes)).toContain("used twice");
  });

  it("refuses a DIFAT chain that loops and one that lists fewer FAT sectors than the header says", async () => {
    const fewer = await largeMsg();
    // Far more FAT sectors than the one DIFAT sector lists (the rest of its entries are free).
    fewer.writeUInt32LE(1000, HEADER.fatSectors);
    expect(refused(fewer)).toContain("outside the file");

    const loop = await largeMsg();
    const firstDifat = loop.readUInt32LE(HEADER.firstDifat);
    const at = (firstDifat + 1) * 512;
    // The DIFAT sector lists plausible sectors for all its 127 entries and names itself as its
    // successor, while the header claims 300 FAT sectors: the chain would have to be followed forever.
    loop.writeUInt32LE(300, HEADER.fatSectors);
    loop.writeUInt32LE(5, HEADER.difatSectors);
    for (let i = 0; i < 127; i++) {
      if (loop.readUInt32LE(at + 4 * i) === 0xffffffff) {
        loop.writeUInt32LE(5000 + i, at + 4 * i);
      }
    }
    loop.writeUInt32LE(firstDifat, at + 508);
    expect(refused(loop)).toContain("used twice");
  }, 60_000);

  it("refuses header fields msgreader would misread", () => {
    const sectorSize = sample();
    sectorSize.bytes.writeUInt16LE(10, HEADER.sectorShift);
    expect(refused(sectorSize.bytes)).toContain("sector size");

    const miniSize = sample();
    miniSize.bytes.writeUInt16LE(7, HEADER.miniSectorShift);
    expect(refused(miniSize.bytes)).toContain("mini sector size");

    const cutoff = sample();
    cutoff.bytes.writeUInt32LE(1, HEADER.miniCutoff);
    expect(refused(cutoff.bytes)).toContain("cutoff");

    const order = sample();
    order.bytes.writeUInt16LE(0xfeff, 28);
    expect(refused(order.bytes)).toContain("byte order");
  });

  it("refuses a directory without a root entry", () => {
    const noRoot = sample();
    noRoot.bytes[noRoot.layout.entryOffset(0) + ENTRY.type] = 0;
    expect(refused(noRoot.bytes)).toContain("root entry");
  });

  it("refuses a directory with more entries than a message can have", () => {
    const entries = Array.from({ length: MAX_DIRECTORY_ENTRIES }, (_, i) => ({ name: `s${i}` }));
    expect(refused(buildCfb({ entries, sectorShift: 12 }).bytes)).toContain("entries");
    const fewer = entries.slice(0, 2000);
    expect(checkCompoundFile(buildCfb({ entries: fewer, sectorShift: 12 }).bytes).ok).toBe(true);
  });

  it("refuses truncated files and non-compound files without throwing", () => {
    const { bytes } = sample();
    for (const length of [0, 7, 100, 511, 512, 1024, 1536, bytes.length - 700]) {
      const result = checkCompoundFile(bytes.subarray(0, length));
      expect(result.ok, String(length)).toBe(false);
    }
    expect(checkCompoundFile(Buffer.from("not a compound file".repeat(100))).ok).toBe(false);
  });

  it("is linear: a large honest file is checked in well under a second", () => {
    const { bytes } = buildCfb({
      entries: [
        { name: "a", data: Buffer.alloc(3_000_000, 1) },
        { name: "b", data: Buffer.alloc(3_000_000, 2) },
      ],
    });
    const started = Date.now();
    expect(checkCompoundFile(bytes).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
