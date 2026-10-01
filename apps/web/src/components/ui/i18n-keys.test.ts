import { readFileSync, readdirSync } from "node:fs";

import { defaultNamespace, resources, supportedLanguages } from "@restow/i18n";
import { describe, expect, it } from "vitest";

/**
 * The primitives translate their screen-reader labels (close, previous page,
 * breadcrumb, notifications, ...) through the default namespace. A key that is
 * missing from the bundles renders as the raw key, so every key a primitive
 * passes to `t()` must exist in every language.
 */

const folder = new URL("./", import.meta.url);

/**
 * Keys the primitives already use that the translation bundles may not carry
 * yet. Adding them to common.json is a separate change to @restow/i18n, which
 * can land before or after this list is trimmed: an entry whose key is
 * translated in every language is simply inert, so the suite stays green in
 * either order. Delete an entry once its key has landed; the check below only
 * rejects entries no primitive uses any more and keys translated in some
 * languages but not in others. Empty while every key a primitive uses is
 * translated.
 */
const PENDING_TRANSLATION: ReadonlySet<string> = new Set<string>();

function usedKeys(): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  const sources = readdirSync(folder).filter(
    (name) => name.endsWith(".tsx") && !name.includes(".test."),
  );
  for (const name of sources) {
    const source = readFileSync(new URL(name, folder), "utf8");
    for (const [, key] of source.matchAll(/\bt\(\s*["'`]([\w.-]+)["'`]/g)) {
      if (key) {
        keys.set(key, [...(keys.get(key) ?? []), name]);
      }
    }
  }
  return keys;
}

function lookup(tree: unknown, key: string): unknown {
  let node = tree;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") {
      return undefined;
    }
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

type Language = (typeof supportedLanguages)[number];
type IsTranslated = (language: Language, key: string) => boolean;

function translatedIn(language: Language, key: string): boolean {
  const value = lookup(resources[language][defaultNamespace], key);
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Every used key that lacks a translation, as `language: namespace:key (files)`.
 * A pending key may still be missing in every language; a key translated in
 * some languages but not in others is a gap even when it is pending.
 */
function missingTranslations(
  used: ReadonlyMap<string, string[]>,
  pending: ReadonlySet<string>,
  isTranslated: IsTranslated,
): string[] {
  const missing: string[] = [];
  for (const [key, files] of used) {
    const languages = supportedLanguages.filter((language) => !isTranslated(language, key));
    if (pending.has(key) && languages.length === supportedLanguages.length) {
      continue;
    }
    for (const language of languages) {
      missing.push(`${language}: ${defaultNamespace}:${key} (${files.join(", ")})`);
    }
  }
  return missing;
}

describe("translation keys of the primitives", () => {
  const keys = usedKeys();

  it("finds the keys the primitives use", () => {
    expect(keys.has("actions.close")).toBe(true);
  });

  it("resolves every key in every language", () => {
    expect(missingTranslations(keys, PENDING_TRANSLATION, translatedIn)).toEqual([]);
  });

  it("lists only keys a primitive still uses", () => {
    const unused = [...PENDING_TRANSLATION].filter((key) => !keys.has(key));
    expect(unused).toEqual([]);
  });

  it("stays green once the pending keys land, whether or not the list is trimmed", () => {
    const landed: IsTranslated = (language, key) =>
      PENDING_TRANSLATION.has(key) || translatedIn(language, key);
    expect(missingTranslations(keys, PENDING_TRANSLATION, landed)).toEqual([]);
    expect(missingTranslations(keys, new Set(), landed)).toEqual([]);
  });

  it("reports a pending key that only some languages translate", () => {
    // A synthetic key keeps this independent of what the real list holds.
    const pendingKey = "example.pendingLabel";
    const used = new Map([[pendingKey, ["example.tsx"]]]);
    const [first, ...rest] = supportedLanguages;

    const nowhere: IsTranslated = () => false;
    expect(missingTranslations(used, new Set([pendingKey]), nowhere)).toEqual([]);

    const onlyFirst: IsTranslated = (language) => language === first;
    expect(missingTranslations(used, new Set([pendingKey]), onlyFirst)).toEqual(
      rest.map((language) => `${language}: ${defaultNamespace}:${pendingKey} (example.tsx)`),
    );
  });
});
