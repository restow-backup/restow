import { readdirSync, readFileSync } from "node:fs";

import integrationsDe from "@restow/i18n/resources/de/integrations.json" with { type: "json" };
import settingsDe from "@restow/i18n/resources/de/settings.json" with { type: "json" };
import tenantpageDe from "@restow/i18n/resources/de/tenantpage.json" with { type: "json" };
import integrationsEn from "@restow/i18n/resources/en/integrations.json" with { type: "json" };
import settingsEn from "@restow/i18n/resources/en/settings.json" with { type: "json" };
import tenantpageEn from "@restow/i18n/resources/en/tenantpage.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { PREVIEW_KINDS } from "./api";

/**
 * Guards for the words of Installation › Branding, Installation › Notifications and the tenant's
 * Branding (0.5.0): every key the code names exists in German and English, and so does every key
 * built from a code (the server's refusals, the preview tabs, the cadences, the delivery modes).
 */

type Tree = { [key: string]: string | Tree };

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

const TREES: Record<string, { en: Tree; de: Tree }> = {
  settings: { en: settingsEn as Tree, de: settingsDe as Tree },
  integrations: { en: integrationsEn as Tree, de: integrationsDe as Tree },
  tenantpage: { en: tenantpageEn as Tree, de: tenantpageDe as Tree },
};

const FOLDERS = ["./", "../provider-notifications/"];

function sources(): [string, string][] {
  return FOLDERS.flatMap((folder) => {
    const root = new URL(folder, import.meta.url);
    return readdirSync(root, { encoding: "utf8" })
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
      .map(
        (name) =>
          [`${folder}${name}`, readFileSync(new URL(name, root), "utf8")] as [string, string],
      );
  });
}

function expectKey(namespace: string, key: string, where: string) {
  const tree = TREES[namespace];
  if (!tree) throw new Error(`unknown namespace ${namespace}`);
  expect(typeof lookup(tree.en, key), `${where}: en ${namespace}:${key}`).toBe("string");
  expect(typeof lookup(tree.de, key), `${where}: de ${namespace}:${key}`).toBe("string");
}

describe("branding and provider notification translations", () => {
  it("contain every key the code names", () => {
    let named = 0;
    for (const [file, text] of sources()) {
      // `t` is the file's namespace (settings, or tenantpage for the tenant's own branding).
      const namespace = /useTranslation\("tenantpage"\)/.test(text) ? "tenantpage" : "settings";
      for (const match of text.matchAll(/\bt\(\s*"([\w.-]+)"/g)) {
        expectKey(namespace, match[1] ?? "", file);
        named += 1;
      }
      for (const match of text.matchAll(/\bti\(\s*"([\w.-]+)"/g)) {
        expectKey("integrations", match[1] ?? "", file);
        named += 1;
      }
      if (namespace !== "settings") continue;
      // Keys handed around as values (validation results, refusals).
      for (const match of text.matchAll(
        /"((?:branding|providerRecipients|summaryReports)\.[\w.-]+)"/g,
      )) {
        const key = match[1] ?? "";
        // The gated features `branding.provider` and `branding.tenant` are no keys.
        if (!key.endsWith(".") && !/^branding\.(provider|tenant)$/.test(key)) {
          expectKey("settings", key, file);
          named += 1;
        }
      }
    }
    expect(named).toBeGreaterThan(80);
  });

  it("cover the keys built from codes", () => {
    for (const code of [
      "svg-not-supported",
      "unsupported-type",
      "unsupported-image",
      "too-large",
      "dimensions",
      "corrupt",
      "animated",
      "accent-contrast",
      "accent-invalid",
      "sender-not-allowed",
      "from-locked",
      "invalid-email",
      "too-long",
      "invalid",
    ]) {
      expectKey("settings", `branding.errors.${code}`, "branding errors");
    }
    for (const kind of PREVIEW_KINDS) {
      expectKey("settings", `branding.preview.tabs.${kind}`, "preview tabs");
    }
    for (const cadence of ["daily", "weekly", "monthly"]) {
      expectKey("settings", `summaryReports.cadences.${cadence}`, "cadences");
      expectKey("integrations", `matrix.reports.${cadence}`, "report rows");
    }
    for (const code of ["owner-required", "duplicate", "invalid-email", "unknown-event"]) {
      expectKey("settings", `providerRecipients.errors.${code}`, "recipient errors");
    }
    for (const mode of ["immediate", "hourly", "daily"]) {
      expectKey("integrations", `matrix.delivery.${mode}`, "delivery modes");
    }
    expectKey("settings", "mail.test.reasons.recipient_rejected", "mail reasons");
  });
});
