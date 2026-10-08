import { readFileSync, readdirSync } from "node:fs";

import tenantpageDe from "@restow/i18n/resources/de/tenantpage.json" with { type: "json" };
import tenantpageEn from "@restow/i18n/resources/en/tenantpage.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";

/**
 * Guards for the `tenantpage` namespace: German and English carry the same
 * keys with the same ICU arguments, every key the tenant page and its sections
 * name exists, the texts an installation with one organisation can see never
 * say "tenant" or "Mandant" (clarity rule 4), and nothing shouts in capitals.
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
 * The arguments of an ICU message: `{name}` and `{name, select|plural, ...}`,
 * also inside the options of a select or plural, but not the words of the
 * options themselves.
 */
function icuArguments(message: string): string[] {
  const found = new Set<string>();
  const scan = (text: string) => {
    let index = 0;
    while (index < text.length) {
      if (text[index] !== "{") {
        index += 1;
        continue;
      }
      let depth = 1;
      let end = index + 1;
      while (end < text.length && depth > 0) {
        depth += text[end] === "{" ? 1 : text[end] === "}" ? -1 : 0;
        end += 1;
      }
      const body = text.slice(index + 1, end - 1);
      const head = /^\s*(\w+)\s*(,|$)/.exec(body);
      if (head) {
        found.add(head[1] ?? "");
        if (head[2] === ",") {
          // The options of a select or plural: `key {text}`; scan the text of each.
          const options = body.slice(body.indexOf(",", body.indexOf(",") + 1) + 1);
          let at = 0;
          while (at < options.length) {
            const open = options.indexOf("{", at);
            if (open < 0) {
              break;
            }
            let level = 1;
            let close = open + 1;
            while (close < options.length && level > 0) {
              level += options[close] === "{" ? 1 : options[close] === "}" ? -1 : 0;
              close += 1;
            }
            scan(options.slice(open + 1, close - 1));
            at = close;
          }
        }
      }
      index = end;
    }
  };
  scan(message);
  return [...found].sort();
}

const en = tenantpageEn as Tree;
const de = tenantpageDe as Tree;

const ROOT = new URL("./", import.meta.url);

function sources(): [string, string][] {
  return readdirSync(ROOT, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => [name, readFileSync(new URL(name, ROOT), "utf8")] as [string, string]);
}

const VALUES = {
  scope: "organisation",
  tenant: "Contoso",
  name: "Contoso",
  section: "Agents",
  date: "2 October 2026",
  count: 2,
  servers: 3,
  clients: 2,
  connected: 1,
  total: 2,
  years: 8,
  kind: "s3",
  step: "Write",
};

/**
 * The texts only a provider admin of an installation that manages tenants can
 * see: the lifecycle of a tenant, and marking it as the own organisation.
 */
const TENANT_MANAGEMENT = [
  /^overview\.(actions|suspend|resume|suspended|deleting|toasts|danger)/,
  /^masterData\.own\./,
];

describe("tenant page translations", () => {
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

  it("contain every key the code names with the namespace or asks for unprefixed", () => {
    const named: [string, string][] = [];
    for (const [file, text] of sources()) {
      for (const match of text.matchAll(/"tenantpage:([\w.]+)"/g)) {
        named.push([file, match[1] ?? ""]);
      }
      if (/useTranslation\("tenantpage"\)/.test(text)) {
        for (const match of text.matchAll(/\bt\(\s*"([\w.]+)"/g)) {
          named.push([file, match[1] ?? ""]);
        }
      }
    }
    expect(named.length).toBeGreaterThan(60);
    for (const [file, key] of named) {
      expect(typeof lookup(en, key), `${file}: ${key}`).toBe("string");
      expect(typeof lookup(de, key), `${file}: ${key}`).toBe("string");
    }
  });

  it("cover the values the dynamic keys are built from", () => {
    const expected = [
      ...["notYours", "unknown", "notAdmin", "closed"].map((kind) => `states.${kind}.title`),
      ...["notYours", "unknown", "notAdmin", "closed"].map((kind) => `states.${kind}.description`),
      ...["role", "demo"].map((reason) => `access.${reason}`),
      ...["end_of_year", "from_capture"].map((mode) => `archive.retention.${mode}`),
    ];
    for (const key of expected) {
      expect(typeof lookup(en, key), key).toBe("string");
      expect(typeof lookup(de, key), key).toBe("string");
    }
  });

  it("name a section for every section the page offers", () => {
    for (const id of [
      "overview",
      "connections",
      "protection",
      "jobs",
      "retention",
      "storage",
      "agents",
      "archive",
      "notifications",
      "integrations",
      "members",
      "masterData",
    ]) {
      expect(typeof lookup(en, `sections.${id}`), id).toBe("string");
      expect(typeof lookup(en, `descriptions.${id}`), id).toBe("string");
    }
  });

  it("formats every message without leftovers of the ICU syntax", async () => {
    for (const language of ["en", "de"]) {
      await i18n.changeLanguage(language);
      for (const scope of ["organisation", "tenants"]) {
        for (const key of leaves(language === "en" ? en : de).keys()) {
          const text = i18n.t(`tenantpage:${key}`, { ...VALUES, scope });
          expect(text, `${language} ${scope} ${key}`).not.toMatch(/\{\w+\s*[,}]/);
          expect(text, `${language} ${scope} ${key}`).not.toBe(key);
        }
      }
    }
    await i18n.changeLanguage("en");
  });

  it("never say tenant or Mandant where an installation has one organisation", async () => {
    for (const [language, word] of [
      ["en", /\btenants?\b/i],
      ["de", /Mandant/i],
    ] as const) {
      await i18n.changeLanguage(language);
      for (const key of leaves(language === "en" ? en : de).keys()) {
        if (TENANT_MANAGEMENT.some((pattern) => pattern.test(key))) {
          continue;
        }
        const text = i18n.t(`tenantpage:${key}`, {
          ...VALUES,
          scope: "organisation",
          tenant: "Contoso",
        });
        // The name of the tenant itself is data, not wording.
        expect(text.replace(/Contoso/g, ""), `${language} ${key}`).not.toMatch(word);
      }
    }
    await i18n.changeLanguage("en");
  });

  it("speak of the tenant where the installation manages tenants", async () => {
    await i18n.changeLanguage("en");
    expect(i18n.t("tenantpage:title", { scope: "tenants" })).toBe("Tenant settings");
    expect(i18n.t("tenantpage:title", { scope: "organisation" })).toBe("Your organisation");
    await i18n.changeLanguage("de");
    expect(i18n.t("tenantpage:title", { scope: "tenants" })).toBe("Mandanten-Einstellungen");
    expect(i18n.t("tenantpage:title", { scope: "organisation" })).toBe("Ihre Organisation");
    await i18n.changeLanguage("en");
  });

  it("set no label in capitals: no uppercase style in the tenant page", () => {
    const own = sources();
    expect(own.length).toBeGreaterThan(8);
    for (const [file, text] of own) {
      expect(text, file).not.toMatch(/["'` ]uppercase["'` ]/);
    }
  });
});
