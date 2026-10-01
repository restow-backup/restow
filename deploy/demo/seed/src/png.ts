import { deflateSync } from "node:zlib";
import type { Rng } from "./prng.js";
import { pick, randomInt } from "./prng.js";

/**
 * Tiny PNG images, generated, for the demo's simulated machines: a minimal
 * encoder (8-bit RGB, no interlacing, one IDAT) and a generator that draws a
 * plausible little "chart" — a header bar and a few coloured bars on a light
 * background — so a picture folder has variety without shipping binaries. A
 * generated image is a few kilobytes.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encode `rgb` (width * height * 3 bytes, row by row) as a PNG. */
export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  if (rgb.length !== width * height * 3) {
    throw new Error("pixel data does not match the image size");
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

type Colour = readonly [number, number, number];

const PALETTES: readonly (readonly Colour[])[] = [
  [
    [37, 99, 235],
    [16, 185, 129],
    [245, 158, 11],
  ],
  [
    [99, 102, 241],
    [236, 72, 153],
    [14, 165, 233],
  ],
  [
    [34, 197, 94],
    [234, 179, 8],
    [239, 68, 68],
  ],
];

/** A small deterministic chart-like picture (default 320 x 200). */
export function generatedPng(rng: Rng, width = 320, height = 200): Buffer {
  const rgb = Buffer.alloc(width * height * 3);
  const fill = (x0: number, y0: number, w: number, h: number, [r, g, b]: Colour) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) {
        const at = (y * width + x) * 3;
        rgb[at] = r;
        rgb[at + 1] = g;
        rgb[at + 2] = b;
      }
    }
  };
  fill(0, 0, width, height, [245, 247, 250]);
  const palette = pick(rng, PALETTES);
  fill(0, 0, width, 24, [30, 41, 59]);
  fill(10, 8, 60, 8, [226, 232, 240]);
  // Gridlines, then the bars.
  for (let line = 1; line <= 4; line++) {
    fill(16, 30 + line * 30, width - 32, 1, [203, 213, 225]);
  }
  const bars = randomInt(rng, 5, 9);
  const slot = Math.floor((width - 40) / bars);
  for (let index = 0; index < bars; index++) {
    const barHeight = randomInt(rng, 20, 120);
    fill(
      20 + index * slot,
      height - 16 - barHeight,
      slot - 8,
      barHeight,
      palette[index % palette.length] as Colour,
    );
  }
  return encodePng(width, height, rgb);
}
