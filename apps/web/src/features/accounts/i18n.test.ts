import accountsDe from "@restow/i18n/resources/de/accounts.json" with { type: "json" };
import accountsEn from "@restow/i18n/resources/en/accounts.json" with { type: "json" };
import commonEn from "@restow/i18n/resources/en/common.json" with { type: "json" };
import { describe, expect, it } from "vitest";

/**
 * Guards for the `accounts` namespace: German and English carry the same
 * keys with the same ICU arguments, every message is well-formed, and every
 * key the feature's code (here and the two tenants components it plugs
 * into) names exists.
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

/**
 * ICU argument names (`{name}`, `{count, plural, ...}`), including those
 * nested in plural or select branches. Braces alternate between arguments
 * (opened at even depth) and branch bodies (odd depth), so a single-word
 * branch body like `{user}` in `{role, select, other {user}}` is text, not
 * an argument — a plain "does `{word}` look like an argument" regex would
 * wrongly capture it, and then disagree between languages whose branch text
 * happens to be one word in one language and two in the other.
 */
function icuArguments(message: string): string[] {
  const names = new Set<string>();
  let depth = 0;
  for (let index = 0; index < message.length; index += 1) {
    const char = message[index];
    if (char === "{") {
      if (depth % 2 === 0) {
        const name = /^\s*(\w+)/.exec(message.slice(index + 1))?.[1];
        if (name) {
          names.add(name);
        }
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    }
  }
  return [...names].sort();
}

/** Why a message is not well-formed ICU, or null: unbalanced braces, a branch set without `other`. */
function icuProblem(message: string): string | null {
  let depth = 0;
  for (const char of message) {
    depth += char === "{" ? 1 : char === "}" ? -1 : 0;
    if (depth < 0) {
      return "closing brace without opening brace";
    }
  }
  if (depth !== 0) {
    return "unbalanced braces";
  }
  for (const match of message.matchAll(/\{\s*\w+\s*,\s*(plural|select)\s*,/g)) {
    let level = 0;
    let end = match.index ?? 0;
    for (; end < message.length; end += 1) {
      level += message[end] === "{" ? 1 : message[end] === "}" ? -1 : 0;
      if (level === 0) {
        break;
      }
    }
    if (!/\bother\s*\{/.test(message.slice(match.index, end))) {
      return `${match[1]} without an "other" branch`;
    }
  }
  return null;
}

const en = accountsEn as Tree;
const de = accountsDe as Tree;
const namespaces: Record<string, Tree> = { accounts: en, common: commonEn as Tree };

// This feature's own files (every bare t("...") here defaults to "accounts").
const ownFiles = import.meta.glob(["./**/*.ts", "./**/*.tsx", "!./**/*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Plus the two tenants components it plugs new copy into (owned by this item
// too), scanned only for explicitly namespaced keys: their bare t("...")
// calls default to "tenants", which is that feature's own guard to keep.
const pluggedInFiles = import.meta.glob(
  ["../tenants/components/invite-member-dialog.tsx", "../tenants/components/members-panel.tsx"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

function qualify(key: string, fallback: string): [string, string] {
  const colon = key.indexOf(":");
  return colon > 0 ? [key.slice(0, colon), key.slice(colon + 1)] : [fallback, key];
}

function collect(
  pattern: RegExp,
  fallback: string,
  files: Record<string, string> = ownFiles,
): [string, string, string][] {
  const found: [string, string, string][] = [];
  for (const [file, text] of Object.entries(files)) {
    for (const match of text.matchAll(pattern)) {
      const [namespace, key] = qualify(match[1] ?? "", fallback);
      // This namespace's own guard only vouches for "accounts" and "common".
      if (namespace === "accounts" || namespace === "common") {
        found.push([file, namespace, key]);
      }
    }
  }
  return found;
}

describe("accounts translations", () => {
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

  it("are well-formed ICU messages", () => {
    for (const [key, text] of [...leaves(en), ...leaves(de)]) {
      expect(icuProblem(text), key).toBeNull();
    }
  });

  it("contain every literal key the feature (and the tenants components it plugs into) uses", () => {
    const literal = [
      ...collect(/\bt\(\s*"([^"]+)"/g, "accounts"),
      ...collect(/\btc\(\s*"([^"]+)"/g, "common"),
      ...collect(/"(accounts:[\w.]+)"/g, "accounts"),
      ...collect(/"(common:[\w.]+)"/g, "common"),
      ...collect(/"(accounts:[\w.]+)"/g, "accounts", pluggedInFiles),
      ...collect(/"(common:[\w.]+)"/g, "common", pluggedInFiles),
    ];
    expect(literal.length).toBeGreaterThan(20);
    for (const [file, namespace, key] of literal) {
      const tree = namespaces[namespace];
      expect(tree, `${file}: unknown namespace ${namespace}`).toBeDefined();
      expect(typeof lookup(tree as Tree, key), `${file}: ${namespace}:${key}`).toBe("string");
    }
  });

  it("contain every member of the groups dynamic keys are built from", () => {
    const groups: Record<string, readonly string[]> = {
      "pending.linkStatus": ["valid", "expired", "used", "invalid"],
      "setPassword.linkStatus": ["used", "expired", "invalid"],
      "setPassword.linkError": ["used", "expired", "invalid"],
    };
    for (const [group, members] of Object.entries(groups)) {
      for (const member of members) {
        expect(lookup(en, `${group}.${member}`), `${group}.${member}`).toBeDefined();
      }
    }
  });
});
