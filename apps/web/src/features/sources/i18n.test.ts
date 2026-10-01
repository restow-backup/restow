import sourcesDe from "@restow/i18n/resources/de/sources.json" with { type: "json" };
import commonEn from "@restow/i18n/resources/en/common.json" with { type: "json" };
import sourcesEn from "@restow/i18n/resources/en/sources.json" with { type: "json" };
import { describe, expect, it } from "vitest";

/**
 * Guards for the `sources` namespace: German and English carry the same keys
 * with the same ICU arguments, and every key the feature's code names exists.
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

const en = sourcesEn as Tree;
const de = sourcesDe as Tree;
const namespaces: Record<string, Tree> = { sources: en, common: commonEn as Tree };

const sourceFiles = import.meta.glob(["./**/*.ts", "./**/*.tsx", "!./**/*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Split `ns:key` into namespace and key, defaulting to the given namespace. */
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

describe("sources translations", () => {
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
      // t("...") in the sources namespace, tc("...") in common.
      ...collect(/\bt\(\s*"([^"]+)"/g, "sources"),
      ...collect(/\btc\(\s*"([^"]+)"/g, "common"),
      // Keys handed around as data (presenters, nav items, problem map).
      ...collect(/\b(?:key|labelKey):\s*"([^"]+)"/g, "sources"),
      ...collect(/"(sources:[\w.]+)"/g, "sources"),
    ];
    expect(literal.length).toBeGreaterThan(50);
    for (const [file, namespace, key] of literal) {
      const tree = namespaces[namespace];
      expect(tree, `${file}: unknown namespace ${namespace}`).toBeDefined();
      expect(typeof lookup(tree as Tree, key), `${file}: ${namespace}:${key}`).toBe("string");
    }
  });

  it("contain the groups that dynamic keys are built from", () => {
    const dynamic = [
      ...collect(/\bt\(\s*`([\w.]+)\.\$\{/g, "sources"),
      ...collect(/\bkey:\s*`([\w.]+)\.\$\{/g, "sources"),
    ];
    expect(dynamic.length).toBeGreaterThan(5);
    for (const [file, namespace, prefix] of dynamic) {
      const node = lookup(namespaces[namespace] as Tree, prefix);
      expect(typeof node, `${file}: ${namespace}:${prefix}.*`).toBe("object");
    }
  });
});
