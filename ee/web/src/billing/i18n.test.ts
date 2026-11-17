import { describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import { BILLING_NAMESPACE } from "./i18n";
import de from "./i18n/de.json" with { type: "json" };
import en from "./i18n/en.json" with { type: "json" };

/**
 * The `billing` namespace lives with this module, outside the core's @restow/i18n bundles, so it
 * carries the same guards: German and English with identical keys and ICU arguments, every
 * message formatting cleanly, no em dash used as a pause, the product only ever as `{appName}`,
 * and the formal address in German.
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

describe("billing namespace", () => {
  it("has the same keys and ICU arguments in German and English", () => {
    expect([...languages.de.keys()].sort()).toEqual([...languages.en.keys()].sort());
    for (const [key, text] of languages.en) {
      expect(icuArguments(languages.de.get(key) ?? ""), key).toEqual(icuArguments(text));
    }
  });

  for (const [language, texts] of Object.entries(languages)) {
    it(`formats every ${language} message without leftovers`, () => {
      const t = i18n.getFixedT(language, BILLING_NAMESPACE);
      const values = {
        date: "1.12.2026",
        month: "November 2026",
        zone: "Europe/Berlin",
        sampled: 29,
        days: 30,
        name: "Contoso",
        count: 3,
        unit: "TB",
        who: "owner@example.com",
        currency: "EUR",
      };
      for (const key of texts.keys()) {
        const text = t(key, values);
        expect(text, key).not.toBe(key);
        expect(text, key).not.toMatch(/[{}]/);
      }
    });

    it(`has no em dash or spaced en dash and no product name in ${language}`, () => {
      for (const [key, text] of texts) {
        expect(/—|(?<=\s)–|–(?=\s)/.test(text), key).toBe(false);
        expect(/(?<![\w-])Restow(?![\w-])/.test(text), key).toBe(false);
      }
    });
  }

  it("addresses the reader formally in German", () => {
    for (const [key, text] of languages.de) {
      expect(/\b(du|dein|deine|dich|dir)\b/i.test(text), key).toBe(false);
    }
  });
});
