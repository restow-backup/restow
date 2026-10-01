/**
 * A small writer for OLE compound files (MS-CFB) whose layout the caller can
 * read back and damage on purpose. It exists for the tests of the MSG guard
 * (../cfb-guard.ts, ../msg.ts): a hostile file is a valid one with one sector
 * pointer, size or directory link bent, so the builder reports where every
 * structure lies instead of hiding it like a real library does. Nothing here
 * is used at run time.
 *
 * What it writes: a header, FAT sectors, directory sectors, a mini FAT and a
 * mini stream when a stream is smaller than 4096 bytes, and big streams as
 * plain sector chains. All streams hang below the root storage (or below a
 * storage listed in `storages`), as one sibling chain per parent. That is not a
 * balanced red-black tree, which is fine for readers that do not rebalance.
 * No DIFAT: up to 109 FAT sectors, enough for files of several megabytes.
 */

export const ENDOFCHAIN = 0xfffffffe;
export const FREESECT = 0xffffffff;
export const FATSECT = 0xfffffffd;
export const NOSTREAM = 0xffffffff;

export interface CfbEntrySpec {
  readonly name: string;
  /** Index of the parent in `entries` (the root is entry 0 and the default parent). */
  readonly parent?: number;
  /** A storage has no data; a stream has `data`. */
  readonly data?: Buffer;
}

export interface CfbBuildOptions {
  /** Entries after the root, in directory order. Entry numbers are position + 1. */
  readonly entries: readonly CfbEntrySpec[];
  /** 9 (512-byte sectors, version 3) or 12 (4096-byte sectors, version 4). */
  readonly sectorShift?: 9 | 12;
}

export interface CfbEntryLayout {
  readonly name: string;
  /** Directory entry number (the root is 0). */
  readonly index: number;
  readonly type: "root" | "storage" | "stream";
  readonly size: number;
  /** First sector (a mini sector for a mini stream); ENDOFCHAIN for nothing. */
  readonly startSector: number;
  readonly mini: boolean;
  /** The sectors (or mini sectors) of the chain, in order. */
  readonly chain: readonly number[];
}

export interface CfbLayout {
  readonly sectorSize: number;
  readonly sectorCount: number;
  readonly fatSectors: readonly number[];
  readonly directorySectors: readonly number[];
  readonly miniFatSectors: readonly number[];
  /** Sectors holding the mini stream (the root entry's chain). */
  readonly miniStreamSectors: readonly number[];
  readonly entries: readonly CfbEntryLayout[];
  /** Byte offset of a sector in the file. */
  sectorOffset(sector: number): number;
  /** Byte offset of the FAT entry of a sector. */
  fatEntryOffset(sector: number): number;
  /** Byte offset of the mini FAT entry of a mini sector. */
  miniFatEntryOffset(miniSector: number): number;
  /** Byte offset of a directory entry. */
  entryOffset(index: number): number;
}

export interface BuiltCfb {
  readonly bytes: Buffer;
  readonly layout: CfbLayout;
}

const SIGNATURE = Buffer.from("d0cf11e0a1b11ae1", "hex");
const MINI_SECTOR = 64;
const MINI_CUTOFF = 4096;
const ENTRY_SIZE = 128;

function ceilDiv(a: number, b: number): number {
  return Math.ceil(a / b);
}

/** Header field offsets (MS-CFB 2.2), exported so tests can bend a field. */
export const HEADER = {
  sectorShift: 30,
  miniSectorShift: 32,
  directorySectors: 40,
  fatSectors: 44,
  firstDirectory: 48,
  miniCutoff: 56,
  firstMiniFat: 60,
  miniFatSectors: 64,
  firstDifat: 68,
  difatSectors: 72,
  difat: 76,
} as const;

/** Directory entry field offsets (MS-CFB 2.6.1). */
export const ENTRY = {
  nameLength: 64,
  type: 66,
  left: 68,
  right: 72,
  child: 76,
  startSector: 116,
  sizeLow: 120,
  sizeHigh: 124,
} as const;

