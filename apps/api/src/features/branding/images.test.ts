import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ProblemError } from "../../problem.js";
import { renderCustomerReport } from "../../reports/customer-report.js";
import { MAX_LOGO_BYTES, pngFiltersValid, pngRawSize, validateLogo } from "./images.js";
import { pngChunk, testJpeg, testPng } from "./testing/images.js";

/** A PNG with the given header fields and the given (uncompressed) image data. */
function rawPng(
  header: {
    width: number;
    height: number;
    bitDepth: number;
    colourType: number;
    interlace?: number;
  },
  raw: Buffer,
  extra: Buffer[] = [],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(header.width, 0);
  ihdr.writeUInt32BE(header.height, 4);
  ihdr[8] = header.bitDepth;
  ihdr[9] = header.colourType;
  ihdr[12] = header.interlace ?? 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    ...extra,
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND"),
  ]);
}

async function problemOf(promise: Promise<unknown>): Promise<{ status: number; code: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProblemError) {
      return { status: error.status, code: error.extensions?.code };
    }
    throw error;
  }
  throw new Error("expected a problem");
}

describe("validateLogo", () => {
  it("accepts a PNG and strips its metadata chunks", async () => {
    const png = testPng(200, 60, {
      before: [
        pngChunk("tEXt", Buffer.from("Author\0Someone", "latin1")),
        pngChunk("tIME", Buffer.alloc(7)),
      ],
      after: [pngChunk("eXIf", Buffer.from("MM\0*GPS", "latin1"))],
    });
    const logo = await validateLogo(png, "image/png");
    expect(logo).toMatchObject({ contentType: "image/png", width: 200, height: 60 });
    expect(logo.bytes.length).toBeLessThan(png.length);
    expect(logo.bytes.includes(Buffer.from("Someone"))).toBe(false);
    expect(logo.bytes.includes(Buffer.from("tIME"))).toBe(false);
    expect(logo.bytes.includes(Buffer.from("eXIf"))).toBe(false);
    expect(logo.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts a JPEG and strips EXIF and comments", async () => {
    const jpeg = testJpeg(320, 100);
    const logo = await validateLogo(jpeg, "image/jpeg");
    expect(logo).toMatchObject({ contentType: "image/jpeg", width: 320, height: 100 });
    expect(logo.bytes.includes(Buffer.from("secret-camera"))).toBe(false);
    expect(logo.bytes.includes(Buffer.from("someone@example.com"))).toBe(false);
    expect(logo.bytes.includes(Buffer.from("JFIF"))).toBe(true);
  });

  it("refuses every SVG, also one with a script and one sent as PNG", async () => {
    const svg = Buffer.from(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect(await problemOf(validateLogo(svg, "image/svg+xml"))).toEqual({
      status: 415,
      code: "svg-not-supported",
    });
    expect(await problemOf(validateLogo(svg, "image/png"))).toEqual({
      status: 415,
      code: "svg-not-supported",
    });
    expect(await problemOf(validateLogo(Buffer.from("﻿  <svg onload=x>"), "image/png"))).toEqual({
      status: 415,
      code: "svg-not-supported",
    });
  });

  it("refuses GIF, WebP and other types", async () => {
    expect(await problemOf(validateLogo(Buffer.from("GIF89a....."), "image/gif"))).toEqual({
      status: 415,
      code: "unsupported-type",
    });
    expect(await problemOf(validateLogo(Buffer.from("RIFF\0\0\0\0WEBPVP8 "), "image/png"))).toEqual(
      { status: 415, code: "unsupported-type" },
    );
  });

  it("refuses an animated PNG", async () => {
    const apng = testPng(64, 64, { before: [pngChunk("acTL", Buffer.alloc(8))] });
    expect(await problemOf(validateLogo(apng, "image/png"))).toEqual({
      status: 422,
      code: "animated",
    });
  });

  it("refuses files that are too large or too small, or too wide", async () => {
    const big = Buffer.concat([testPng(16, 16), Buffer.alloc(MAX_LOGO_BYTES)]);
    expect(await problemOf(validateLogo(big, "image/png"))).toEqual({
      status: 422,
      code: "too-large",
    });
    expect(await problemOf(validateLogo(testPng(15, 40), "image/png"))).toEqual({
      status: 422,
      code: "dimensions",
    });
    expect(await problemOf(validateLogo(testJpeg(2001, 20), "image/jpeg"))).toEqual({
      status: 422,
      code: "dimensions",
    });
    expect(await problemOf(validateLogo(testJpeg(2000, 2001), "image/jpeg"))).toEqual({
      status: 422,
      code: "dimensions",
    });
    // 2000 × 2000 is exactly 4 megapixels: still accepted.
    expect((await validateLogo(testJpeg(2000, 2000), "image/jpeg")).width).toBe(2000);
  });

  it("refuses truncated and damaged files", async () => {
    const png = testPng(32, 32);
    expect(await problemOf(validateLogo(png.subarray(0, png.length - 20), "image/png"))).toEqual({
      status: 422,
      code: "corrupt",
    });
    const damaged = Buffer.from(png);
    damaged[40] = (damaged[40] ?? 0) ^ 0xff;
    expect(await problemOf(validateLogo(damaged, "image/png"))).toEqual({
      status: 422,
      code: "corrupt",
    });
    const jpeg = testJpeg(64, 64);
    expect(await problemOf(validateLogo(jpeg.subarray(0, jpeg.length - 4), "image/jpeg"))).toEqual({
      status: 422,
      code: "corrupt",
    });
  });

  it("refuses a decompression bomb before it inflates", async () => {
    // 16 × 16 RGB announces 16 × (1 + 48) bytes; the data inflates to 32 MiB of zeros.
    const bomb = rawPng(
      { width: 16, height: 16, bitDepth: 8, colourType: 2 },
      Buffer.alloc(32 * 1024 * 1024),
    );
    expect(bomb.length).toBeLessThan(MAX_LOGO_BYTES);
    const before = process.memoryUsage().arrayBuffers;
    expect(await problemOf(validateLogo(bomb, "image/png"))).toEqual({
      status: 422,
      code: "corrupt",
    });
    // Inflating stopped at the announced size, far below the 32 MiB.
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * 1024 * 1024);
    // Too little data is refused as well.
    const short = rawPng({ width: 16, height: 16, bitDepth: 8, colourType: 2 }, Buffer.alloc(100));
    expect(await problemOf(validateLogo(short, "image/png"))).toEqual({
      status: 422,
      code: "corrupt",
    });
  });

  it("refuses a header the PNG specification does not allow", async () => {
    for (const [colourType, bitDepth] of [
      [2, 4],
      [6, 1],
      [3, 16],
      [5, 8],
    ] as const) {
      const png = rawPng({ width: 16, height: 16, bitDepth, colourType }, Buffer.alloc(16 * 17));
      expect(await problemOf(validateLogo(png, "image/png"))).toEqual({
        status: 422,
        code: "corrupt",
      });
    }
    const interlace = rawPng(
      { width: 16, height: 16, bitDepth: 8, colourType: 0, interlace: 2 },
      Buffer.alloc(16 * 17),
    );
    expect(await problemOf(validateLogo(interlace, "image/png"))).toEqual({
      status: 422,
      code: "corrupt",
    });
  });

  it("computes the inflated size of every colour type, depth and the Adam7 passes", async () => {
    expect(pngRawSize({ width: 16, height: 16, bitDepth: 8, colourType: 2, interlace: 0 })).toBe(
      16 * 49,
    );
    // 1-bit greyscale, 17 pixels: 3 bytes per row.
    expect(pngRawSize({ width: 17, height: 2, bitDepth: 1, colourType: 0, interlace: 0 })).toBe(
      2 * 4,
    );
    expect(pngRawSize({ width: 20, height: 20, bitDepth: 16, colourType: 6, interlace: 0 })).toBe(
      20 * (1 + 160),
    );
    // Adam7 of 16 × 16 at 8-bit greyscale: the seven passes' rows, each with its filter byte.
    expect(pngRawSize({ width: 16, height: 16, bitDepth: 8, colourType: 0, interlace: 1 })).toBe(
      2 * 3 + 2 * 3 + 2 * 5 + 4 * 5 + 4 * 9 + 8 * 9 + 8 * 17,
    );
    const interlaced = rawPng(
      { width: 16, height: 16, bitDepth: 8, colourType: 0, interlace: 1 },
      Buffer.alloc(pngRawSize({ width: 16, height: 16, bitDepth: 8, colourType: 0, interlace: 1 })),
    );
    expect((await validateLogo(interlaced, "image/png")).width).toBe(16);
  });

  it("refuses a scanline with an unknown filter type, whatever the colour type and interlace", async () => {
    type Header = {
      width: number;
      height: number;
      bitDepth: number;
      colourType: number;
      interlace: number;
    };
    const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
    /** The image data with each row's filter byte from `filterOf(row)`, pixels all zero. */
    const rawWith = (header: Header, filterOf: (row: number) => number): Buffer => {
      const passes =
        header.interlace === 0
          ? [[0, 0, 1, 1]]
          : [
              [0, 0, 8, 8],
              [4, 0, 8, 8],
              [0, 4, 4, 8],
              [2, 0, 4, 4],
              [0, 2, 2, 4],
              [1, 0, 2, 2],
              [0, 1, 1, 2],
            ];
      const rows: Buffer[] = [];
      for (const [x0, y0, dx, dy] of passes as [number, number, number, number][]) {
        const w = Math.ceil((header.width - x0) / dx);
        const h = Math.ceil((header.height - y0) / dy);
        const bytes = Math.ceil((w * (channels[header.colourType] ?? 0) * header.bitDepth) / 8);
        for (let row = 0; row < h; row++) {
          const line = Buffer.alloc(1 + bytes);
          line[0] = filterOf(rows.length);
          rows.push(line);
        }
      }
      const raw = Buffer.concat(rows);
      expect(raw.length).toBe(pngRawSize(header));
      return raw;
    };
    const palette = [
      pngChunk("PLTE", Buffer.from([0, 0, 0, 255, 255, 255])),
      pngChunk("tRNS", Buffer.from([0, 255])),
    ];
    const cases: { header: Header; extra?: Buffer[] }[] = [
      // RGB with alpha, greyscale with alpha: the PDF library splits the alpha channel.
      { header: { width: 32, height: 32, bitDepth: 8, colourType: 6, interlace: 0 } },
      { header: { width: 32, height: 32, bitDepth: 16, colourType: 4, interlace: 0 } },
      // A palette with transparency: the PDF library decodes the indices.
      {
        header: { width: 32, height: 32, bitDepth: 8, colourType: 3, interlace: 0 },
        extra: palette,
      },
      {
        header: { width: 33, height: 17, bitDepth: 2, colourType: 3, interlace: 0 },
        extra: palette,
      },
      // Interlaced: the PDF library always decodes.
      { header: { width: 32, height: 32, bitDepth: 8, colourType: 2, interlace: 1 } },
      { header: { width: 21, height: 19, bitDepth: 8, colourType: 6, interlace: 1 } },
    ];
    for (const { header, extra } of cases) {
      // Every defined filter type, row after row, is fine.
      const good = await validateLogo(
        rawPng(
          header,
          rawWith(header, (row) => row % 5),
          extra,
        ),
        "image/png",
      );
      expect(good.width).toBe(header.width);
      // What the check lets through, the PDF reports render.
      const pdf = await renderCustomerReport({
        language: "en",
        tenantName: "Contoso",
        month: "2026-10",
        figures: {
          objectsByKind: [],
          backupSuccessRate: null,
          verifiedShare: null,
          restores: null,
          storedBytes: null,
          causes: [],
          suspicious: 0,
        },
        brand: {
          name: "MSP",
          logo: { data: good.bytes, format: "png", width: good.width, height: good.height },
        },
        generatedAt: new Date("2026-11-01T07:00:00Z"),
      });
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      for (const bad of [5, 9, 128, 255]) {
        const raw = rawWith(header, (row) => (row === 7 ? bad : row % 5));
        expect(pngFiltersValid(raw, header)).toBe(false);
        expect(await problemOf(validateLogo(rawPng(header, raw, extra), "image/png"))).toEqual({
          status: 422,
          code: "corrupt",
        });
      }
    }
  });

  it("drops the ICC profile and unknown chunks, and refuses an unknown critical chunk", async () => {
    const png = testPng(32, 32, {
      before: [
        pngChunk(
          "iCCP",
          Buffer.concat([Buffer.from("icc\0\0", "latin1"), deflateSync(Buffer.alloc(64))]),
        ),
        pngChunk("prVt", Buffer.from("private")),
        pngChunk("gAMA", Buffer.from([0, 0, 0xb1, 0x8f])),
      ],
    });
    const logo = await validateLogo(png, "image/png");
    expect(logo.bytes.includes(Buffer.from("iCCP"))).toBe(false);
    expect(logo.bytes.includes(Buffer.from("prVt"))).toBe(false);
    expect(logo.bytes.includes(Buffer.from("gAMA"))).toBe(true);
    const critical = testPng(32, 32, { before: [pngChunk("ABCD", Buffer.alloc(4))] });
    expect(await problemOf(validateLogo(critical, "image/png"))).toEqual({
      status: 422,
      code: "corrupt",
    });
  });
});
