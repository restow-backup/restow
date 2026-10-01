import { readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { namespaces, resources, supportedLanguages } from "./index.js";

/** Namespace names of the JSON files shipped for `language` under resources/. */
function resourceFiles(language: string): string[] {
  return readdirSync(new URL(`../resources/${language}/`, import.meta.url))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

/**
 * Collect the leaf key paths of a nested resource object, e.g.
 * `{ login: { passkey: "…" } }` -> `["login.passkey"]`.
 */
function flattenKeys(value: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];

  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      keys.push(...flattenKeys(child as Record<string, unknown>, path));
    } else {
      keys.push(path);
    }
  }

  return keys.sort();
}

describe("i18n resources", () => {
  it("ships exactly the supported languages", () => {
    expect([...supportedLanguages]).toStrictEqual(["de", "en"]);
    expect(Object.keys(resources).sort()).toStrictEqual([...supportedLanguages].sort());
  });

  // A resource file that is not listed as a namespace would escape the parity
  // check below and only reach the apps through ad-hoc registration.
  for (const language of supportedLanguages) {
    it(`registers every resource file of "${language}" as a namespace`, () => {
      expect(resourceFiles(language)).toStrictEqual([...namespaces].sort());
      expect(Object.keys(resources[language]).sort()).toStrictEqual([...namespaces].sort());
    });
  }

  for (const ns of namespaces) {
    it(`has identical key sets for namespace "${ns}" in de and en`, () => {
      const deKeys = flattenKeys(resources.de[ns] as Record<string, unknown>);
      const enKeys = flattenKeys(resources.en[ns] as Record<string, unknown>);

      // Deep comparison: a key present on only one side fails the test.
      expect(deKeys).toStrictEqual(enKeys);
      expect(deKeys.length).toBeGreaterThan(0);
    });
  }
});
