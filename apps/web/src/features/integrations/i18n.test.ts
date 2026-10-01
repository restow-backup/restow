import integrationsDe from "@restow/i18n/resources/de/integrations.json" with { type: "json" };
import commonEn from "@restow/i18n/resources/en/common.json" with { type: "json" };
import integrationsEn from "@restow/i18n/resources/en/integrations.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { EXPIRY_OPTIONS, SCOPE_GROUPS, eventKey, scopeKey } from "./presenters";
import { API_SCOPES, WEBHOOK_EVENTS, WEBHOOK_TEST_EVENT } from "./types";

/**
 * Guards for the `integrations` namespace: German and English carry the same
 * keys with the same ICU arguments, every key the feature's code names
 * exists, and every scope, event and error code has its texts.
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

const en = integrationsEn as Tree;
const de = integrationsDe as Tree;
const namespaces: Record<string, Tree> = { integrations: en, common: commonEn as Tree };

const sourceFiles = import.meta.glob(["./**/*.ts", "./**/*.tsx", "!./**/*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

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

describe("integrations translations", () => {
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
      ...collect(/\bt\(\s*"([^"]+)"/g, "integrations"),
      ...collect(/\btc\(\s*"([^"]+)"/g, "common"),
      ...collect(/\b(?:key|labelKey):\s*"([^"]+)"/g, "integrations"),
      ...collect(/"(integrations:[\w.]+)"/g, "integrations"),
      // Keys picked by a condition: t(cond ? "a" : "b").
      ...collect(/\?\s*"([a-z][\w]*\.[\w.]+)"\s*:\s*"[^"]+"/g, "integrations"),
      ...collect(/\?\s*"[^"]+"\s*:\s*"([a-z][\w]*\.[\w.]+)"/g, "integrations"),
    ];
    expect(literal.length).toBeGreaterThan(100);
    for (const [file, namespace, key] of literal) {
      const tree = namespaces[namespace];
      expect(tree, `${file}: unknown namespace ${namespace}`).toBeDefined();
      expect(typeof lookup(tree as Tree, key), `${file}: ${namespace}:${key}`).toBe("string");
    }
  });

  it("contain the groups that dynamic keys are built from", () => {
    const dynamic = collect(/\bt\(\s*`([\w.]+)\.\$\{/g, "integrations");
    expect(dynamic.length).toBeGreaterThan(5);
    for (const [file, namespace, prefix] of dynamic) {
      const node = lookup(namespaces[namespace] as Tree, prefix);
      expect(typeof node, `${file}: ${namespace}:${prefix}.*`).toBe("object");
    }
  });

  it("describe every scope, event, expiry option and delivery error", () => {
    for (const tree of [en, de]) {
      for (const scope of API_SCOPES) {
        expect(typeof lookup(tree, `scopes.${scopeKey(scope)}.label`), scope).toBe("string");
        expect(typeof lookup(tree, `scopes.${scopeKey(scope)}.description`), scope).toBe("string");
      }
      for (const group of SCOPE_GROUPS) {
        expect(typeof lookup(tree, `scopes.groups.${group.id}`)).toBe("string");
      }
      for (const event of [...WEBHOOK_EVENTS, WEBHOOK_TEST_EVENT, "some.future_event"]) {
        expect(typeof lookup(tree, `events.${eventKey(event)}.label`), event).toBe("string");
        expect(typeof lookup(tree, `events.${eventKey(event)}.description`), event).toBe("string");
      }
      for (const option of EXPIRY_OPTIONS) {
        expect(typeof lookup(tree, `createKey.expiryOptions.${option}`)).toBe("string");
      }
      for (const code of [
        "http_error",
        "redirect",
        "timeout",
        "connection_failed",
        "dns_failed",
        "tls_failed",
        "blocked_address",
        "invalid_url",
        "secret_missing",
        "webhook_disabled",
        "internal",
        "unknown",
      ]) {
        expect(typeof lookup(tree, `deliveries.errors.${code}`), code).toBe("string");
      }
    }
  });
});
