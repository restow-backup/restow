import importsDe from "@restow/i18n/resources/de/imports.json" with { type: "json" };
import commonEn from "@restow/i18n/resources/en/common.json" with { type: "json" };
import importsEn from "@restow/i18n/resources/en/imports.json" with { type: "json" };
import { describe, expect, it } from "vitest";

/**
 * Guards for the `imports` namespace: German and English carry the same keys
 * with the same ICU arguments, the texts hold no em dash, and every key the
 * feature's code names exists.
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

const en = importsEn as Tree;
const de = importsDe as Tree;
const namespaces: Record<string, Tree> = { imports: en, common: commonEn as Tree };

const sourceFiles = import.meta.glob(
  ["./**/*.ts", "./**/*.tsx", "!./**/*.test.ts", "!./**/*.test.tsx", "!./testing/**"],
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

describe("imports translations", () => {
  it("have identical keys in German and English", () => {
    expect([...leaves(de).keys()].sort()).toEqual([...leaves(en).keys()].sort());
  });

  it("use the same ICU arguments in both languages", () => {
    const german = leaves(de);
    for (const [key, text] of leaves(en)) {
      expect(icuArguments(german.get(key) ?? ""), key).toEqual(icuArguments(text));
    }
  });

  it("have no empty messages and no em dash or spaced en dash", () => {
    for (const [key, text] of [...leaves(en), ...leaves(de)]) {
      expect(text.trim().length, key).toBeGreaterThan(0);
      expect(text, key).not.toMatch(/—|(?<=\s)–|–(?=\s)/);
    }
  });

  it("contain every literal key the feature uses", () => {
    const literal = [
      // t("...") in the imports namespace, tAny("...") / tc("...") in common.
      ...collect(/\bt\(\s*"([^"]+)"/g, "imports"),
      ...collect(/\b(?:tAny|tc|tCommon)\(\s*"([^"]+)"/g, "common"),
      // Keys named in ternaries and lookup tables.
      ...collect(/\?\s*"((?:job|items|archive|files|upload)\.[\w.]+)"\s*:\s*"[\w.]+"/g, "imports"),
      ...collect(/:\s*"((?:job|items|archive|files|upload)\.[\w.]+)"[,)]/g, "imports"),
      ...collect(/"(upload\.errors\.\w+)"/g, "imports"),
      ...collect(/"(errors\.\w+)",?$/gm, "imports"),
      ...collect(/return\s+"((?:status|phase|items|notes)\.[\w.]+)"/g, "imports"),
      ...collect(/["'`]imports:([\w.]+)["'`]/g, "imports"),
    ];
    expect(literal.length).toBeGreaterThan(150);
    for (const [file, namespace, key] of literal) {
      const tree = namespaces[namespace];
      expect(tree, `${file}: unknown namespace ${namespace}`).toBeDefined();
      expect(typeof lookup(tree as Tree, key), `${file}: ${namespace}:${key}`).toBe("string");
    }
  });

  it("contain the groups that dynamic keys are built from", () => {
    const dynamic = [
      ...collect(/\bt\(\s*`([\w.]+)\.\$\{/g, "imports"),
      ...collect(/\bt\(\s*`([\w.]+)\.\$\{[^}]+\}\.(?:title|description)`/g, "imports"),
    ];
    expect(dynamic.length).toBeGreaterThan(8);
    for (const [file, namespace, prefix] of dynamic) {
      const node = lookup(namespaces[namespace] as Tree, prefix);
      expect(typeof node, `${file}: ${namespace}:${prefix}.*`).toBe("object");
    }
  });

  it("have a message for every code the presenters can produce", async () => {
    const { ITEM_CODES, KNOWN_NOTES } = await import("./presenters");
    for (const code of ITEM_CODES) {
      expect(typeof lookup(en, `items.codes.${code}`), code).toBe("string");
    }
    for (const note of KNOWN_NOTES) {
      expect(typeof lookup(en, `notes.${note}`), note).toBe("string");
    }
    for (const phase of ["starting", "prepare", "import", "manifest", "archive", "other"]) {
      expect(typeof lookup(en, `phase.${phase}`), phase).toBe("string");
    }
    for (const status of [
      "queued",
      "active",
      "completed",
      "completedWithIssues",
      "failed",
      "cancelled",
      "unknown",
    ]) {
      expect(typeof lookup(en, `status.${status}`), status).toBe("string");
    }
    for (const step of ["source", "files", "target", "review"]) {
      expect(typeof lookup(en, `steps.${step}`), step).toBe("string");
      expect(typeof lookup(en, `blockers.${step === "target" ? "name" : "origin"}`), step).toBe(
        "string",
      );
    }
  });
});