export function buildCfb(options: CfbBuildOptions): BuiltCfb {
  const sectorShift = options.sectorShift ?? 9;
  const sectorSize = 1 << sectorShift;
  const perSector = sectorSize / 4;
  const entriesPerSector = sectorSize / ENTRY_SIZE;

  const specs: readonly CfbEntrySpec[] = [{ name: "Root Entry" }, ...options.entries];
  const isStream = (spec: CfbEntrySpec): boolean => spec.data !== undefined;

  // Mini streams first: their bytes go into one container, 64-byte sectors.
  const miniChains = new Map<number, number[]>();
  const miniStream: Buffer[] = [];
  let miniCount = 0;
  const bigStreams: number[] = [];
  for (const [index, spec] of specs.entries()) {
    if (index === 0 || !isStream(spec)) {
      continue;
    }
    const data = spec.data as Buffer;
    if (data.length === 0) {
      continue;
    }
    if (data.length < MINI_CUTOFF) {
      const count = ceilDiv(data.length, MINI_SECTOR);
      const chain = Array.from({ length: count }, (_, i) => miniCount + i);
      miniChains.set(index, chain);
      const padded = Buffer.alloc(count * MINI_SECTOR);
      data.copy(padded);
      miniStream.push(padded);
      miniCount += count;
    } else {
      bigStreams.push(index);
    }
  }
  const miniStreamBytes = Buffer.concat(miniStream);
  const miniStreamSectorCount = ceilDiv(miniStreamBytes.length, sectorSize);
  const miniFatSectorCount = ceilDiv(miniCount, perSector);
  const directorySectorCount = ceilDiv(specs.length, entriesPerSector);
  const bigSectorCounts = bigStreams.map((index) =>
    ceilDiv((specs[index]?.data as Buffer).length, sectorSize),
  );
  const dataSectors =
    directorySectorCount +
    miniFatSectorCount +
    miniStreamSectorCount +
    bigSectorCounts.reduce((sum, n) => sum + n, 0);
  let fatSectorCount = 1;
  while (fatSectorCount * perSector < dataSectors + fatSectorCount) {
    fatSectorCount++;
  }
  if (fatSectorCount > 109) {
    throw new Error("buildCfb does not write a DIFAT: the file is too large");
  }

  // Sector numbers: FAT, directory, mini FAT, mini stream, big streams.
  let next = 0;
  const take = (count: number): number[] => Array.from({ length: count }, () => next++);
  const fatSectors = take(fatSectorCount);
  const directorySectors = take(directorySectorCount);
  const miniFatSectors = take(miniFatSectorCount);
  const miniStreamSectors = take(miniStreamSectorCount);
  const bigChains = new Map<number, number[]>();
  for (const [position, index] of bigStreams.entries()) {
    bigChains.set(index, take(bigSectorCounts[position] as number));
  }
  const sectorCount = next;

  const fat = new Array<number>(fatSectorCount * perSector).fill(FREESECT);
  for (const sector of fatSectors) {
    fat[sector] = FATSECT;
  }
  const link = (chain: readonly number[]): void => {
    for (const [i, sector] of chain.entries()) {
      fat[sector] = i + 1 < chain.length ? (chain[i + 1] as number) : ENDOFCHAIN;
    }
  };
  link(directorySectors);
  link(miniFatSectors);
  link(miniStreamSectors);
  for (const chain of bigChains.values()) {
    link(chain);
  }
  const miniFat = new Array<number>(miniFatSectorCount * perSector).fill(FREESECT);
  for (const chain of miniChains.values()) {
    for (const [i, sector] of chain.entries()) {
      miniFat[sector] = i + 1 < chain.length ? (chain[i + 1] as number) : ENDOFCHAIN;
    }
  }

  // Directory entries: siblings chained to the right, the first one is the parent's child.
  const firstChild = new Map<number, number>();
  const lastChild = new Map<number, number>();
  const right = new Array<number>(specs.length).fill(NOSTREAM);
  for (let index = 1; index < specs.length; index++) {
    const parent = specs[index]?.parent ?? 0;
    const previous = lastChild.get(parent);
    if (previous === undefined) {
      firstChild.set(parent, index);
    } else {
      right[previous] = index;
    }
    lastChild.set(parent, index);
  }

  const bytes = Buffer.alloc((sectorCount + 1) * sectorSize);
  SIGNATURE.copy(bytes, 0);
  bytes.writeUInt16LE(0x003e, 24);
  bytes.writeUInt16LE(sectorShift === 9 ? 3 : 4, 26);
  bytes.writeUInt16LE(0xfffe, 28);
  bytes.writeUInt16LE(sectorShift, HEADER.sectorShift);
  bytes.writeUInt16LE(6, HEADER.miniSectorShift);
  bytes.writeUInt32LE(sectorShift === 9 ? 0 : directorySectorCount, HEADER.directorySectors);
  bytes.writeUInt32LE(fatSectorCount, HEADER.fatSectors);
  bytes.writeUInt32LE(directorySectors[0] as number, HEADER.firstDirectory);
  bytes.writeUInt32LE(MINI_CUTOFF, HEADER.miniCutoff);
  bytes.writeUInt32LE(miniFatSectors[0] ?? ENDOFCHAIN, HEADER.firstMiniFat);
  bytes.writeUInt32LE(miniFatSectorCount, HEADER.miniFatSectors);
  bytes.writeUInt32LE(ENDOFCHAIN, HEADER.firstDifat);
  bytes.writeUInt32LE(0, HEADER.difatSectors);
  for (let i = 0; i < 109; i++) {
    bytes.writeUInt32LE(fatSectors[i] ?? FREESECT, HEADER.difat + 4 * i);
  }

  const sectorOffset = (sector: number): number => (sector + 1) * sectorSize;
  const writeInts = (sectors: readonly number[], values: readonly number[]): void => {
    for (const [i, sector] of sectors.entries()) {
      for (let j = 0; j < perSector; j++) {
        bytes.writeUInt32LE(values[i * perSector + j] ?? FREESECT, sectorOffset(sector) + 4 * j);
      }
    }
  };
  writeInts(fatSectors, fat);
  writeInts(miniFatSectors, miniFat);
  for (const [i, sector] of miniStreamSectors.entries()) {
    miniStreamBytes.copy(
      bytes,
      sectorOffset(sector),
      i * sectorSize,
      Math.min(miniStreamBytes.length, (i + 1) * sectorSize),
    );
  }
  for (const [index, chain] of bigChains) {
    const data = specs[index]?.data as Buffer;
    for (const [i, sector] of chain.entries()) {
      data.copy(
        bytes,
        sectorOffset(sector),
        i * sectorSize,
        Math.min(data.length, (i + 1) * sectorSize),
      );
    }
  }

  const entryOffset = (index: number): number =>
    sectorOffset(directorySectors[Math.floor(index / entriesPerSector)] as number) +
    (index % entriesPerSector) * ENTRY_SIZE;
  const layoutEntries: CfbEntryLayout[] = [];
  for (let index = 0; index < directorySectorCount * entriesPerSector; index++) {
    const offset = entryOffset(index);
    const spec = specs[index];
    if (!spec) {
      bytes.writeUInt32LE(NOSTREAM, offset + ENTRY.left);
      bytes.writeUInt32LE(NOSTREAM, offset + ENTRY.right);
      bytes.writeUInt32LE(NOSTREAM, offset + ENTRY.child);
      continue;
    }
    const type = index === 0 ? 5 : isStream(spec) ? 2 : 1;
    const name = spec.name.slice(0, 31);
    bytes.write(name, offset, "utf16le");
    bytes.writeUInt16LE((name.length + 1) * 2, offset + ENTRY.nameLength);
    bytes[offset + ENTRY.type] = type;
    bytes[offset + 67] = 1;
    bytes.writeUInt32LE(NOSTREAM, offset + ENTRY.left);
    bytes.writeUInt32LE(right[index] as number, offset + ENTRY.right);
    bytes.writeUInt32LE(firstChild.get(index) ?? NOSTREAM, offset + ENTRY.child);
    let start = ENDOFCHAIN;
    let size = 0;
    let chain: number[] = [];
    let mini = false;
    if (index === 0) {
      chain = miniStreamSectors;
      start = miniStreamSectors[0] ?? ENDOFCHAIN;
      size = miniStreamBytes.length;
    } else if (isStream(spec)) {
      size = (spec.data as Buffer).length;
      const miniChain = miniChains.get(index);
      chain = miniChain ?? bigChains.get(index) ?? [];
      mini = miniChain !== undefined;
      start = chain[0] ?? ENDOFCHAIN;
    }
    bytes.writeUInt32LE(start, offset + ENTRY.startSector);
    bytes.writeUInt32LE(size, offset + ENTRY.sizeLow);
    layoutEntries.push({
      name: spec.name,
      index,
      type: index === 0 ? "root" : isStream(spec) ? "stream" : "storage",
      size,
      startSector: start,
      mini,
      chain,
    });
  }

  const layout: CfbLayout = {
    sectorSize,
    sectorCount,
    fatSectors,
    directorySectors,
    miniFatSectors,
    miniStreamSectors,
    entries: layoutEntries,
    sectorOffset,
    fatEntryOffset: (sector) =>
      sectorOffset(fatSectors[Math.floor(sector / perSector)] as number) + 4 * (sector % perSector),
    miniFatEntryOffset: (miniSector) =>
      sectorOffset(miniFatSectors[Math.floor(miniSector / perSector)] as number) +
      4 * (miniSector % perSector),
    entryOffset,
  };
  return { bytes, layout };
}

/** The layout entry of a named stream or storage (throws when there is none). */
export function entryNamed(layout: CfbLayout, name: string): CfbEntryLayout {
  const found = layout.entries.find((entry) => entry.name === name);
  if (!found) {
    throw new Error(`no entry named ${name}`);
  }
  return found;
}
