import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodePng, generatedPng } from "./png.js";
import { mulberry32 } from "./prng.js";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("png", () => {
  it("writes a structurally valid PNG", () => {
    const png = encodePng(2, 2, Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]));
    expect(png.subarray(0, 8).equals(SIGNATURE)).toBe(true);
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(2);
    expect(png.readUInt32BE(20)).toBe(2);
    expect(png.subarray(png.length - 8, png.length - 4).toString("ascii")).toBe("IEND");
    // The IDAT payload inflates to filter byte + 3 bytes per pixel, per row.
    const idat = png.indexOf("IDAT");
    const length = png.readUInt32BE(idat - 4);
    expect(inflateSync(png.subarray(idat + 4, idat + 4 + length)).length).toBe(2 * (1 + 6));
  });

  it("refuses pixel data of the wrong size", () => {
    expect(() => encodePng(2, 2, Buffer.alloc(3))).toThrow();
  });

  it("generates the same small picture for the same seed and others for other seeds", () => {
    const a = generatedPng(mulberry32(5));
    expect(generatedPng(mulberry32(5)).equals(a)).toBe(true);
    expect(generatedPng(mulberry32(6)).equals(a)).toBe(false);
    expect(a.subarray(0, 8).equals(SIGNATURE)).toBe(true);
    expect(a.length).toBeLessThan(16 * 1024);
  });
});
