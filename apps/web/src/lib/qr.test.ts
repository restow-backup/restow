import { describe, expect, it } from "vitest";

import {
  alignmentPositions,
  dataCodewords,
  dataCodewordsFor,
  encodeQr,
  formatBits,
  interleavedCodewords,
  qrSvgPath,
  reedSolomonGenerator,
  reedSolomonRemainder,
  versionBits,
  versionFor,
} from "./qr";

/**
 * Reference values come from ISO/IEC 18004 and its widely reproduced tables:
 * the "HELLO WORLD" 1-M error correction example, the format and version
 * information tables, the level-M capacities and the alignment positions.
 */

const OTPAUTH =
  "otpauth://totp/Restow%20(restow.example.com):admin%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA&issuer=Restow+%28restow.example.com%29&digits=6&period=30";

function bitString(value: number, length: number): string {
  return value.toString(2).padStart(length, "0");
}

describe("Reed-Solomon", () => {
  it("reproduces the HELLO WORLD 1-M error correction codewords", () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(reedSolomonRemainder(data, reedSolomonGenerator(10))).toEqual([
      196, 35, 39, 119, 235, 215, 231, 226, 93, 23,
    ]);
  });
});

describe("format and version information", () => {
  it("matches the level-M format table for every mask", () => {
    const table = [
      "101010000010010",
      "101000100100101",
      "101111001111100",
      "101101101001011",
      "100010111111001",
      "100000011001110",
      "100111110010111",
      "100101010100000",
    ];
    expect(table.map((_, mask) => bitString(formatBits(mask), 15))).toEqual(table);
  });

  it("matches the version information table", () => {
    expect(bitString(versionBits(7), 18)).toBe("000111110010010100");
    expect(bitString(versionBits(8), 18)).toBe("001000010110111100");
  });
});

describe("capacity", () => {
  it("knows the level-M data codewords per version", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(dataCodewords)).toEqual([
      16, 28, 44, 64, 86, 108, 124, 154, 182, 216,
    ]);
    expect(dataCodewords(40)).toBe(2334);
  });

  it("picks the smallest version that holds the bytes", () => {
    expect(versionFor(14)).toBe(1);
    expect(versionFor(15)).toBe(2);
    expect(versionFor(122)).toBe(7);
    expect(versionFor(123)).toBe(8);
    expect(versionFor(2331)).toBe(40);
    expect(() => versionFor(2332)).toThrow(RangeError);
  });

  it("fills the data codewords with the alternating pad bytes", () => {
    const codewords = dataCodewordsFor(new TextEncoder().encode("A"), 1);
    expect(codewords).toHaveLength(16);
    // 0100 (byte mode), 00000001 (length), 01000001 ("A"), 0000 terminator.
    expect(codewords.slice(0, 3)).toEqual([0x40, 0x14, 0x10]);
    expect(codewords.slice(3, 7)).toEqual([0xec, 0x11, 0xec, 0x11]);
  });

  it("interleaves every data and error correction codeword exactly once", () => {
    const version = 8; // two short and two long blocks at level M
    const data = dataCodewordsFor(new TextEncoder().encode(OTPAUTH.slice(0, 140)), version);
    const all = interleavedCodewords(data, version);
    expect(all).toHaveLength(242);
    // Data codewords come first, round-robin across the blocks.
    expect(all[0]).toBe(data[0]);
    expect(all[1]).toBe(data[38]);
    expect(all[2]).toBe(data[76]);
    expect(all[3]).toBe(data[115]);
  });
});

describe("alignment patterns", () => {
  it("places the centres like the standard table", () => {
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(2)).toEqual([6, 18]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(14)).toEqual([6, 26, 46, 66]);
    expect(alignmentPositions(32)).toEqual([6, 34, 60, 86, 112, 138]);
    expect(alignmentPositions(40)).toEqual([6, 30, 58, 86, 114, 142, 170]);
  });
});

describe("encodeQr", () => {
  const code = encodeQr(OTPAUTH);

  function finderAt(left: number, top: number): boolean {
    for (let dy = 0; dy < 7; dy++) {
      for (let dx = 0; dx < 7; dx++) {
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        if (code.modules[top + dy]?.[left + dx] !== (ring !== 2)) {
          return false;
        }
      }
    }
    return true;
  }

  function readFormat(cells: readonly [number, number][]): string {
    return cells
      .map(([x, y]) => (code.modules[y]?.[x] ? "1" : "0"))
      .reverse()
      .join("");
  }

  it("sizes the symbol from its version", () => {
    expect(code.version).toBe(versionFor(new TextEncoder().encode(OTPAUTH).length));
    expect(code.size).toBe(code.version * 4 + 17);
    expect(code.modules).toHaveLength(code.size);
    expect(code.modules.every((row) => row.length === code.size)).toBe(true);
  });

  it("draws the three finder patterns, the timing patterns and the dark module", () => {
    expect(finderAt(0, 0)).toBe(true);
    expect(finderAt(code.size - 7, 0)).toBe(true);
    expect(finderAt(0, code.size - 7)).toBe(true);
    for (let i = 8; i < code.size - 8; i++) {
      expect(code.modules[6]?.[i]).toBe(i % 2 === 0);
      expect(code.modules[i]?.[6]).toBe(i % 2 === 0);
    }
    expect(code.modules[code.size - 8]?.[8]).toBe(true);
  });

  it("writes the chosen mask into both copies of the format information", () => {
    const expected = bitString(formatBits(code.mask), 15);
    const first: [number, number][] = [
      [8, 0],
      [8, 1],
      [8, 2],
      [8, 3],
      [8, 4],
      [8, 5],
      [8, 7],
      [8, 8],
      [7, 8],
      [5, 8],
      [4, 8],
      [3, 8],
      [2, 8],
      [1, 8],
      [0, 8],
    ];
    const second: [number, number][] = [
      ...Array.from({ length: 8 }, (_, i): [number, number] => [code.size - 1 - i, 8]),
      ...Array.from({ length: 7 }, (_, i): [number, number] => [8, code.size - 7 + i]),
    ];
    expect(readFormat(first)).toBe(expected);
    expect(readFormat(second)).toBe(expected);
  });

  it("is deterministic", () => {
    expect(encodeQr(OTPAUTH)).toEqual(code);
  });
});

describe("qrSvgPath", () => {
  it("draws one rectangle per dark run, inside the quiet zone", () => {
    const path = qrSvgPath({
      version: 1,
      size: 3,
      mask: 0,
      modules: [
        [true, true, false],
        [false, false, false],
        [true, false, true],
      ],
    });
    expect(path).toBe("M4 4h2v1h-2zM4 6h1v1h-1zM6 6h1v1h-1z");
  });
});
