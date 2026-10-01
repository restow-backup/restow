import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { supportedLanguages } from "./index.js";

/**
 * An em dash used as a sentence pause, or an en dash with whitespace on
 * either side used the same way. An unspaced en dash in a numeric or
 * placeholder range (`30–90`, `{from}–{to}`) does not match.
 */
const DISALLOWED_DASH = /—|(?<=\s)–|–(?=\s)/;

interface DashViolation {
  file: string;
  key: string;
  value: string;
}

/** Recursively collect `{ key, value }` for every string leaf of a parsed JSON resource, including array elements. */
function collectStringLeaves(value: unknown, prefix = ""): Array<{ key: string; value: string }> {
  if (typeof value === "string") {
    return [{ key: prefix, value }];
  }

  if (Array.isArray(value)) {
    return value.flatMap((child, index) => collectStringLeaves(child, `${prefix}[${index}]`));
  }

  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      collectStringLeaves(child, prefix ? `${prefix}.${key}` : key),
    );
  }

  return [];
}

/** Every string leaf of `data` that contains an em dash or a spaced en dash. */
function findDashViolations(file: string, data: unknown): DashViolation[] {
  return collectStringLeaves(data)
    .filter(({ value }) => DISALLOWED_DASH.test(value))
    .map(({ key, value }) => ({ file, key, value }));
}

interface ResourceFile {
  /** Absolute path, used to read the file. */
  path: string;
  /** Path relative to `resources/`, used as the readable test label and violation file name. */
  label: string;
}

/** Every `resources/<language>/*.json` file shipped for a supported language. */
function resourceFiles(): ResourceFile[] {
  return supportedLanguages.flatMap((language) => {
    const dir = fileURLToPath(new URL(`../resources/${language}/`, import.meta.url));

    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({ path: `${dir}${name}`, label: `${language}/${name}` }));
  });
}

describe("no em dash or spaced en dash in translated resources", () => {
  it("fails on an em dash used as a pause", () => {
    const violations = findDashViolations("fixture.json", {
      section: { greeting: "Welcome — please sign in." },
    });

    expect(violations).toStrictEqual([
      { file: "fixture.json", key: "section.greeting", value: "Welcome — please sign in." },
    ]);
  });

  it("fails on a spaced en dash used as a pause", () => {
    const violations = findDashViolations("fixture.json", {
      section: { greeting: "Welcome – please sign in." },
    });

    expect(violations).toStrictEqual([
      { file: "fixture.json", key: "section.greeting", value: "Welcome – please sign in." },
    ]);
  });

  it("allows an unspaced en dash used as a range", () => {
    const violations = findDashViolations("fixture.json", {
      placeholderRange: "{from}–{to}",
      numericRange: "30–90",
    });

    expect(violations).toStrictEqual([]);
  });

  for (const { path, label } of resourceFiles()) {
    it(`has no em dash or spaced en dash in ${label}`, () => {
      const data = JSON.parse(readFileSync(path, "utf-8")) as unknown;

      expect(findDashViolations(label, data)).toStrictEqual([]);
    });
  }
});
