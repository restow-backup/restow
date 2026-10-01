/**
 * Structural check of an OLE compound file (MS-CFB) before the MSG reader sees it.
 *
 * `@kenjiuno/msgreader` follows sector chains and directory links exactly as the
 * file says, without cycle detection and with sizes taken at face value: a FAT
 * chain that loops fills the heap, a directory sibling link that loops does the
 * same, a stream that claims 2 GiB allocates 2 GiB. This check walks the same
 * structures in bounded, linear time and refuses a file whose structure cannot
 * belong to an honest writer:
 *
 *   - every sector belongs to at most one owner (a FAT or DIFAT sector, the
 *     directory, the mini FAT, the mini stream or one stream), which rules out
 *     loops and cross-linked chains and bounds the bytes all streams can claim by
 *     the size of the file;
 *   - every sector number, directory link and size lies inside the file;
 *   - the directory is a tree (no entry is reached twice) of limited depth and
 *     limited size;
 *   - header fields msgreader assumes (byte order, sector sizes, the mini stream
 *     cutoff) have the values the specification fixes.
 *
 * A file that passes cannot make the reader loop or allocate more than the file
 * holds. The check is the first line of defence; the reader still runs in an
 * isolated child process with a time and memory limit (./isolate.ts), because a
 * guard written against one library's behaviour is not a proof about it.
 */

const HEADER_SIZE = 512;
const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const MAXREGSECT = 0xfffffffa;
const NOSTREAM = 0xffffffff;
const DIFAT_IN_HEADER = 109;
const MINI_SECTOR_SIZE = 64;
const MINI_CUTOFF = 4096;
const ENTRY_SIZE = 128;

/** Most directory entries a mail message can plausibly have (a message with thousands of attachments has tens of thousands). */
export const MAX_DIRECTORY_ENTRIES = 250_000;
/** Deepest storage nesting: a message in a message in a message, two levels each, with room to spare. */
export const MAX_STORAGE_DEPTH = 64;

export type CfbCheck =
  | { readonly ok: true; readonly sectorSize: number; readonly streams: number }
  | { readonly ok: false; readonly detail: string };

class Damaged extends Error {}

function fail(detail: string): never {
  throw new Damaged(detail);
}

/**
 * Check the structure of a compound file. Never throws; `detail` of a failure is
 * a short English phrase that completes "the file is damaged (...)".
 */
export function checkCompoundFile(bytes: Uint8Array): CfbCheck {
  try {
    return check(bytes);
  } catch (error) {
    if (error instanceof Damaged) {
      return { ok: false, detail: error.message };
    }
    return { ok: false, detail: "the structure could not be checked" };
  }
}

