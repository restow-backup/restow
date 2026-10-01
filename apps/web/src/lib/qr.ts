/**
 * QR code encoder (ISO/IEC 18004, model 2): byte mode, error correction
 * level M, versions 1 to 40, automatic mask selection.
 *
 * Restow needs a QR code in exactly one place: the authenticator enrolment,
 * whose `otpauth://` URI carries the TOTP secret. Encoding it in the browser
 * keeps that secret away from any third party, and a small encoder is easier
 * to review than a dependency for one screen.
 */

/** A finished symbol. `modules[y][x]` is true for a dark module. */
export interface QrCode {
  version: number;
  size: number;
  mask: number;
  modules: boolean[][];
}

// Error correction level M, indexed by version (index 0 unused).
const ECC_CODEWORDS_PER_BLOCK = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
const ERROR_CORRECTION_BLOCKS = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
  26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];

/** The two format bits that stand for level M. */
const LEVEL_M_FORMAT_BITS = 0b00;
const BYTE_MODE = 0b0100;
const MIN_VERSION = 1;
const MAX_VERSION = 40;

const PENALTY_RUN = 3;
const PENALTY_BLOCK = 3;
const PENALTY_FINDER_LIKE = 40;
const PENALTY_BALANCE = 10;

// --- Galois field and Reed-Solomon -------------------------------------------------

/** Product of two elements of GF(2^8) modulo the QR polynomial x^8 + x^4 + x^3 + x^2 + 1. */
function gfMultiply(x: number, y: number): number {
  let product = 0;
  for (let bit = 7; bit >= 0; bit--) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d);
    product ^= ((y >>> bit) & 1) * x;
  }
  return product;
}

/** Coefficients (highest degree first, leading 1 omitted) of the generator polynomial. */
export function reedSolomonGenerator(degree: number): number[] {
  const coefficients = new Array<number>(degree).fill(0);
  coefficients[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      coefficients[j] = gfMultiply(coefficients[j] ?? 0, root);
      if (j + 1 < degree) {
        coefficients[j] = (coefficients[j] ?? 0) ^ (coefficients[j + 1] ?? 0);
      }
    }
    root = gfMultiply(root, 0x02);
  }
  return coefficients;
}

/** The error correction codewords for `data` under `generator`. */
export function reedSolomonRemainder(
  data: readonly number[],
  generator: readonly number[],
): number[] {
  const remainder = new Array<number>(generator.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder.shift() ?? 0);
    remainder.push(0);
    for (let i = 0; i < generator.length; i++) {
      remainder[i] = (remainder[i] ?? 0) ^ gfMultiply(generator[i] ?? 0, factor);
    }
  }
  return remainder;
}

// --- Capacity -----------------------------------------------------------------------

/** Modules left for data and error correction once function patterns are placed. */
function rawDataModules(version: number): number {
  let modules = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignmentCount = Math.floor(version / 7) + 2;
    modules -= (25 * alignmentCount - 10) * alignmentCount - 55;
    if (version >= 7) {
      modules -= 36;
    }
  }
  return modules;
}

function eccPerBlock(version: number): number {
  return ECC_CODEWORDS_PER_BLOCK[version] ?? 0;
}

function blockCount(version: number): number {
  return ERROR_CORRECTION_BLOCKS[version] ?? 0;
}

/** Data codewords a version holds at level M. */
export function dataCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8) - eccPerBlock(version) * blockCount(version);
}

function characterCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** The smallest version that holds `byteLength` bytes in byte mode; throws when none does. */
export function versionFor(byteLength: number): number {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
    const needed = 4 + characterCountBits(version) + 8 * byteLength;
    if (needed <= dataCodewords(version) * 8) {
      return version;
    }
  }
  throw new RangeError(`${byteLength} bytes do not fit into a QR code`);
}

// --- Codewords ----------------------------------------------------------------------

function appendBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) {
    bits.push((value >>> i) & 1);
  }
}

