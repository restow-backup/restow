/**
 * Content-defined chunking (FastCDC, normalized-chunking variant).
 *
 * The gear table below is a fixed, versioned constant. It is generated
 * deterministically at module load (splitmix32 over a fixed seed) so the table
 * is identical on every machine and every run. DO NOT CHANGE the generator, the
 * seed or {@link GEAR_TABLE_VERSION}: any change moves every chunk boundary and
 * breaks deduplication against all existing backups.
 *
 * Boundaries are deterministic and depend only on content. An object smaller than
 * {@link MIN_CHUNK_SIZE} becomes a single chunk. Non-final chunks are always in
 * [MIN_CHUNK_SIZE, MAX_CHUNK_SIZE]; the final chunk may be smaller than the
 * minimum. See docs/ARCHITECTURE.md (Chunk-Store).
 */

/** Minimum chunk size: 256 KiB. */
export const MIN_CHUNK_SIZE = 256 * 1024;
/** Target (average) chunk size: 1 MiB. */
export const AVG_CHUNK_SIZE = 1024 * 1024;
/** Maximum chunk size: 4 MiB. */
export const MAX_CHUNK_SIZE = 4 * 1024 * 1024;

/** Version tag for the gear table; bump only with a deliberate format change. */
export const GEAR_TABLE_VERSION = 1;

// Normalized chunking (level 2): a stricter mask before the average point makes
// early cuts unlikely, a looser mask after it makes late cuts likely, tightening
// the size distribution around the average. log2(AVG) = 20, so 22 and 18 bits.
const MASK_STRONG = (1 << 22) - 1; // 0x003fffff, ~1/2^22 cut probability
const MASK_WEAK = (1 << 18) - 1; //  0x0003ffff, ~1/2^18 cut probability

const GEAR = buildGearTable();

function buildGearTable(): Uint32Array {
  const table = new Uint32Array(256);
  // splitmix32 with a fixed seed; each output is a well-distributed 32-bit word.
  let state = 0x9e37_79b9 >>> 0;
  for (let i = 0; i < table.length; i++) {
    state = (state + 0x9e37_79b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0_aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a_2d97) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0;
    table[i] = z >>> 0;
  }
  return table;
}

/** A chunk boundary: byte offset into the source and the chunk's byte length. */
export interface ChunkBoundary {
  readonly offset: number;
  readonly length: number;
}

/**
 * Find the end offset (exclusive) of the chunk that starts at `start`.
 * Returns a value strictly greater than `start`, at most `start + MAX_CHUNK_SIZE`.
 */
function nextBoundary(buf: Buffer, start: number): number {
  const remaining = buf.length - start;
  if (remaining <= MIN_CHUNK_SIZE) {
    // Whatever is left is a single (final) chunk, even if below the minimum.
    return buf.length;
  }

  const max = Math.min(MAX_CHUNK_SIZE, remaining);
  const centre = Math.min(AVG_CHUNK_SIZE, max);
  let hash = 0;
  let offset = MIN_CHUNK_SIZE; // no cut is allowed before the minimum

  // Phase 1: strong mask, [MIN_CHUNK_SIZE, centre).
  while (offset < centre) {
    hash = ((hash << 1) + GEAR[buf[start + offset]]) >>> 0;
    if ((hash & MASK_STRONG) === 0) {
      return start + offset + 1;
    }
    offset++;
  }
  // Phase 2: weak mask, [centre, max).
  while (offset < max) {
    hash = ((hash << 1) + GEAR[buf[start + offset]]) >>> 0;
    if ((hash & MASK_WEAK) === 0) {
      return start + offset + 1;
    }
    offset++;
  }
  // No content-defined cut: fall back to the maximum boundary.
  return start + max;
}

/**
 * Iterate the content-defined chunk boundaries of a buffer. Deterministic: the
 * same bytes always yield the same boundaries. An empty buffer yields nothing.
 */
export function* chunk(buf: Buffer): Generator<ChunkBoundary, void, unknown> {
  const size = buf.length;
  let start = 0;
  while (start < size) {
    const end = nextBoundary(buf, start);
    yield { offset: start, length: end - start };
    start = end;
  }
}

/** Collect all chunk boundaries of a buffer into an array. */
export function chunkAll(buf: Buffer): ChunkBoundary[] {
  return Array.from(chunk(buf));
}
