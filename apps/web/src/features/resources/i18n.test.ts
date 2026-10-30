import de from "@restow/i18n/resources/de/resources.json" with { type: "json" };
import en from "@restow/i18n/resources/en/resources.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";

/**
 * Guards for the `resources` namespace: German and English take the same arguments, every message
 * formats without leftovers of the ICU syntax, and the German texts address the reader formally.
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

/** The names of the arguments of an ICU message, `{name}` and `{name, plural, ...}`. */
function args(message: string): string[] {
  return [
    ...new Set([...message.matchAll(/\{(\w+)\s*[,}]/g)].map((match) => match[1] ?? "")),
  ].sort();
}

describe("resources translations", () => {
  const english = leaves(en as Tree);
  const german = leaves(de as Tree);

  it("take the same arguments in both languages", () => {
    expect([...german.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, text] of english) {
      expect(args(german.get(key) ?? ""), key).toEqual(args(text));
    }
  });

  it("format without leftovers of the ICU syntax", async () => {
    const values = {
      amount: "€36.80",
      count: 2,
      total: 5,
      shown: 1,
      bytes: "1.4 GB",
      free: "1 TB",
      budget: "500 GB",
      percent: 92,
      date: "23 September 2026",
      earliest: "23 September 2026",
      latest: "1 March 2027",
      span: "120 days",
      days: 30,
      name: "Acme",
      column: "Stored",
      time: "23 Sep 2026, 10:00",
      slowest: "1 GB",
      fastest: "3 GB",
    };
    for (const language of ["en", "de"]) {
      await i18n.changeLanguage(language);
      for (const key of english.keys()) {
        const text = i18n.t(`resources:${key}`, values);
        expect(text, `${language} ${key}`).not.toMatch(/\{\w+\s*[,}]/);
        expect(text, `${language} ${key}`).not.toBe(key);
      }
    }
    await i18n.changeLanguage("en");
  });

  it("address the reader formally in German", () => {
    for (const [key, text] of german) {
      expect(text, key).not.toMatch(/\b(du|dein\w*|dir|dich)\b/i);
    }
  });
});
