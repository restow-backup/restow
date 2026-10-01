import { FAILURE_CATALOG, FAILURE_CODES, FAILURE_STEP_IDS } from "@restow/core";
import { createI18n, failureVariables, resources, supportedLanguages } from "@restow/i18n";
import { describe, expect, it } from "vitest";

/**
 * Every failure code and every step needs a text in both languages, and the
 * texts must compile: a message whose variables are not supplied would show
 * its ICU source instead of prose. This test fails the moment a code is added
 * to packages/core/src/failures without its translations.
 */

/** The values a `reason` parameter can take anywhere in the classifier. */
const REASONS = [
  "secret_expired",
  "invalid_secret",
  "invalid_certificate",
  "credential_missing",
  "invalid_client",
  "not_in_exchange_online",
  "not_enabled",
  "token_expired",
  "client_invalid",
  "secret_invalid",
  "expired",
  "self_signed",
  "hostname_mismatch",
  "untrusted",
  "protocol",
  "source_missing",
  "source_corrupt",
  "verify_failed",
  "master_key",
  "tenant_key",
  "too_many_connections",
  "disk_full",
  "shutdown",
  "conflict",
  "connection",
  "aborted",
  "not_a_directory",
] as const;

const FULL = {
  permission: "Mail.ReadWrite",
  grantedInstead: "Mail.Read",
  host: "imap.example.test",
  port: 993,
  path: "/data/tenants",
  role: "imap",
  side: "copy",
  graphCode: "ErrorAccessDenied",
  aadsts: "AADSTS65001",
  imapCode: "AUTHENTICATIONFAILED",
  systemCode: "ECONNREFUSED",
  httpStatus: 403,
  retryAfterSeconds: 32,
  count: 3,
  ageHours: 60,
};

interface Bundle {
  cause: Record<
    string,
    Record<string, { title: string; why: string }> | { title: string; why: string }
  >;
  steps: Record<string, string>;
}

function bundle(language: "de" | "en"): Bundle {
  return resources[language].failures as unknown as Bundle;
}

/**
 * One i18next instance per language for the whole file. Setting one up for
 * every text (several thousand here) took most of the run time and brought
 * the formatting test close to vitest's 5 s timeout on a busy CI runner. A
 * shared instance still formats every text with every variant; it compiles
 * each message once instead of once per variant.
 */
const instances = new Map<"de" | "en", ReturnType<typeof createI18n>>();

function textOf(language: "de" | "en", key: string, params: Record<string, unknown>): string {
  let i18n = instances.get(language);
  if (!i18n) {
    i18n = createI18n({ lng: language });
    instances.set(language, i18n);
  }
  return i18n.t(`failures:${key}`, failureVariables(params as never));
}

/** `graph.consent_missing` -> the nested text entry of the bundle. */
function causeEntry(language: "de" | "en", code: string) {
  const parts = code.split(".");
  let node: unknown = bundle(language).cause;
  for (const part of parts) {
    node = (node as Record<string, unknown> | undefined)?.[part];
  }
  return node as { title?: string; why?: string } | undefined;
}

describe.each(supportedLanguages)("failure texts (%s)", (language) => {
  it("has a headline and an explanation for every cause code", () => {
    for (const code of FAILURE_CODES) {
      const entry = causeEntry(language, code);
      expect(entry?.title, `${language} ${code} title`).toBeTruthy();
      expect(entry?.why, `${language} ${code} why`).toBeTruthy();
    }
  });

  it("has a text for every step", () => {
    for (const id of FAILURE_STEP_IDS) {
      expect(bundle(language).steps[id], `${language} step ${id}`).toBeTruthy();
    }
  });

  it("has no text for a code or step that does not exist", () => {
    const codes = new Set<string>(FAILURE_CODES);
    const leaves: string[] = [];
    const walk = (node: unknown, path: string[]) => {
      const record = node as Record<string, unknown>;
      if (typeof record.title === "string" && typeof record.why === "string") {
        leaves.push(path.join("."));
        return;
      }
      for (const [key, child] of Object.entries(record)) {
        walk(child, [...path, key]);
      }
    };
    walk(bundle(language).cause, []);
    expect(leaves.filter((code) => !codes.has(code))).toEqual([]);
    const steps = new Set<string>(FAILURE_STEP_IDS);
    expect(Object.keys(bundle(language).steps).filter((id) => !steps.has(id))).toEqual([]);
  });

  it("formats every cause text with no parameters, with all of them and with every reason", () => {
    const variants: Record<string, unknown>[] = [
      {},
      FULL,
      ...REASONS.map((reason) => ({ ...FULL, reason })),
      ...REASONS.map((reason) => ({ reason })),
    ];
    // Ten thousand texts per language: collected and asserted once, because three
    // `expect` calls per text cost more than the formatting itself.
    const problems: string[] = [];
    for (const code of FAILURE_CODES) {
      for (const variant of variants) {
        for (const part of ["title", "why"] as const) {
          const key = `cause.${code}.${part}`;
          const text = textOf(language, key, variant);
          if (text.length === 0) {
            problems.push(`${language} ${key} ${JSON.stringify(variant)}: empty`);
          } else if (/[{}]/.test(text)) {
            problems.push(`${language} ${key} ${JSON.stringify(variant)}: did not format: ${text}`);
          } else if (text === `failures:${key}`) {
            problems.push(`${language} ${key} ${JSON.stringify(variant)}: no text`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("formats every step text with and without parameters", () => {
    for (const id of FAILURE_STEP_IDS) {
      for (const variant of [
        {},
        FULL,
        { host: "imap.example.test" },
        { permission: "Mail.ReadWrite" },
      ]) {
        const text = textOf(language, `steps.${id}`, variant);
        expect(text, `${language} step ${id}`).not.toMatch(/[{}]/);
        expect(text.length).toBeGreaterThan(0);
      }
    }
  });

  it("names the permission and the wait when the failure has them", () => {
    expect(
      textOf(language, "cause.graph.permission_missing.why", { permission: "Mail.ReadWrite" }),
    ).toContain("Mail.ReadWrite");
    expect(textOf(language, "cause.graph.throttled.why", { retryAfterSeconds: 32 })).toContain(
      "32",
    );
    expect(
      textOf(language, "steps.check_host_reachable", { host: "imap.example.test", port: 993 }),
    ).toContain("imap.example.test:993");
  });
});

describe("catalog and texts agree", () => {
  it("has a catalog entry for every code that has a text", () => {
    for (const code of FAILURE_CODES) {
      expect(FAILURE_CATALOG[code], code).toBeDefined();
    }
  });
});
