import reportsDe from "@restow/i18n/resources/de/reports.json" with { type: "json" };
import reportsEn from "@restow/i18n/resources/en/reports.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { labelIndices, niceScale } from "./chart-scale.js";
import { formatBytes, formatDuration, formatPercent, signed } from "./format.js";
import { reportTranslator } from "./i18n.js";
import { pdfText } from "./text.js";

describe("niceScale", () => {
  it("rounds the axis up to 1, 2, 2.5 or 5 times a power of ten", () => {
    expect(niceScale(213)).toEqual({ max: 300, ticks: [0, 100, 200, 300] });
    expect(niceScale(900)).toEqual({ max: 1000, ticks: [0, 250, 500, 750, 1000] });
    expect(niceScale(170)).toEqual({ max: 200, ticks: [0, 50, 100, 150, 200] });
    expect(niceScale(0.9)).toEqual({ max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] });
    expect(niceScale(4000).max).toBe(4000);
  });

  it("never splits counts into fractions and survives an empty chart", () => {
    expect(niceScale(2, 4, true)).toEqual({ max: 2, ticks: [0, 1, 2] });
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceScale(Number.NaN)).toEqual({ max: 1, ticks: [0, 1] });
  });
});

describe("labelIndices", () => {
  it("labels every category when they fit, else first, last and evenly spaced ones", () => {
    expect(labelIndices(4, 6)).toEqual([0, 1, 2, 3]);
    expect(labelIndices(30, 6)).toEqual([0, 6, 12, 17, 23, 29]);
    expect(labelIndices(0, 6)).toEqual([]);
    expect(labelIndices(10, 1)).toEqual([0]);
  });
});

describe("pdfText", () => {
  it("keeps what the standard fonts can draw", () => {
    expect(pdfText("Zürich – Straße … € 5 × 3")).toBe("Zürich – Straße … € 5 × 3");
  });

  it("maps look-alikes, drops accents it cannot draw, and marks the rest", () => {
    const narrow = String.fromCodePoint(0x202f);
    const minus = String.fromCodePoint(0x2212);
    const noBreak = String.fromCodePoint(0x00a0);
    expect(pdfText(`1${narrow}000 ${minus}5`)).toBe(`1${noBreak}000 -5`);
    expect(pdfText("Łukasz Đorđe Kőszegi")).toBe("Lukasz Dorde Koszegi");
    expect(pdfText("東京 😀")).toBe("?? ?");
    // Decomposed umlauts are composed first.
    expect(pdfText(`Mu${String.fromCodePoint(0x0308)}ller`)).toBe("Müller");
  });
});

describe("report formatting", () => {
  it("formats sizes, shares and durations per language", () => {
    expect(formatBytes(1536, "en")).toBe("1.5 kB");
    expect(formatBytes(0, "de")).toBe("0 Byte");
    expect(formatPercent(0.925, "de")).toBe(`92,5${String.fromCodePoint(0x00a0)}%`);
    // A share below 1 never rounds up to 100 %: failed runs stay visible.
    expect(formatPercent(2499 / 2500, "en")).toBe("99.9%");
    expect(formatPercent(199 / 200, "en", 0)).toBe("99%");
    expect(formatPercent(1, "en")).toBe("100%");
    expect(formatDuration(42, "en")).toBe("42 sec");
    expect(formatDuration(5400, "de")).toBe("1,5 Std.");
    expect(signed(3, "3")).toBe("+3");
    expect(signed(-3, "-3")).toBe("-3");
  });
});

function leafKeys(value: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) =>
    child !== null && typeof child === "object"
      ? leafKeys(child as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

describe("reportTranslator", () => {
  it("has the same keys in German and English", () => {
    expect(leafKeys(reportsDe).sort()).toEqual(leafKeys(reportsEn).sort());
    expect(leafKeys(reportsEn).length).toBeGreaterThan(50);
  });

  it("formats the reports namespace with ICU plurals in both languages", () => {
    expect(reportTranslator("en")("stats.subtitle.provider", { count: 1 })).toBe(
      "All tenants (1 tenant)",
    );
    expect(reportTranslator("de")("stats.subtitle.provider", { count: 3 })).toBe(
      "Alle Mandanten (3 Mandanten)",
    );
    expect(reportTranslator("de")("document.page", { page: 2, total: 5 })).toBe("Seite 2 von 5");
  });
});
