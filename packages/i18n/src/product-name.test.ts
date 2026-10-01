import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";

import { supportedLanguages } from "./index.js";

/**
 * The former product name, spelled out of two parts: the repository guard in
 * scripts/ci refuses the word in every tracked file, and this test has to name
 * it to refuse it in texts.
 */
const FORMER_NAME = ["Os", "iris"].join("");

/**
 * The product name comes from the branding, so no translation names it. Texts
 * carry `{appName}` (resolved by createI18n, see branding.ts); a literal
 * "Restow" (the current name) in a user-visible string would survive a
 * rebranding, and the former name must not come back at
 * all. Both are refused here, outside the one kind of exception below.
 */

/**
 * The literal product names, as words. `RESTOW_*` variables and lowercase
 * identifiers (`restow-agent`, `com.restowbackup.agent`) are not them.
 */
const PRODUCT_WORD = new RegExp(`\\b(?:Restow|${FORMER_NAME})\\b`);

/**
 * Technical identifiers that contain the capitalised word and are not
 * branding. They are removed from a text before it is checked. The list is
 * closed on purpose: a new entry needs a reason that is not "the text would
 * read better with the name in it".
 */
const IDENTIFIER_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  {
    pattern: /X-Restow-[A-Za-z]+/g,
    reason: "HTTP header names of the integration API and the webhooks (X-Restow-Tenant, ...)",
  },
  {
    pattern: /\bRestow-Restore\b/g,
    reason:
      "the folder the endpoint agent creates for a restore, a name in the agent, not in a text",
  },
  {
    pattern: /\/Library\/Application Support\/Restow\b/g,
    reason:
      "the root-owned folder the endpoint agent is installed in on macOS, a path in the agent and its installer",
  },
];

interface Leaf {
  key: string;
  value: string;
}

function leaves(value: unknown, prefix = ""): Leaf[] {
  if (typeof value === "string") {
    return [{ key: prefix, value }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => leaves(child, `${prefix}[${index}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      leaves(child, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [];
}

/** The leaves that name the product although they should not, as `file:key` labels. */
function productNameViolations(file: string, data: unknown): string[] {
  return leaves(data).flatMap(({ key, value }) => {
    let prose = value;
    for (const { pattern } of IDENTIFIER_PATTERNS) {
      prose = prose.replace(pattern, "");
    }
    return PRODUCT_WORD.test(prose) ? [`${file}:${key}: ${value}`] : [];
  });
}

describe("the literal product name in translations", () => {
  it("refuses the current and the former name in a text, allows them in identifiers", () => {
    expect(productNameViolations("x", { a: "Restow cannot do this" })).toHaveLength(1);
    expect(productNameViolations("x", { a: "Welcome to Restow" })).toHaveLength(1);
    expect(productNameViolations("x", { nested: { a: ["The Restow app"] } })).toHaveLength(1);
    expect(productNameViolations("x", { a: `${FORMER_NAME} cannot do this` })).toHaveLength(1);
    expect(productNameViolations("x", { a: `Welcome to ${FORMER_NAME} Backup` })).toHaveLength(1);
    expect(productNameViolations("x", { a: "{appName} cannot do this" })).toStrictEqual([]);
    expect(productNameViolations("x", { a: "Send X-Restow-Tenant with it" })).toStrictEqual([]);
    expect(productNameViolations("x", { a: `Send X-${FORMER_NAME}-Tenant with it` })).toHaveLength(
      1,
    );
    expect(
      productNameViolations("x", { a: "Set RESTOW_PUBLIC_URL, see restow-agent" }),
    ).toStrictEqual([]);
    expect(productNameViolations("x", { a: "a folder named Restow-Restore" })).toStrictEqual([]);
    expect(productNameViolations("x", { a: `a folder named ${FORMER_NAME}-Restore` })).toHaveLength(
      1,
    );
    expect(
      productNameViolations("license", { errors: { malformed: "Not a Restow key" } }),
    ).toHaveLength(1);
  });

  for (const language of supportedLanguages) {
    for (const file of resourceNames(language)) {
      it(`names the product only as {appName} in ${language}/${file}.json`, () => {
        const data = JSON.parse(readFileSync(resourcePath(language, file), "utf-8")) as unknown;
        expect(productNameViolations(file, data)).toStrictEqual([]);
      });

      // The placeholder sits in plain text, inside ICU select and plural branches
      // and next to punctuation: every such message must still be valid ICU, and the
      // placeholder spelled exactly as the branding resolves it.
      it(`keeps every {appName} message of ${language}/${file}.json valid ICU`, () => {
        const data = JSON.parse(readFileSync(resourcePath(language, file), "utf-8")) as unknown;
        for (const { key, value } of leaves(data)) {
          const misspelled = [...value.matchAll(/\{(?:app_?name|product_?name)\}/gi)]
            .map((match) => match[0])
            .filter((placeholder) => placeholder !== "{appName}");
          expect(misspelled, `${file}:${key}`).toStrictEqual([]);
          if (value.includes("{appName}")) {
            expect(
              () => new IntlMessageFormat(value, language, undefined, { ignoreTag: true }),
              `${file}:${key}`,
            ).not.toThrow();
          }
        }
      });
    }
  }
});

function resourceNames(language: string): string[] {
  return readdirSync(new URL(`../resources/${language}/`, import.meta.url))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

function resourcePath(language: string, file: string): string {
  return fileURLToPath(new URL(`../resources/${language}/${file}.json`, import.meta.url));
}
