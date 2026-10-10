import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import installationDe from "@restow/i18n/resources/de/installation.json" with { type: "json" };
import archiveEn from "@restow/i18n/resources/en/archive.json" with { type: "json" };
import installationEn from "@restow/i18n/resources/en/installation.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";

/**
 * Guards for the `installation` namespace: German and English carry the same
 * keys with the same ICU arguments, every key the installation page, its
 * sections and the extensions' sections name exists, the wording scope
 * switches between "all tenants" and "your organisation", and nothing in it
 * shouts in capitals.
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

/** ICU argument names (`{name}`, `{count, plural, ...}`). */
function icuArguments(message: string): string[] {
  return [
    ...new Set([...message.matchAll(/\{(\w+)\s*[,}]/g)].map((match) => match[1] ?? "")),
  ].sort();
}

const en = installationEn as Tree;
const de = installationDe as Tree;

const WEB = new URL("../../", import.meta.url);
const EE = new URL("../../../../../ee/web/src/", import.meta.url);

function sources(directory: URL): [string, string][] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => [name, readFileSync(new URL(name, directory), "utf8")] as [string, string]);
}

/**
 * Files that use the namespace unprefixed, with the name their `t` has: the
 * installation feature and the extensions' sections ask for
 * `useTranslation("installation")` as `t`; the settings sections and the
 * integrations page, which mostly speak their own namespace, name it `ti`.
 */
const unprefixed: [string, string, RegExp][] = [
  ...sources(new URL("features/installation/", WEB)),
  ...sources(EE),
]
  .filter(([, text]) => /useTranslation\("installation"\)/.test(text))
  .map(([file, text]) => [file, text, /\bt\(\s*"([\w.]+)"/g] as [string, string, RegExp])
  .concat(
    [
      ...sources(new URL("features/settings/", WEB)),
      ...sources(new URL("features/integrations/", WEB)),
    ]
      .filter(([, text]) => /\bt: ti\b[^\n]*useTranslation\("installation"\)/.test(text))
      .map(([file, text]) => [file, text, /\bti\(\s*"([\w.]+)"/g] as [string, string, RegExp]),
  );

const everything = [...sources(WEB), ...sources(EE)];

describe("installation translations", () => {
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

  it("contain every key the code names with the namespace", () => {
    const named: [string, string][] = [];
    for (const [file, text] of everything) {
      for (const match of text.matchAll(/"installation:([\w.]+)"/g)) {
        named.push([file, match[1] ?? ""]);
      }
    }
    expect(named.length).toBeGreaterThan(10);
    for (const [file, key] of named) {
      expect(typeof lookup(en, key), `${file}: installation:${key}`).toBe("string");
    }
  });

  it("contain every key the files of the namespace use unprefixed", () => {
    const used: [string, string][] = [];
    for (const [file, text, pattern] of unprefixed) {
      for (const match of text.matchAll(pattern)) {
        used.push([file, match[1] ?? ""]);
      }
    }
    expect(used.length).toBeGreaterThan(30);
    for (const [file, key] of used) {
      expect(typeof lookup(en, key), `${file}: ${key}`).toBe("string");
    }
  });

  it("cover the values the dynamic keys are built from", () => {
    const expected = [
      ...["owner", "administrator", "demo"].map((key) => `access.${key}`),
      ...["local", "s3"].map((kind) => `defaultStorage.kind.${kind}`),
      ...["listening", "down", "notConfigured"].map((state) => `journal.state.${state}`),
    ];
    for (const key of expected) {
      expect(typeof lookup(en, key), key).toBe("string");
      expect(typeof lookup(de, key), key).toBe("string");
    }
  });

  it("reuses the archive namespace's journal texts only where they exist", () => {
    const reasons = [
      "restart_required",
      "listen_failed",
      "tls_not_configured",
      "tls_invalid",
      "tls_expired",
      "not_started",
    ];
    for (const reason of reasons) {
      expect(typeof lookup(archiveEn as Tree, `journal.reason.${reason}`), reason).toBe("string");
    }
    for (const key of ["journal.notConfigured", "journal.address.hostMissing"]) {
      expect(typeof lookup(archiveEn as Tree, key), key).toBe("string");
    }
  });

  it("speaks of all tenants on a server with tenant management and of the organisation without", async () => {
    await i18n.changeLanguage("en");
    expect(i18n.t("installation:descriptions.server", { scope: "tenants" })).toContain(
      "all tenants",
    );
    expect(i18n.t("installation:descriptions.server", { scope: "organisation" })).toContain(
      "your organisation",
    );
    expect(i18n.t("installation:descriptions.server", { scope: "organisation" })).not.toContain(
      "tenant",
    );
    expect(i18n.t("installation:microsoftApp.optional", { scope: "tenants" })).toContain(
      "tenants are connected by a consent link instead of their own app",
    );
    expect(i18n.t("installation:microsoftApp.optional", { scope: "organisation" })).toContain(
      "your organisation is connected by a consent link instead of its own app",
    );
    await i18n.changeLanguage("de");
    expect(i18n.t("installation:descriptions.server", { scope: "tenants" })).toContain(
      "alle Mandanten",
    );
    expect(i18n.t("installation:descriptions.server", { scope: "organisation" })).toContain(
      "Ihre Organisation",
    );
    expect(i18n.t("installation:descriptions.server", { scope: "organisation" })).not.toContain(
      "Mandant",
    );
    expect(i18n.t("installation:microsoftApp.optional", { scope: "organisation" })).toContain(
      "Ihre Organisation per Consent-Link statt über eine eigene App verbunden wird",
    );
    await i18n.changeLanguage("en");
  });

  it("formats every message without leftovers of the ICU syntax", async () => {
    const values = {
      scope: "tenants",
      section: "Journal receiving",
      date: "2 October 2026",
      version: "2026-10-01",
      current: "2026-10-01",
      using: 2,
      total: 5,
      size: 150,
      when: "2 hours ago",
      who: "admin@example.test",
      step: "Write",
      name: "nas",
      path: "/mnt/restow/nas",
      detail: "mount.nfs: access denied by server",
      server: "nas.local",
      export: "/volume1/restow",
    };
    for (const language of ["en", "de"]) {
      await i18n.changeLanguage(language);
      for (const key of leaves(language === "en" ? en : de).keys()) {
        const text = i18n.t(`installation:${key}`, values);
        expect(text, `${language} ${key}`).not.toMatch(/\{\w+\s*[,}]/);
        expect(text, `${language} ${key}`).not.toBe(key);
      }
    }
    await i18n.changeLanguage("en");
  });

  it("sets no label in capitals: no uppercase style in the installation page or the extensions' sections", () => {
    const own = [
      ...sources(new URL("features/installation/", WEB)),
      ...sources(EE).filter(([file]) => /^(journal|provider-api|license)\//.test(file)),
    ];
    expect(own.length).toBeGreaterThan(5);
    for (const [file, text] of own) {
      expect(text, file).not.toMatch(/["'` ]uppercase["'` ]/);
    }
  });
});
