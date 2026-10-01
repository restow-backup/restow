import schedulesDe from "@restow/i18n/resources/de/schedules.json" with { type: "json" };
import commonEn from "@restow/i18n/resources/en/common.json" with { type: "json" };
import schedulesEn from "@restow/i18n/resources/en/schedules.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { JOB_STATUS_TONE, KIND_ICON } from "./presenters.js";
import { PRESET_TYPES } from "./presets.js";

/**
 * Guards for the `schedules` namespace: German and English carry the same keys
 * with the same ICU arguments, every key the feature's code names exists, and
 * every family of keys built at runtime is complete.
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

function lookup(tree: Tree, path: string): string | Tree | undefined {
  let node: string | Tree | undefined = tree;
  for (const segment of path.split(".")) {
    if (node === undefined || typeof node === "string") {
      return undefined;
    }
    node = node[segment];
  }
  return node;
}

/** ICU argument names (`{name}`, `{count, plural, ...}`); plural `#` is not an argument. */
function icuArguments(message: string): string[] {
  return [
    ...new Set([...message.matchAll(/\{(\w+)\s*[,}]/g)].map((match) => match[1] ?? "")),
  ].sort();
}

const en = schedulesEn as Tree;
const de = schedulesDe as Tree;
const namespaces: Record<string, Tree> = { schedules: en, common: commonEn as Tree };

const sourceFiles = import.meta.glob(
  ["./**/*.ts", "./**/*.tsx", "!./**/*.test.ts", "!./**/*.test.tsx"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

function qualify(key: string, fallback: string): [string, string] {
  const colon = key.indexOf(":");
  return colon > 0 ? [key.slice(0, colon), key.slice(colon + 1)] : [fallback, key];
}

function collect(pattern: RegExp, fallback: string): [string, string, string][] {
  const found: [string, string, string][] = [];
  for (const [file, text] of Object.entries(sourceFiles)) {
    for (const match of text.matchAll(pattern)) {
      const [namespace, key] = qualify(match[1] ?? "", fallback);
      found.push([file, namespace, key]);
    }
  }
  return found;
}

describe("schedules translations", () => {
  it("have identical keys in German and English", () => {
    expect([...leaves(de).keys()].sort()).toEqual([...leaves(en).keys()].sort());
  });

  it("use the same ICU arguments in both languages", () => {
    const german = leaves(de);
    for (const [key, text] of leaves(en)) {
      expect(icuArguments(german.get(key) ?? ""), key).toEqual(icuArguments(text));
    }
  });

  it("have no empty messages", () => {
    for (const [key, text] of [...leaves(en), ...leaves(de)]) {
      expect(text.trim().length, key).toBeGreaterThan(0);
    }
  });

  it("contain every literal key the feature uses", () => {
    const literal = [
      ...collect(/\bt\(\s*"([^"]+)"/g, "schedules"),
      ...collect(/\blabelKey:\s*"([^"]+)"/g, "schedules"),
    ];
    expect(literal.length).toBeGreaterThan(60);
    for (const [file, namespace, key] of literal) {
      const tree = namespaces[namespace];
      expect(tree, `${file}: unknown namespace ${namespace}`).toBeDefined();
      expect(typeof lookup(tree as Tree, key), `${file}: ${namespace}:${key}`).toBe("string");
    }
  });

  it("contain the groups that dynamic keys are built from", () => {
    const dynamic = collect(/\bt\(\s*`([\w.]+)\.\$\{/g, "schedules");
    expect(dynamic.length).toBeGreaterThan(5);
    for (const [file, namespace, prefix] of dynamic) {
      const node = lookup(namespaces[namespace] as Tree, prefix);
      expect(typeof node, `${file}: ${namespace}:${prefix}.*`).toBe("object");
    }
  });

  it("name every kind, job status, preset, form check and API problem", () => {
    const required = [
      ...Object.keys(KIND_ICON).map((kind) => `kinds.${kind}`),
      ...["backup", "verify", "scrub", "directory", "retention"].map((kind) => `kindHints.${kind}`),
      ...Object.keys(JOB_STATUS_TONE).map((status) => `jobStatus.${status}`),
      ...PRESET_TYPES.map((type) => `presets.${type}`),
      ...["mailbox", "onedrive", "imap"].map((kind) => `objectKinds.${kind}`),
      ...["minutes", "hours", "time", "days", "dayOfMonth", "cron", "object"].map(
        (field) => `validation.required.${field}`,
      ),
      ...["minutes", "hours", "dayOfMonth"].map((field) => `validation.range.${field}`),
      ...[
        "cadence_missing",
        "cadence_ambiguous",
        "interval_not_integer",
        "interval_out_of_range",
        "cron_invalid",
        "cron_never_matches",
        "cron_too_frequent",
        "timezone_unknown",
        "scope_not_supported",
        "object_not_found",
        "generic",
      ].map((code) => `problems.${code}`),
      ...["created", "updated", "deleted", "enabled", "disabled"].map(
        (change) => `toasts.${change}`,
      ),
      ...["backup", "verify"].flatMap((kind) => [
        `confirm.disable.${kind}.title`,
        `confirm.disable.${kind}.description`,
      ]),
    ];
    for (const key of required) {
      expect(typeof lookup(en, key), key).toBe("string");
    }
  });
});
