import settingsDe from "@restow/i18n/resources/de/settings.json" with { type: "json" };
import commonEn from "@restow/i18n/resources/en/common.json" with { type: "json" };
import settingsEn from "@restow/i18n/resources/en/settings.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import type { MailTestFailureReason, ReachabilityStatus } from "./api";
import type {
  AppTestFailureReason,
  MicrosoftAppSource,
  PermissionState,
  UnusableReason,
} from "./microsoft-app/api";

/**
 * Guards for the `settings` namespace: German and English carry the same keys
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

/** ICU argument names (`{name}`, `{count, plural, ...}`). */
function icuArguments(message: string): string[] {
  return [
    ...new Set([...message.matchAll(/\{(\w+)\s*[,}]/g)].map((match) => match[1] ?? "")),
  ].sort();
}

const en = settingsEn as Tree;
const de = settingsDe as Tree;
const namespaces: Record<string, Tree> = { settings: en, common: commonEn as Tree };

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

const TOP_LEVEL_GROUPS =
  "general|mail|microsoftApp|security|readiness|toasts|form|validation|errors|account";

/** Every key the Microsoft 365 app registration builds from API values. */
function microsoftAppKeys(): string[] {
  const reasons: AppTestFailureReason[] = [
    "invalid_secret",
    "secret_expired",
    "app_not_found",
    "tenant_not_found",
    "credential_missing",
    "invalid_certificate",
    "consent_missing",
    "permissions_missing",
    "network",
    "other",
  ];
  const sources: MicrosoftAppSource[] = ["environment", "database", "none"];
  const problems: UnusableReason[] = [
    "certificate_unreadable",
    "certificate_invalid",
    "document_unreadable",
    "authority_host_invalid",
  ];
  const states: PermissionState[] = ["granted", "read_only", "missing"];
  const fieldReasons = [
    "guid",
    "tenantId",
    "secretIsId",
    "credentialRequired",
    "credentialConflict",
    "certificateMissing",
    "privateKeyMissing",
    "privateKeyEncrypted",
    "certificateInvalid",
    "privateKeyInvalid",
    "unsupportedKeyType",
    "keyMismatch",
    "certificateExpired",
    "certificateNotYetValid",
    "date",
    "authorityHost",
    "tooLong",
  ];
  return [
    ...reasons.map((reason) => `microsoftApp.test.reasons.${reason}`),
    ...sources.map((source) => `microsoftApp.status.source.${source}`),
    ...problems.map((problem) => `microsoftApp.status.problems.${problem}`),
    ...["ready", "none", "unusable"].map((key) => `microsoftApp.status.badge.${key}`),
    ...["secret", "certificate"].flatMap((kind) => [
      `microsoftApp.status.kinds.${kind}`,
      `microsoftApp.form.kinds.${kind}`,
    ]),
    ...states.map((state) => `microsoftApp.test.states.${state}`),
    ...["application", "delegated"].map((type) => `microsoftApp.steps.permissions.types.${type}`),
    ...fieldReasons.map((reason) => `microsoftApp.validation.${reason}`),
  ];
}

describe("settings translations", () => {
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
      ...collect(/\bt\(\s*"([^"]+)"/g, "settings"),
      ...collect(/\btc\(\s*"([^"]+)"/g, "common"),
      ...collect(/labelKey:\s*"([^"]+)"/g, "settings"),
      ...collect(/"((?:settings|common):[\w.]+)"/g, "settings"),
      // Keys handed around as data, e.g. `emptyKey={... "security.passkeys.empty" ...}`
      // (common keys inside `tc(...)` are collected above).
      ...collect(
        new RegExp(`(?<!\\btc\\(\\s*)"((?:${TOP_LEVEL_GROUPS})\\.[\\w.]+)"`, "g"),
        "settings",
      ),
    ];
    expect(literal.length).toBeGreaterThan(100);
    for (const [file, namespace, key] of literal) {
      const tree = namespaces[namespace];
      expect(tree, `${file}: unknown namespace ${namespace}`).toBeDefined();
      expect(typeof lookup(tree as Tree, key), `${file}: ${namespace}:${key}`).toBe("string");
    }
  });

  it("contain the groups that dynamic keys are built from", () => {
    const dynamic = collect(/\bt\(\s*`([\w.]+)\.\$\{/g, "settings");
    expect(dynamic.length).toBeGreaterThan(3);
    for (const [file, namespace, prefix] of dynamic) {
      const node = lookup(namespaces[namespace] as Tree, prefix);
      expect(typeof node, `${file}: ${namespace}:${prefix}.*`).toBe("object");
    }
  });

  it("cover every value the dynamic keys are built from", () => {
    const probeStatuses: ReachabilityStatus[] = [
      "ok",
      "skipped",
      "unreachable",
      "timeout",
      "certificate_invalid",
      "unexpected_response",
    ];
    const failureReasons: MailTestFailureReason[] = [
      "timeout",
      "graph_app_missing",
      "graph_tenant_missing",
      "transport_error",
    ];
    const expected = [
      ...probeStatuses.flatMap((status) => [
        `readiness.probe.badge.${status}`,
        `readiness.probe.status.${status}`,
      ]),
      ...failureReasons.map((reason) => `mail.test.reasons.${reason}`),
      ...["mode_not_public", "no_public_url", "not_https", "origin_mismatch"].map(
        (reason) => `readiness.reasons.${reason}`,
      ),
      ...["starttls", "tls", "none"].map((option) => `mail.smtp.securityOptions.${option}`),
      ...microsoftAppKeys(),
    ];
    for (const key of expected) {
      expect(typeof lookup(en, key), key).toBe("string");
    }
  });
});
