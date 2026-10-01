import { readFileSync, readdirSync } from "node:fs";

import { resources } from "@restow/i18n";
import statsDe from "@restow/i18n/resources/de/stats.json" with { type: "json" };
import uiDe from "@restow/i18n/resources/de/ui.json" with { type: "json" };
import statsEn from "@restow/i18n/resources/en/stats.json" with { type: "json" };
import uiEn from "@restow/i18n/resources/en/ui.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { KPI_NAMES, UNAVAILABLE_REASONS } from "./api.js";
import { GRANULARITIES, PERIOD_PRESETS } from "./period.js";
import { KNOWN_OBJECT_STATES, KPI_SPECS } from "./presenters.js";

/**
 * The page's strings live in the `stats` namespace (plus the kit's `ui`).
 * A missing key renders as the raw key, so every key the feature uses must
 * exist in both languages, and both languages must carry the same keys.
 */

const BUNDLES = {
  de: { stats: statsDe, ui: uiDe },
  en: { stats: statsEn, ui: uiEn },
} as const;
type Language = keyof typeof BUNDLES;

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

/** Every literal `t("…")` key in the feature's sources, as `namespace:key`. */
function literalKeys(): Set<string> {
  const root = new URL("./", import.meta.url);
  const keys = new Set<string>();
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
    (name) => /\.tsx?$/.test(name) && !name.includes(".test."),
  );
  for (const name of files) {
    const source = readFileSync(new URL(name, root), "utf8");
    for (const [, key] of source.matchAll(/\bt\(\s*["'`]([\w.:-]+)["'`]/g)) {
      if (key) {
        keys.add(key.includes(":") ? key : `stats:${key}`);
      }
    }
  }
  return keys;
}

/** Keys built at runtime from known codes. */
function dynamicKeys(): string[] {
  return [
    ...PERIOD_PRESETS.map((preset) => `stats:period.presets.${preset}`),
    ...GRANULARITIES.map((granularity) => `stats:period.granularity.${granularity}`),
    ...KPI_SPECS.flatMap((spec) => [`stats:kpi.${spec.name}.label`, `stats:kpi.${spec.name}.hint`]),
    "stats:unavailable.reasons.missing",
    ...UNAVAILABLE_REASONS.map((reason) => `stats:unavailable.reasons.${reason}`),
    ...KNOWN_OBJECT_STATES.map((state) => `stats:objectStates.${state}`),
  ];
}

function translated(language: Language, key: string): boolean {
  const [namespace, path] = key.split(":");
  const bundles = BUNDLES[language] as Record<string, unknown>;
  const tree =
    namespace && namespace in bundles
      ? bundles[namespace]
      : resources[language][namespace as keyof (typeof resources)[Language]];
  const value = lookup(tree, path ?? "");
  return typeof value === "string" && value.trim().length > 0;
}

describe("stats translations", () => {
  it("have identical keys in de and en", () => {
    expect(flatten(statsDe)).toEqual(flatten(statsEn));
  });

  it("find the keys the feature uses", () => {
    const keys = literalKeys();
    expect(keys.has("stats:title")).toBe(true);
    expect(keys.has("stats:charts.backups.title")).toBe(true);
    expect(keys.has("stats:tables.tenants.columns.readiness")).toBe(true);
  });

  it("resolve every key the feature uses in every language", () => {
    const keys = [...literalKeys(), ...dynamicKeys()];
    const missing = (["de", "en"] as const).flatMap((language) =>
      keys.filter((key) => !translated(language, key)).map((key) => `${language}: ${key}`),
    );
    expect(missing).toEqual([]);
  });

  it("label every key figure", () => {
    for (const name of KPI_NAMES.filter((name) => name !== "dedupRatio")) {
      expect(typeof lookup(statsEn, `kpi.${name}.label`)).toBe("string");
    }
  });
});
