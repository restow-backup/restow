/**
 * Recovery codes (docs/BAREMETAL.md 9.1, 21.1): the shared vectors the Go agent owns
 * (agent/internal/recovery/testdata/recovery-code-vectors.json) give the same results here, every
 * entry without an expected value is refused, and the generator draws every symbol of the alphabet
 * about equally often.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalOrigin,
  formatMatchCode,
  formatRecoveryCode,
  generateRecoveryCode,
  hashRecoveryCodeProof,
  normalizeRecoveryCode,
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_LENGTH,
  recoveryCodeProof,
  recoveryMatchCode,
  spkiCheckOf,
} from "./recovery-code.js";

const VECTORS = fileURLToPath(
  new URL(
    "../../../../../agent/internal/recovery/testdata/recovery-code-vectors.json",
    import.meta.url,
  ),
);

interface Vectors {
  format: string;
  alphabet: string;
  normalize: { input: string; normalized: string | null; display: string | null }[];
  canonicalOrigin: { input: string; allowHttp: boolean; origin: string | null }[];
  proof: { origin: string; code: string; codeProof: string; codeHash: string }[];
  matchCode: { sessionSecret: string; sessionSecretSha256: string; matchCode: string }[];
  spkiCheck: { spkiSha256: string; spkiCheck: string }[];
}

const vectors = JSON.parse(readFileSync(VECTORS, "utf8")) as Vectors;

describe("recovery code vectors shared with the agent", () => {
  it("is the format and the alphabet this side knows", () => {
    expect(vectors.format).toBe("restow-recovery-code-vectors-v1");
    expect(vectors.alphabet).toBe(RECOVERY_CODE_ALPHABET);
  });

  it.each(vectors.normalize)("normalizes $input", (entry) => {
    const normalized = normalizeRecoveryCode(entry.input);
    expect(normalized).toBe(entry.normalized);
    if (normalized !== null) {
      expect(formatRecoveryCode(normalized)).toBe(entry.display);
    }
  });

  it.each(vectors.canonicalOrigin)("canonicalizes $input", (entry) => {
    expect(canonicalOrigin(entry.input, { allowHttp: entry.allowHttp })).toBe(entry.origin);
  });

  it.each(vectors.proof)("proves $code for $origin", (entry) => {
    const proof = recoveryCodeProof(entry.origin, entry.code);
    expect(proof).toBe(entry.codeProof);
    expect(hashRecoveryCodeProof(proof)).toBe(entry.codeHash);
  });

  it("binds a proof to the origin: another origin gives another value", () => {
    const [real, phishing] = vectors.proof;
    expect(real?.code).toBe(phishing?.code);
    expect(real?.codeProof).not.toBe(phishing?.codeProof);
  });

  it.each(vectors.matchCode)("derives the match code of $sessionSecretSha256", (entry) => {
    expect(recoveryMatchCode(entry.sessionSecretSha256)).toBe(entry.matchCode);
  });

  it.each(vectors.spkiCheck)("groups the check value of $spkiSha256", (entry) => {
    expect(spkiCheckOf(entry.spkiSha256)).toBe(entry.spkiCheck);
  });
});

describe("recovery codes", () => {
  it("has 30 symbols and none of I, L, O, U, Y, Z", () => {
    expect(RECOVERY_CODE_ALPHABET).toHaveLength(30);
    for (const letter of "ILOUYZ") {
      expect(RECOVERY_CODE_ALPHABET).not.toContain(letter);
    }
    expect(new Set(RECOVERY_CODE_ALPHABET).size).toBe(30);
  });

  it("generates normalized codes that survive their own display", () => {
    const code = generateRecoveryCode();
    expect(code).toHaveLength(RECOVERY_CODE_LENGTH);
    expect(normalizeRecoveryCode(formatRecoveryCode(code))).toBe(code);
    expect(formatRecoveryCode(code)).toMatch(/^RC(?:-[0-9A-X]{5}){5}$/);
  });

  it("draws every symbol about equally often", () => {
    const counts = new Map<string, number>();
    const draws = 30_000;
    let drawn = 0;
    while (drawn < draws) {
      for (const symbol of generateRecoveryCode()) {
        counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
        drawn += 1;
      }
    }
    const mean = drawn / RECOVERY_CODE_ALPHABET.length;
    expect(counts.size).toBe(RECOVERY_CODE_ALPHABET.length);
    for (const count of counts.values()) {
      expect(Math.abs(count - mean)).toBeLessThan(mean * 0.25);
    }
  });

  it("asks the source again for a value out of range instead of folding it", () => {
    const answers = [30, -1, 31, 0, ...Array.from({ length: 24 }, () => 29)];
    const code = generateRecoveryCode(() => answers.shift() ?? 0);
    expect(code).toBe(`0${"X".repeat(24)}`);
  });

  it("shows a match code in two groups and refuses check values that are not a hash", () => {
    expect(formatMatchCode("483914")).toBe("483 914");
    expect(spkiCheckOf(null)).toBeNull();
    expect(spkiCheckOf("abc")).toBeNull();
  });

  it("refuses an empty address, a bare path and an http address without the lab switch", () => {
    expect(canonicalOrigin("")).toBeNull();
    expect(canonicalOrigin("https://restow.firma.de/#")).toBeNull();
    expect(canonicalOrigin("https://restow.firma.de?")).toBeNull();
    expect(canonicalOrigin("http://restow.firma.de")).toBeNull();
    expect(canonicalOrigin("http://restow.firma.de", { allowHttp: true })).toBe(
      "http://restow.firma.de",
    );
  });
});
