import de from "@restow/i18n/resources/de/pricing.json" with { type: "json" };
import en from "@restow/i18n/resources/en/pricing.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";

/**
 * Guards for the `pricing` namespace: German and English take the same arguments, every message
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

describe("pricing translations", () => {
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
      price: "€2.50",
      quantity: "340",
      stored: "1,240",
      unit: "GB",
      name: "Acme",
      currency: "EUR",
      field: "Price per mailbox",
    };
    for (const language of ["en", "de"]) {
      await i18n.changeLanguage(language);
      for (const key of english.keys()) {
        const text = i18n.t(`pricing:${key}`, values);
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
