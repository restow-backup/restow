import { describe, expect, it } from "vitest";

import {
  dedupSavings,
  formatBytes,
  formatPercent,
  formatRelative,
  initialsOf,
  parseTimestamp,
} from "./format";

describe("formatBytes", () => {
  it("scales units and follows the locale", () => {
    expect(formatBytes(0, "en")).toBe("0 byte");
    expect(formatBytes(1536, "en")).toBe("1.5 kB");
    expect(formatBytes(5 * 1024 ** 3, "en")).toBe("5 GB");
    expect(formatBytes(1536, "de")).toBe("1,5 kB");
  });

  it("treats invalid input as empty", () => {
    expect(formatBytes(Number.NaN, "en")).toBe("0 byte");
    expect(formatBytes(-5, "en")).toBe("0 byte");
  });
});

describe("formatPercent and dedupSavings", () => {
  it("clamps the ratio", () => {
    expect(formatPercent(0.256, "en")).toBe("26%");
    expect(formatPercent(2, "en")).toBe("100%");
    expect(formatPercent(-1, "en")).toBe("0%");
  });

  it("never rounds a share below 1 up to 100 %", () => {
    const plain = (text: string) => text.replace(/[   ]/g, " ");
    // 199 of 200 runs succeeded: one failed run must stay visible.
    expect(formatPercent(199 / 200, "en")).toBe("99%");
    expect(plain(formatPercent(199 / 200, "de"))).toBe("99 %");
    expect(formatPercent(4180 / 4200, "en")).toBe("99%");
    expect(formatPercent(0.999_999, "en")).toBe("99%");
    // With one decimal the step below 100 is 99.9.
    expect(formatPercent(2499 / 2500, "en", 1)).toBe("99.9%");
    expect(plain(formatPercent(2499 / 2500, "de", 1))).toBe("99,9 %");
    expect(formatPercent(0.994, "en", 1)).toBe("99.4%");
    // Values that do not round to 100 are unchanged, a complete share is 100.
    expect(formatPercent(0.984, "en")).toBe("98%");
    expect(formatPercent(1, "en")).toBe("100%");
    expect(formatPercent(1, "en", 1)).toBe("100%");
  });

  it("computes what deduplication saved", () => {
    expect(dedupSavings(1000, 400)).toBeCloseTo(0.6);
    expect(dedupSavings(0, 0)).toBe(0);
    expect(dedupSavings(100, 150)).toBe(0);
  });
});

describe("timestamps", () => {
  it("parses ISO strings and rejects garbage", () => {
    expect(parseTimestamp("2026-09-21T10:00:00Z")?.toISOString()).toBe("2026-09-21T10:00:00.000Z");
    expect(parseTimestamp("not a date")).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
  });

  it("returns null for missing relative times instead of a fake value", () => {
    expect(formatRelative(null, "de")).toBeNull();
    expect(formatRelative("nope", "en")).toBeNull();
    expect(formatRelative(new Date(Date.now() - 3_600_000).toISOString(), "en")).toMatch(/ago$/);
  });
});

describe("initialsOf", () => {
  it("builds initials from first and last word", () => {
    expect(initialsOf("Lucas Flores")).toBe("LF");
    expect(initialsOf("Anna Maria von Berg")).toBe("AB");
    expect(initialsOf("root")).toBe("R");
    expect(initialsOf("")).toBe("?");
    expect(initialsOf(null)).toBe("?");
  });
});
