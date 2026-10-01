import { describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import { LICENSE_NAMESPACE } from "./i18n";
import de from "./i18n/de.json" with { type: "json" };
import en from "./i18n/en.json" with { type: "json" };

/**
 * The `license` namespace lives with this module, outside the core's
 * @restow/i18n bundles, so it carries the same guards here: German and
 * English with identical keys and ICU arguments, every message formatting
 * cleanly, no em dash used as a pause, and the product only ever named as
 * `{appName}`.
 */

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ""): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      result.set(path, value);
    } else {
      for (const [leaf, text] of leaves(value, path)) {
        result.set(leaf, text);
      }
    }
  }
  return result;
}

function icuArguments(message: string): string[] {
  return [
    ...new Set([...message.matchAll(/\{(\w+)\s*[,}]/g)].map((match) => match[1] ?? "")),
  ].sort();
}

const languages = { de: leaves(de as Tree), en: leaves(en as Tree) };

describe("license namespace", () => {
  it("has the same keys in German and English", () => {
    expect([...languages.de.keys()].sort()).toEqual([...languages.en.keys()].sort());
    expect(languages.en.size).toBeGreaterThan(0);
  });

  it("uses the same ICU arguments in both languages", () => {
    for (const [key, text] of languages.en) {
      expect(icuArguments(languages.de.get(key) ?? ""), key).toEqual(icuArguments(text));
    }
  });

  for (const [language, texts] of Object.entries(languages)) {
    it(`formats every ${language} message without leftovers`, () => {
      const t = i18n.getFixedT(language, LICENSE_NAMESPACE);
      const values = { edition: "business", keyInstallation: "a-1", installation: "b-2" };
      for (const key of texts.keys()) {
        const text = t(key, values);
        expect(text, key).not.toBe(key);
        expect(text, key).not.toMatch(/[{}]/);
      }
    });

    it(`has no em dash or spaced en dash in ${language}`, () => {
      for (const [key, text] of texts) {
        expect(/—|(?<=\s)–|–(?=\s)/.test(text), key).toBe(false);
      }
    });

    it(`names the product only as {appName} in ${language}`, () => {
      for (const [key, text] of texts) {
        // Technical identifiers (RESTOW_*, restow-license-v1) are not the product name.
        expect(/(?<![\w-])Restow(?![\w-])/.test(text), key).toBe(false);
      }
    });
  }

  it("explains no license rights", () => {
    for (const text of [...languages.en.values(), ...languages.de.values()]) {
      expect(text).not.toMatch(
        /AGPL|Affero|Module Exception|fair|source-available|open source|free of charge|kostenlos|never limited|nie limitiert|uneingeschränkt/i,
      );
    }
  });
});
