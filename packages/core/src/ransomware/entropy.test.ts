import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  ENTROPY_SAMPLE_BYTES,
  entropyExpectation,
  entropySampleOf,
  looksEncrypted,
  shannonEntropy,
} from "./entropy.js";

const text = Buffer.from(
  "Quarterly report. Revenue grew in every region; costs stayed flat. ".repeat(2000),
  "utf8",
);

describe("Shannon entropy", () => {
  it("is 0 for nothing and for one repeated byte, 8 for every byte equally often", () => {
    expect(shannonEntropy(new Uint8Array())).toBe(0);
    expect(shannonEntropy(new Uint8Array(1000).fill(7))).toBe(0);
    const all = new Uint8Array(256 * 16);
    for (let i = 0; i < all.length; i++) all[i] = i % 256;
    expect(shannonEntropy(all)).toBeCloseTo(8, 10);
  });

  it("tells text from encrypted data, and sees that compression looks the same", () => {
    expect(shannonEntropy(text.subarray(0, ENTROPY_SAMPLE_BYTES))).toBeLessThan(5);
    expect(shannonEntropy(randomBytes(ENTROPY_SAMPLE_BYTES))).toBeGreaterThan(7.99);
    expect(shannonEntropy(deflateSync(randomBytes(ENTROPY_SAMPLE_BYTES)))).toBeGreaterThan(7.9);
  });
});

describe("the expectation of a file type", () => {
  it("knows compressed and plain formats by extension or name", () => {
    expect(entropyExpectation("docx")).toBe("compressed");
    expect(entropyExpectation(".JPG")).toBe("compressed");
    expect(entropyExpectation("report.pdf")).toBe("compressed");
    expect(entropyExpectation("txt")).toBe("plain");
    expect(entropyExpectation("ledger.csv")).toBe("plain");
    expect(entropyExpectation("locked")).toBe("unknown");
    expect(entropyExpectation("")).toBe("unknown");
  });
});

describe("judging a sample", () => {
  const random = randomBytes(2 * ENTROPY_SAMPLE_BYTES);
  const encrypted = entropySampleOf(
    "/data/ledger.csv",
    random.length,
    random.subarray(0, ENTROPY_SAMPLE_BYTES),
    random.subarray(ENTROPY_SAMPLE_BYTES),
  );
  const intact = entropySampleOf(
    "/data/ledger.csv",
    text.length,
    text.subarray(0, ENTROPY_SAMPLE_BYTES),
    text.subarray(text.length - ENTROPY_SAMPLE_BYTES),
  );

  it("measures both windows of a long file and only the head of a short one", () => {
    expect(encrypted.ext).toBe("csv");
    expect(encrypted.tail).not.toBeNull();
    const short = entropySampleOf("/a.txt", 10, text.subarray(0, 10), null);
    expect(short.tail).toBeNull();
  });

  it("flags a plain file with one high window, an unknown type only with both", () => {
    expect(looksEncrypted(encrypted, 7.9)).toBe(true);
    expect(looksEncrypted(intact, 7.9)).toBe(false);
    expect(looksEncrypted({ ...intact, tail: 7.99 }, 7.9)).toBe(true);
    const unknown = { path: "/x.dat", ext: "dat", size: 1, head: 7.99, tail: 5 };
    expect(looksEncrypted(unknown, 7.9)).toBe(false);
    expect(looksEncrypted({ ...unknown, tail: 7.95 }, 7.9)).toBe(true);
    expect(looksEncrypted({ ...unknown, tail: null }, 7.9)).toBe(true);
  });

  it("never judges a compressed format", () => {
    expect(looksEncrypted({ ...encrypted, ext: "zip" }, 7.9)).toBeNull();
  });
});
