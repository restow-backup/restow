import { createHash } from "node:crypto";
import setupDe from "@restow/i18n/resources/de/setup.json" with { type: "json" };
import setupEn from "@restow/i18n/resources/en/setup.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import {
  DISCLAIMER_VERSION,
  disclaimerRequired,
  disclaimerState,
  isDisclaimerAccepted,
} from "./disclaimer.js";

type Tree = { [key: string]: string | Tree };

/** The keys that make up the wording an operator accepts (not the button labels around it). */
const NOTICE_KEYS = ["title", "intro", "points", "accept"] as const;

function flatten(tree: Tree, prefix = ""): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string"
      ? [[prefix ? `${prefix}.${key}` : key, value] as [string, string]]
      : flatten(value, prefix ? `${prefix}.${key}` : key),
  );
}

/** SHA-256 of the notice text of one language, key paths sorted so reordering does not matter. */
function noticeDigest(disclaimer: Tree): string {
  const wording: Tree = {};
  for (const key of NOTICE_KEYS) {
    wording[key] = disclaimer[key] as string | Tree;
  }
  const lines = flatten(wording)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

const notice = { en: setupEn.disclaimer as Tree, de: setupDe.disclaimer as Tree };

/**
 * The digest of the wording accepted in DISCLAIMER_VERSION. Changing the text
 * without bumping the version would let an old acceptance count for new words,
 * so the wording is pinned here: when this test fails, bump DISCLAIMER_VERSION
 * (lib/disclaimer.ts) and paste the new digests, in the same change.
 */
const PINNED_DIGESTS: Record<"en" | "de", string> = {
  en: "dfa3cf80534cb5c7a210bae6410d2a929bfeb9a5f8ee2b45a3a9c4a2a8f06159",
  de: "d8c52bef2eb1cb9fdda6332088c296e649d955c405a7b2ac20459ee9fc626ae4",
};

describe("isDisclaimerAccepted", () => {
  const off = { enabled: false };

  it("needs the current version", () => {
    expect(isDisclaimerAccepted(null, off)).toBe(false);
    expect(isDisclaimerAccepted({ disclaimerVersion: null }, off)).toBe(false);
    expect(isDisclaimerAccepted({ disclaimerVersion: "2020-01-01" }, off)).toBe(false);
    expect(isDisclaimerAccepted({ disclaimerVersion: DISCLAIMER_VERSION }, off)).toBe(true);
  });

  it("asks again when the text version moves on", () => {
    // An acceptance of any other version, older or newer, never counts as the current one.
    expect(isDisclaimerAccepted({ disclaimerVersion: `${DISCLAIMER_VERSION}.1` }, off)).toBe(false);
  });

  it("treats the public demo as accepted, with or without a stored record", () => {
    expect(isDisclaimerAccepted(null, { enabled: true })).toBe(true);
    expect(isDisclaimerAccepted({ disclaimerVersion: null }, { enabled: true })).toBe(true);
  });
});

describe("disclaimerState", () => {
  it("reports the current version and whether it is accepted", () => {
    expect(disclaimerState(null, { enabled: false })).toEqual({
      version: DISCLAIMER_VERSION,
      accepted: false,
    });
    expect(disclaimerState({ disclaimerVersion: DISCLAIMER_VERSION }, { enabled: false })).toEqual({
      version: DISCLAIMER_VERSION,
      accepted: true,
    });
  });
});

describe("disclaimerRequired", () => {
  it("is a 428 problem with its own type and the version to accept", () => {
    const problem = disclaimerRequired();
    expect(problem.status).toBe(428);
    expect(problem.type).toBe("urn:restow:problem:disclaimer-required");
    expect(problem.extensions).toEqual({ version: DISCLAIMER_VERSION });
  });
});

describe("the notice text", () => {
  it("cannot change without a new DISCLAIMER_VERSION", () => {
    expect({ en: noticeDigest(notice.en), de: noticeDigest(notice.de) }).toEqual(PINNED_DIGESTS);
  });

  it("covers every point the operator has to accept, in both languages", () => {
    const points = [
      "strategy",
      "storage",
      "immutability",
      "keys",
      "security",
      "restore",
      "gobd",
      "warranty",
    ];
    for (const language of ["en", "de"] as const) {
      const listed = Object.keys(notice[language].points as Tree);
      expect(listed).toEqual(points);
    }
  });

  it("uses the product name from the branding, never a hard-coded one", () => {
    for (const language of ["en", "de"] as const) {
      const text = flatten(notice[language])
        .map(([, value]) => value)
        .join("\n");
      expect(text).toContain("{appName}");
      expect(text).not.toMatch(/restow/i);
    }
  });

  it("says designed for GoBD-compliant use, never certified", () => {
    const en = flatten(notice.en)
      .map(([, value]) => value)
      .join("\n");
    const de = flatten(notice.de)
      .map(([, value]) => value)
      .join("\n");
    expect(en).toContain("designed for GoBD-compliant use");
    expect(de).toContain("für den GoBD-konformen Einsatz ausgelegt");
    for (const text of [en, de]) {
      expect(text).not.toMatch(/GoBD[- ](certified|zertifiziert)/i);
      expect(text).not.toMatch(/revisionssicher/i);
    }
  });

  it("names the master key and the missing-WORM consequence", () => {
    const en = flatten(notice.en)
      .map(([, value]) => value)
      .join("\n");
    expect(en).toContain("master key");
    expect(en).toContain("WORM");
    expect(en).toContain("3-2-1");
  });
});
