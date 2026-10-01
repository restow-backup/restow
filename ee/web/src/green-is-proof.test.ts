import { describe, expect, it } from "vitest";

/**
 * Green means proof (brand guide, section 4; the same rule as
 * apps/web/src/green-is-proof.test.ts). Here the only green is the verified
 * hash chain of the audit log: "Chain intact" and an entry whose hash still
 * recomputes. A member who is active, a receiver that is getting reports or an
 * edition that a key unlocked is a state, not a proof: neutral or Lapis.
 */

const sources = import.meta.glob<string>(["./**/*.ts", "./**/*.tsx", "!./**/*.test.*"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const GREEN =
  /\b(?:bg|text|border|fill|stroke|ring|from|via|to|outline|divide|shadow|accent)-success\b|["']success["']|STATUS_CHART_COLOR\.success|--chart-success/;

const ALLOWED: Readonly<Record<string, string>> = {
  "./audit-log/components/chain-status.tsx": "the verified hash chain: Chain intact",
  "./audit-log/components/entry-sheet.tsx": "an entry whose hash still recomputes",
};

const using = Object.entries(sources)
  .filter(([, source]) => GREEN.test(source))
  .map(([path]) => path);

describe("green is proof", () => {
  it("scans the modules' sources", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(40);
  });

  it("is named only by the verified hash chain", () => {
    expect(
      using.filter((path) => !(path in ALLOWED)),
      "Green is for proof only; use `outline`, `info` or `muted`, or add the file with the reason it is proof.",
    ).toEqual([]);
  });

  it("keeps the list honest: every file on it still uses green", () => {
    expect(Object.keys(ALLOWED).filter((path) => !using.includes(path))).toEqual([]);
  });
});