function check(bytes: Uint8Array): CfbCheck {
  if (bytes.length < HEADER_SIZE) {
    fail("it is shorter than a compound file header");
  }
  for (const [i, byte] of SIGNATURE.entries()) {
    if (bytes[i] !== byte) {
      fail("it does not start with the compound file signature");
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (offset: number): number => view.getUint32(offset, true);

  if (view.getUint16(28, true) !== 0xfffe) {
    fail("the byte order mark is not little endian");
  }
  const sectorShift = view.getUint16(30, true);
  if (sectorShift !== 9 && sectorShift !== 12) {
    fail(`the sector size 2^${sectorShift} is not supported`);
  }
  if (view.getUint16(32, true) !== 6) {
    fail("the mini sector size is not 64 bytes");
  }
  if (u32(56) !== MINI_CUTOFF) {
    fail("the mini stream cutoff is not 4096 bytes");
  }
  const sectorSize = 1 << sectorShift;
  const perSector = sectorSize / 4;
  if (bytes.length < sectorSize) {
    fail("it is shorter than its header sector");
  }
  // A partial last sector counts: reads beyond the end of the file fail on their own.
  const totalSectors = Math.ceil((bytes.length - sectorSize) / sectorSize);
  if (totalSectors < 2) {
    fail("it holds no sectors besides the header");
  }
  const fatCount = u32(44);
  const firstDirectory = u32(48);
  const firstMiniFat = u32(60);
  const miniFatCount = u32(64);
  const firstDifat = u32(68);
  const difatCount = u32(72);
  if (fatCount === 0 || fatCount > totalSectors) {
    fail("the number of FAT sectors does not fit the file");
  }

  const OWNER_FAT = 1;
  const OWNER_DIFAT = 2;
  const OWNER_DIRECTORY = 3;
  const OWNER_MINIFAT = 4;
  const OWNER_MINISTREAM = 5;
  const OWNER_STREAM = 6;
  const owner = new Uint8Array(totalSectors);
  const claim = (sector: number, tag: number, what: string): void => {
    if (sector >= totalSectors) {
      fail(`${what} points to sector ${sector}, which is outside the file`);
    }
    if (owner[sector] !== 0) {
      fail(`${what} runs into a sector that is used twice (a loop or cross-linked chain)`);
    }
    owner[sector] = tag;
  };
  const sectorOffset = (sector: number): number => (sector + 1) * sectorSize;
  const readInt = (offset: number): number => {
    if (offset + 4 > bytes.length) {
      fail("a structure reaches past the end of the file");
    }
    return u32(offset);
  };

  // FAT sector list: the header holds 109, the DIFAT chain the rest.
  const fatSectors = new Uint32Array(fatCount);
  let have = 0;
  for (let i = 0; i < Math.min(fatCount, DIFAT_IN_HEADER); i++) {
    const sector = u32(76 + 4 * i);
    claim(sector, OWNER_FAT, "the FAT sector list");
    fatSectors[have++] = sector;
  }
  let difat = firstDifat;
  for (let i = 0; i < difatCount && have < fatCount; i++) {
    if (difat === ENDOFCHAIN) {
      break;
    }
    claim(difat, OWNER_DIFAT, "the DIFAT chain");
    const base = sectorOffset(difat);
    for (let j = 0; j < perSector - 1 && have < fatCount; j++) {
      const sector = readInt(base + 4 * j);
      claim(sector, OWNER_FAT, "the FAT sector list");
      fatSectors[have++] = sector;
    }
    difat = readInt(base + 4 * (perSector - 1));
  }
  if (have < fatCount) {
    fail("the FAT sector list is shorter than the header says");
  }

  const fatEntries = fatCount * perSector;
  const nextSector = (sector: number): number => {
    if (sector >= fatEntries) {
      fail(`sector ${sector} has no FAT entry`);
    }
    const fatSector = fatSectors[Math.floor(sector / perSector)] as number;
    return readInt(sectorOffset(fatSector) + 4 * (sector % perSector));
  };
  /** Claim the chain that starts at `start`: to its end, or for `limit` sectors when given. */
  const walkChain = (
    start: number,
    tag: number,
    what: string,
    limit = Number.POSITIVE_INFINITY,
  ): number => {
    let length = 0;
    let sector = start;
    while (sector !== ENDOFCHAIN && length < limit) {
      if (sector > MAXREGSECT) {
        fail(`${what} contains a special sector number`);
      }
      claim(sector, tag, what);
      length++;
      sector = nextSector(sector);
    }
    return length;
  };

  // Directory.
  const directorySectors = walkChain(firstDirectory, OWNER_DIRECTORY, "the directory");
  if (directorySectors === 0) {
    fail("the directory is empty");
  }
  const perDirectorySector = sectorSize / ENTRY_SIZE;
  const entryCount = directorySectors * perDirectorySector;
  if (entryCount > MAX_DIRECTORY_ENTRIES) {
    fail(`the directory has more than ${MAX_DIRECTORY_ENTRIES} entries`);
  }
  const directoryOffsets: number[] = [];
  {
    let sector = firstDirectory;
    for (let i = 0; i < directorySectors; i++) {
      directoryOffsets.push(sectorOffset(sector));
      sector = nextSector(sector);
    }
  }
  const entryOffsetOf = (index: number): number =>
    (directoryOffsets[Math.floor(index / perDirectorySector)] as number) +
    (index % perDirectorySector) * ENTRY_SIZE;
  const present = (index: number): boolean => entryOffsetOf(index) + ENTRY_SIZE <= bytes.length;

  const types = new Uint8Array(entryCount);
  for (let i = 0; i < entryCount; i++) {
    if (present(i)) {
      const type = bytes[entryOffsetOf(i) + 66] as number;
      types[i] = type === 1 || type === 2 || type === 5 ? type : 0;
      if (types[i] !== 0 && view.getUint16(entryOffsetOf(i) + 64, true) > 64) {
        fail("a directory entry has a name longer than 64 bytes");
      }
    }
  }
  if (types[0] !== 5) {
    fail("the directory has no root entry");
  }

  // Root entry: its chain is the mini stream container.
  const rootOffset = entryOffsetOf(0);
  const rootStart = u32(rootOffset + 116);
  const rootSize = u32(rootOffset + 120);
  let miniSectorCount = 0;
  if (rootStart !== ENDOFCHAIN && rootStart !== FREESECT) {
    const length = walkChain(rootStart, OWNER_MINISTREAM, "the mini stream");
    if (rootSize > length * sectorSize) {
      fail("the mini stream is larger than the sectors it is stored in");
    }
    miniSectorCount = Math.floor(rootSize / MINI_SECTOR_SIZE);
  }

  // Mini FAT: msgreader reads up to `miniFatCount` of its sectors.
  const miniFatSectors: number[] = [];
  if (miniFatCount > 0 && firstMiniFat !== ENDOFCHAIN && firstMiniFat !== FREESECT) {
    let sector = firstMiniFat;
    while (sector !== ENDOFCHAIN && miniFatSectors.length < miniFatCount) {
      if (sector > MAXREGSECT) {
        fail("the mini FAT contains a special sector number");
      }
      claim(sector, OWNER_MINIFAT, "the mini FAT");
      miniFatSectors.push(sector);
      sector = nextSector(sector);
    }
  }
  const miniFatEntries = miniFatSectors.length * perSector;
  const nextMini = (mini: number): number => {
    if (mini >= miniFatEntries) {
      fail(`mini sector ${mini} has no mini FAT entry`);
    }
    const sector = miniFatSectors[Math.floor(mini / perSector)] as number;
    return readInt(sectorOffset(sector) + 4 * (mini % perSector));
  };
  const miniOwner = new Uint8Array(miniSectorCount);

  // Directory tree: every entry is reached at most once, nesting is limited.
  const seen = new Uint8Array(entryCount);
  seen[0] = 1;
  const link = (offset: number): number => {
    const value = u32(offset);
    if (value === NOSTREAM) {
      return -1;
    }
    if (value >= entryCount) {
      fail("a directory link points outside the directory");
    }
    return value;
  };
  const stack: { id: number; depth: number }[] = [];
  const rootChild = link(rootOffset + 76);
  if (rootChild >= 0) {
    stack.push({ id: rootChild, depth: 1 });
  }
  let streams = 0;
  while (stack.length > 0) {
    const { id, depth } = stack.pop() as { id: number; depth: number };
    if (seen[id] === 1) {
      fail("the directory loops back on itself");
    }
    seen[id] = 1;
    if (types[id] === 0) {
      fail("the directory refers to an entry that is not in use");
    }
    if (types[id] === 5) {
      fail("the directory has a second root entry");
    }
    const offset = entryOffsetOf(id);
    for (const sibling of [link(offset + 68), link(offset + 72)]) {
      if (sibling >= 0) {
        stack.push({ id: sibling, depth });
      }
    }
    if (types[id] === 1) {
      const child = link(offset + 76);
      if (child >= 0) {
        if (depth + 1 > MAX_STORAGE_DEPTH) {
          fail(`storages are nested more than ${MAX_STORAGE_DEPTH} levels deep`);
        }
        stack.push({ id: child, depth: depth + 1 });
      }
      continue;
    }
    // A stream: its size must fit the sectors it names, and those sectors must be its own.
    streams++;
    if (u32(offset + 124) !== 0 || u32(offset + 120) > 0x7fffffff) {
      fail("a stream is larger than 2 GiB");
    }
    const size = u32(offset + 120);
    if (size === 0) {
      continue;
    }
    const start = u32(offset + 116);
    if (size < MINI_CUTOFF) {
      if (miniSectorCount === 0) {
        fail("a small stream has no mini stream to live in");
      }
      let mini = start;
      let length = 0;
      while (mini !== ENDOFCHAIN) {
        if (mini >= miniSectorCount) {
          fail("a small stream points outside the mini stream");
        }
        if (miniOwner[mini] !== 0) {
          fail("a small stream runs into a mini sector that is used twice");
        }
        miniOwner[mini] = 1;
        length++;
        mini = nextMini(mini);
      }
      if (length * MINI_SECTOR_SIZE < size) {
        fail("a small stream is longer than the mini sectors it names");
      }
    } else {
      const needed = Math.ceil(size / sectorSize);
      if (needed > totalSectors) {
        fail("a stream is larger than the file");
      }
      const length = walkChain(start, OWNER_STREAM, "a stream", needed);
      if (length < needed) {
        fail("a stream is longer than the sectors it names");
      }
    }
  }
  return { ok: true, sectorSize, streams };
}