/** Mode, length, payload, terminator and pad bytes, as data codewords. */
export function dataCodewordsFor(data: Uint8Array, version: number): number[] {
  const capacity = dataCodewords(version) * 8;
  const bits: number[] = [];
  appendBits(bits, BYTE_MODE, 4);
  appendBits(bits, data.length, characterCountBits(version));
  for (const byte of data) {
    appendBits(bits, byte, 8);
  }
  appendBits(bits, 0, Math.min(4, capacity - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) {
    appendBits(bits, pad, 8);
  }
  const codewords = new Array<number>(bits.length / 8).fill(0);
  bits.forEach((bit, index) => {
    codewords[index >>> 3] = (codewords[index >>> 3] ?? 0) | (bit << (7 - (index & 7)));
  });
  return codewords;
}

/** Split into blocks, append each block's error correction, and interleave. */
export function interleavedCodewords(data: readonly number[], version: number): number[] {
  const blocks = blockCount(version);
  const eccLength = eccPerBlock(version);
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blocks - (rawCodewords % blocks);
  const shortBlockLength = Math.floor(rawCodewords / blocks);
  const generator = reedSolomonGenerator(eccLength);

  const assembled: number[][] = [];
  let offset = 0;
  for (let index = 0; index < blocks; index++) {
    const dataLength = shortBlockLength - eccLength + (index < shortBlocks ? 0 : 1);
    const blockData = data.slice(offset, offset + dataLength);
    offset += dataLength;
    const ecc = reedSolomonRemainder(blockData, generator);
    // Short blocks get a placeholder so every block has the same length.
    assembled.push([...blockData, ...(index < shortBlocks ? [0] : []), ...ecc]);
  }

  const result: number[] = [];
  for (let position = 0; position <= shortBlockLength; position++) {
    assembled.forEach((block, index) => {
      const placeholder = position === shortBlockLength - eccLength && index < shortBlocks;
      if (!placeholder) {
        result.push(block[position] ?? 0);
      }
    });
  }
  return result;
}

// --- Format and version information -------------------------------------------------

/** The 15 format bits (level M plus mask) with their BCH code, already masked. */
export function formatBits(mask: number): number {
  const data = (LEVEL_M_FORMAT_BITS << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i++) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

/** The 18 version bits (version 7 and up) with their BCH code. */
export function versionBits(version: number): number {
  let remainder = version;
  for (let i = 0; i < 12; i++) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  }
  return (version << 12) | remainder;
}

/** Row and column centres of the alignment patterns. */
export function alignmentPositions(version: number): number[] {
  if (version === 1) {
    return [];
  }
  const count = Math.floor(version / 7) + 2;
  const step =
    version === 32 ? 26 : Math.floor((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;
  const positions = new Array<number>(count).fill(6);
  // The last centre sits 7 modules in from the far edge; the others follow at `step`.
  for (let i = count - 1, position = version * 4 + 10; i >= 1; i--, position -= step) {
    positions[i] = position;
  }
  return positions;
}

// --- Symbol ---------------------------------------------------------------------------

function isMasked(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

class SymbolBuilder {
  readonly size: number;
  readonly modules: boolean[][];
  private readonly reserved: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
    this.reserved = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
  }

  private setFunction(x: number, y: number, dark: boolean): void {
    const row = this.modules[y];
    const reservedRow = this.reserved[y];
    if (row && reservedRow) {
      row[x] = dark;
      reservedRow[x] = true;
    }
  }

  private isReserved(x: number, y: number): boolean {
    return this.reserved[y]?.[x] === true;
  }

  drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);

    const positions = alignmentPositions(this.version);
    const last = positions.length - 1;
    positions.forEach((column, i) => {
      positions.forEach((row, j) => {
        const overlapsFinder =
          (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
        if (!overlapsFinder) {
          this.drawAlignment(column, row);
        }
      });
    });

    // Reserve the format areas now; the real bits follow once the mask is known.
    this.drawFormat(0);
    this.drawVersion();
  }

  private drawFinder(centerX: number, centerY: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = centerX + dx;
        const y = centerY + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          this.setFunction(x, y, distance !== 2 && distance !== 4);
        }
      }
    }
  }

  private drawAlignment(centerX: number, centerY: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunction(centerX + dx, centerY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  drawFormat(mask: number): void {
    const bits = formatBits(mask);
    const bit = (index: number) => ((bits >>> index) & 1) === 1;
    // Around the top-left finder.
    for (let i = 0; i <= 5; i++) {
      this.setFunction(8, i, bit(i));
    }
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) {
      this.setFunction(14 - i, 8, bit(i));
    }
    // Split between the top-right and bottom-left finders.
    for (let i = 0; i < 8; i++) {
      this.setFunction(this.size - 1 - i, 8, bit(i));
    }
    for (let i = 8; i < 15; i++) {
      this.setFunction(8, this.size - 15 + i, bit(i));
    }
    // The dark module.
    this.setFunction(8, this.size - 8, true);
  }

  private drawVersion(): void {
    if (this.version < 7) {
      return;
    }
    const bits = versionBits(this.version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  }

  /** Place the codewords in the two-column zigzag, skipping function modules. */
  drawCodewords(codewords: readonly number[]): void {
    let index = 0;
    const totalBits = codewords.length * 8;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) {
        right = 5;
      }
      const upward = ((right + 1) & 2) === 0;
      for (let step = 0; step < this.size; step++) {
        const y = upward ? this.size - 1 - step : step;
        for (let offset = 0; offset < 2; offset++) {
          const x = right - offset;
          const row = this.modules[y];
          if (row && !this.isReserved(x, y) && index < totalBits) {
            row[x] = (((codewords[index >>> 3] ?? 0) >>> (7 - (index & 7))) & 1) === 1;
            index++;
          }
        }
      }
    }
  }

  /** XOR the data area with a mask pattern; applying it twice undoes it. */
  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      const row = this.modules[y];
      for (let x = 0; x < this.size; x++) {
        if (row && !this.isReserved(x, y) && isMasked(mask, x, y)) {
          row[x] = !row[x];
        }
      }
    }
  }
}

