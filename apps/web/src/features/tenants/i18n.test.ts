import tenantsDe from "@restow/i18n/resources/de/tenants.json" with { type: "json" };
import accountsEn from "@restow/i18n/resources/en/accounts.json" with { type: "json" };
import commonEn from "@restow/i18n/resources/en/common.json" with { type: "json" };
import tenantsEn from "@restow/i18n/resources/en/tenants.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { TENANT_ROLES } from "./components/role-select";
import { NOTIFICATION_CATEGORIES, WIZARD_STEPS } from "./forms";

/**
 * Guards for the `tenants` namespace: German and English carry the same keys
 * with the same ICU arguments, every message is well-formed, and every key
 * the feature's code names exists.
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
 * (opened at even depth) and branch bodies (odd depth), so `{Nutzer}` in
 * `{role, select, other {Nutzer}}` is text, not an argument.
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
    // The branch set runs to the matching closing brace of this argument.
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

const en = tenantsEn as Tree;
const de = tenantsDe as Tree;
// invite-member-dialog.tsx (owned by this feature) also calls into the
// accounts namespace (the accounts feature provisions the sign-in), so the
// literal-key scan below needs that namespace too, or every one of its keys
// would fail as "unknown namespace" before ever being looked up.
const namespaces: Record<string, Tree> = {
  tenants: en,
  common: commonEn as Tree,
  accounts: accountsEn as Tree,
};

const sourceFiles = import.meta.glob(
  ["./**/*.ts", "./**/*.tsx", "!./**/*.test.ts", "!./**/*.test.tsx"],
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
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

describe("tenants translations", () => {
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

  it("contain every literal key the feature uses", () => {
    const literal = [
      ...collect(/\bt\(\s*"([^"]+)"/g, "tenants"),
      ...collect(/\b(?:key|labelKey):\s*"([^"]+)"/g, "tenants"),
      ...collect(/"(tenants:[\w.]+)"/g, "tenants"),
    ];
    expect(literal.length).toBeGreaterThan(100);
    for (const [file, namespace, key] of literal) {
      const tree = namespaces[namespace];
      expect(tree, `${file}: unknown namespace ${namespace}`).toBeDefined();
      expect(typeof lookup(tree as Tree, key), `${file}: ${namespace}:${key}`).toBe("string");
    }
  });

  it("contain every member of the groups dynamic keys are built from", () => {
    const groups: Record<string, readonly string[]> = {
      "members.roles": TENANT_ROLES,
      "members.roleHints": TENANT_ROLES,
      readiness: ["green", "yellow", "red", "none"],
      status: ["active", "suspended", "deleting"],
      validation: [
        "nameTooLong",
        "slugTooShort",
        "slugTooLong",
        "slugFormat",
        "slugTaken",
        "capInteger",
        "tooLong",
        "countryCodeFormat",
        "timeZoneFormat",
        "onePrimaryContact",
        "atLeastOneContact",
        "duplicateEmail",
        "customerNumberTaken",
      ],
      "invitation.blocked": ["wrongRecipient", "invalid", "emailUnverified"],
      "wizard.steps": WIZARD_STEPS,
      "wizard.notifications.categories": NOTIFICATION_CATEGORIES,
    };
    for (const [group, members] of Object.entries(groups)) {
      for (const member of members) {
        expect(lookup(en, `${group}.${member}`), `${group}.${member}`).toBeDefined();
      }
    }
    const dynamic = [
      ...collect(/\bt\(\s*`([\w.]+)\.\$\{/g, "tenants"),
      ...collect(/`(tenants:[\w.]+)\.\$\{/g, "tenants"),
    ];
    expect(dynamic.length).toBeGreaterThan(4);
    for (const [file, namespace, prefix] of dynamic) {
      const node = lookup(namespaces[namespace] as Tree, prefix);
      expect(typeof node, `${file}: ${namespace}:${prefix}.*`).toBe("object");
    }
  });
});
