import { readFileSync, readdirSync } from "node:fs";

import { resources } from "@restow/i18n";
import uiDe from "@restow/i18n/resources/de/ui.json" with { type: "json" };
import uiEn from "@restow/i18n/resources/en/ui.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { DELTA_SENTENCE_KEYS } from "./kpi-tile.js";

/**
 * The kit's strings live in the `ui` namespace (plus a few shared ones from
 * `common`). A missing key renders as the raw key, so every key the kit
 * passes to `t()` must exist in both languages.
 */

const UI = { de: uiDe, en: uiEn } as const;
type Language = keyof typeof UI;

function flatten(tree: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(tree)
    .flatMap(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return value !== null && typeof value === "object"
        ? flatten(value as Record<string, unknown>, path)
        : [path];
    })
    .sort();
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

/**
 * Every literal `t("…")` key in the kit and its two wrapped components, as
 * `namespace:key`. Kit modules translate in `ui`; the page header and the
 * error state use the default namespace, `common`.
 */
function usedKeys(): Set<string> {
  const kit = new URL("./", import.meta.url);
  const files: [URL, string][] = readdirSync(kit, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.tsx?$/.test(name) && !name.includes(".test."))
    .map((name) => [new URL(name, kit), "ui"]);
  files.push([new URL("../page-header.tsx", kit), "common"]);
  files.push([new URL("../error-state.tsx", kit), "common"]);

  const keys = new Set<string>();
  for (const [file, namespace] of files) {
    const source = readFileSync(file, "utf8");
    for (const [, key] of source.matchAll(/\bt\(\s*["'`]([\w.:-]+)["'`]/g)) {
      if (key) {
        keys.add(key.includes(":") ? key : `${namespace}:${key}`);
      }
    }
  }
  return keys;
}

function translated(language: Language, key: string): boolean {
  const [namespace, path] = key.split(":");
  const tree =
    namespace === "ui"
      ? UI[language]
      : resources[language][namespace as keyof (typeof resources)[Language]];
  const value = lookup(tree, path ?? "");
  return typeof value === "string" && value.trim().length > 0;
}

describe("ui translations", () => {
  it("have identical keys in de and en", () => {
    expect(flatten(uiDe)).toEqual(flatten(uiEn));
  });

  it("finds the keys the kit uses", () => {
    const keys = usedKeys();
    expect(keys.has("ui:table.empty.title")).toBe(true);
    expect(keys.has("common:actions.cancel")).toBe(true);
    expect(keys.has("common:app.name")).toBe(true);
  });

  it("resolve every key the kit uses in every language", () => {
    const keys = [...usedKeys(), ...DELTA_SENTENCE_KEYS.map((key) => `ui:${key}`)];
    const missing = (["de", "en"] as const).flatMap((language) =>
      keys.filter((key) => !translated(language, key)).map((key) => `${language}: ${key}`),
    );
    expect(missing).toEqual([]);
  });
});