// --- Mask selection -----------------------------------------------------------------

function lightBetween(line: readonly boolean[], from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    if (line[i] === true) {
      return false;
    }
  }
  return true;
}

const FINDER_LIKE = [true, false, true, true, true, false, true];

function linePenalty(line: readonly boolean[]): number {
  let penalty = 0;
  let run = 1;
  for (let i = 1; i <= line.length; i++) {
    if (i < line.length && line[i] === line[i - 1]) {
      run++;
      continue;
    }
    if (run >= 5) {
      penalty += PENALTY_RUN + (run - 5);
    }
    run = 1;
  }
  for (let start = 0; start + FINDER_LIKE.length <= line.length; start++) {
    if (FINDER_LIKE.every((dark, i) => line[start + i] === dark)) {
      // Outside the symbol counts as light: the quiet zone.
      if (lightBetween(line, start - 4, start)) {
        penalty += PENALTY_FINDER_LIKE;
      }
      if (lightBetween(line, start + 7, start + 11)) {
        penalty += PENALTY_FINDER_LIKE;
      }
    }
  }
  return penalty;
}

/** The standard penalty score; the mask with the lowest score reads most reliably. */
export function penaltyScore(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  let penalty = 0;
  let dark = 0;
  for (let y = 0; y < size; y++) {
    const row = modules[y] ?? [];
    penalty += linePenalty(row);
    penalty += linePenalty(modules.map((line) => line[y] === true));
    for (let x = 0; x < size; x++) {
      if (row[x]) {
        dark++;
      }
      const next = modules[y + 1];
      if (x + 1 < size && next) {
        const color = row[x];
        if (row[x + 1] === color && next[x] === color && next[x + 1] === color) {
          penalty += PENALTY_BLOCK;
        }
      }
    }
  }
  const total = size * size;
  const deviation = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return penalty + Math.max(0, deviation) * PENALTY_BALANCE;
}

// --- Entry point ----------------------------------------------------------------------

/** Encode bytes as the smallest level-M QR code that holds them. */
export function encodeQrBytes(data: Uint8Array): QrCode {
  const version = versionFor(data.length);
  const symbol = new SymbolBuilder(version);
  symbol.drawFunctionPatterns();
  symbol.drawCodewords(interleavedCodewords(dataCodewordsFor(data, version), version));

  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    symbol.applyMask(mask);
    symbol.drawFormat(mask);
    const score = penaltyScore(symbol.modules);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
    symbol.applyMask(mask);
  }
  symbol.applyMask(bestMask);
  symbol.drawFormat(bestMask);

  return { version, size: symbol.size, mask: bestMask, modules: symbol.modules };
}

/** Encode text (UTF-8) as a QR code. */
export function encodeQr(text: string): QrCode {
  return encodeQrBytes(new TextEncoder().encode(text));
}

/** Quiet zone scanners need around the symbol, in modules. */
export const QUIET_ZONE = 4;

/**
 * An SVG path of the dark modules, one rectangle per horizontal run, shifted
 * by the quiet zone so the path fits a `(size + 2 * QUIET_ZONE)` square.
 */
export function qrSvgPath(code: QrCode): string {
  const parts: string[] = [];
  code.modules.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) {
        x++;
      }
      const run = x - start;
      parts.push(`M${start + QUIET_ZONE} ${y + QUIET_ZONE}h${run}v1h-${run}z`);
    }
  });
  return parts.join("");
}
