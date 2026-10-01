import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { QuickXorHash, UploadDigest, quickXorHash } from "./quickxorhash.js";
import { pseudoRandomBytes } from "./testing/fixtures.js";

/**
 * Literal transcription of Microsoft's reference QuickXorHash (three 64-bit
 * cells, the last one 32 bits wide) using BigInt, to cross-check the byte-wise
 * implementation. Slow, which is why it only lives in the test.
 */
function referenceQuickXorHash(input: Buffer): string {
  const bitsInLastCell = 32;
  const shift = 11;
  const widthInBits = 160;
  const data = [0n, 0n, 0n];
  const mask64 = (1n << 64n) - 1n;
  let shiftSoFar = 0;
  let lengthSoFar = 0n;

  const hashCore = (array: Buffer): void => {
    const cbSize = array.length;
    let currentShift = shiftSoFar;
    let vectorArrayIndex = Math.floor(currentShift / 64);
    let vectorOffset = currentShift % 64;
    const iterations = Math.min(cbSize, widthInBits);
    for (let i = 0; i < iterations; i++) {
      const isLastCell = vectorArrayIndex === data.length - 1;
      const bitsInVectorCell = isLastCell ? bitsInLastCell : 64;
      if (vectorOffset <= bitsInVectorCell - 8) {
        for (let j = i; j < cbSize; j += widthInBits) {
          data[vectorArrayIndex] =
            ((data[vectorArrayIndex] as bigint) ^
              (BigInt(array[j] as number) << BigInt(vectorOffset))) &
            mask64;
        }
      } else {
        const index1 = vectorArrayIndex;
        const index2 = isLastCell ? 0 : vectorArrayIndex + 1;
        const low = bitsInVectorCell - vectorOffset;
        let xoredByte = 0;
        for (let j = i; j < cbSize; j += widthInBits) {
          xoredByte ^= array[j] as number;
        }
        data[index1] =
          ((data[index1] as bigint) ^ (BigInt(xoredByte) << BigInt(vectorOffset))) & mask64;
        data[index2] = ((data[index2] as bigint) ^ (BigInt(xoredByte) >> BigInt(low))) & mask64;
      }
      vectorOffset += shift;
      while (vectorOffset >= bitsInVectorCell) {
        vectorArrayIndex = isLastCell ? 0 : vectorArrayIndex + 1;
        vectorOffset -= bitsInVectorCell;
      }
      currentShift = vectorOffset;
    }
    shiftSoFar = (shiftSoFar + shift * (cbSize % widthInBits)) % widthInBits;
    lengthSoFar += BigInt(cbSize);
  };

  hashCore(input);

  const rgb = Buffer.alloc(20);
  for (let i = 0; i < data.length - 1; i++) {
    rgb.writeBigUInt64LE(data[i] as bigint, i * 8);
  }
  const last = Buffer.alloc(8);
  last.writeBigUInt64LE(data[data.length - 1] as bigint, 0);
  last.subarray(0, bitsInLastCell / 8).copy(rgb, (data.length - 1) * 8);
  const lengthBytes = Buffer.alloc(8);
  lengthBytes.writeBigUInt64LE(lengthSoFar, 0);
  for (let i = 0; i < 8; i++) {
    rgb[widthInBits / 8 - 8 + i] ^= lengthBytes[i] as number;
  }
  return rgb.toString("base64");
}

describe("QuickXorHash", () => {
  it("hashes empty input to twenty zero bytes", () => {
    expect(quickXorHash(Buffer.alloc(0))).toBe("AAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  });

  it("agrees with the reference transcription on a range of sizes", () => {
    for (const size of [1, 7, 20, 21, 159, 160, 161, 333, 1024, 4096, 12345]) {
      const input = pseudoRandomBytes(size, size);
      expect(quickXorHash(input), `size ${size}`).toBe(referenceQuickXorHash(input));
    }
  });

  it("is independent of how the input is split", () => {
    const input = pseudoRandomBytes(50_000, 99);
    const whole = quickXorHash(input);
    for (const piece of [1, 3, 17, 160, 4097]) {
      const hasher = new QuickXorHash();
      for (let offset = 0; offset < input.length; offset += piece) {
        hasher.update(input.subarray(offset, offset + piece));
      }
      expect(hasher.digestBase64(), `piece ${piece}`).toBe(whole);
    }
  });

  it("is not a plain XOR: different byte order gives a different hash", () => {
    expect(quickXorHash(Buffer.from("ab"))).not.toBe(quickXorHash(Buffer.from("ba")));
  });
});

describe("UploadDigest", () => {
  it("counts the bytes and computes both hashes independent of chunking", () => {
    const input = pseudoRandomBytes(70_000, 5);
    const digest = new UploadDigest();
    for (let offset = 0; offset < input.length; offset += 4096) {
      digest.update(input.subarray(offset, offset + 4096));
    }
    expect(digest.bytes).toBe(input.length);
    expect(digest.quickXorHash).toBe(quickXorHash(input));
    expect(digest.sha256Hex).toBe(createHash("sha256").update(input).digest("hex"));
    expect(() => digest.update(Buffer.from("late"))).toThrow(/already read/);
  });
});
