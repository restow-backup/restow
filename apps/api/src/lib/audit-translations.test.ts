import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { protectedObjectKindEnum } from "@restow/db";
import auditDe from "@restow/i18n/resources/de/audit.json" with { type: "json" };
import auditEn from "@restow/i18n/resources/en/audit.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { V1_AUDIT_ACTIONS } from "../routes/v1/audit.js";
import { AUDIT_ACTIONS } from "./audit.js";

/**
 * Every audit action and target type the API writes must have a label in both
 * languages: the audit log shows unknown codes raw (`api.users.read`), which a
 * German operator should never see. The codes are collected from the source,
 * so a new action or target type fails here until it is translated.
 */

type Tree = { [key: string]: string | Tree };

const SOURCE_ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * Comments stripped so a brace inside one (a JSDoc `{@link ...}`) cannot end
 * an object-literal match early. Only used for the two regex scans below;
 * string literals inside comments were never meant to be collected anyway.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function sourceFiles(): string[] {
  return readdirSync(SOURCE_ROOT, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
    .map((path) => withoutComments(readFileSync(join(SOURCE_ROOT, path), "utf8")));
}

const STRING_LITERAL = /"([a-z_]+(?:\.[a-z_]+)*)"/g;

function literalsIn(text: string): string[] {
  return [...text.matchAll(STRING_LITERAL)].map((match) => match[1] ?? "");
}

/** Values of every `*AUDIT_ACTIONS = { ... }` object plus literal `action: "a.b"` fields. */
function collectAuditActions(files: readonly string[]): Set<string> {
  const actions = new Set<string>();
  for (const text of files) {
    for (const block of text.matchAll(/\w*AUDIT_ACTIONS\s*=\s*\{([^}]*)\}/g)) {
      for (const value of literalsIn(block[1] ?? "")) {
        actions.add(value);
      }
    }
    for (const match of text.matchAll(/\baction:\s*"([a-z_]+(?:\.[a-z_]+)+)"/g)) {
      actions.add(match[1] ?? "");
    }
  }
  return actions;
}

/** `targetType: "x"` and `targetType: condition ? "x" : "y"` fields. */
function collectTargetTypes(files: readonly string[]): Set<string> {
  const types = new Set<string>();
  const pattern = /\btargetType:\s*(?:[\w.!\s]+\?\s*)?"([a-z_]+)"(?:\s*:\s*"([a-z_]+)")?/g;
  for (const text of files) {
    for (const match of text.matchAll(pattern)) {
      for (const value of [match[1], match[2]]) {
        if (value) {
          types.add(value);
        }
      }
    }
  }
  // Directory changes name the protected object's kind as their target type.
  for (const kind of protectedObjectKindEnum.enumValues) {
    types.add(kind);
  }
  return types;
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

const LANGUAGES: Record<string, Tree> = { de: auditDe as Tree, en: auditEn as Tree };

function untranslated(keys: Iterable<string>): string[] {
  const missing: string[] = [];
  for (const [language, tree] of Object.entries(LANGUAGES)) {
    for (const key of keys) {
      if (typeof lookup(tree, key) !== "string") {
        missing.push(`${language}: ${key}`);
      }
    }
  }
  return missing.sort();
}

const files = sourceFiles();
const actions = collectAuditActions(files);
const targetTypes = collectTargetTypes(files);

describe("audit translations", () => {
  it("collect the actions the API writes", () => {
    // The scan must see the declared constants, or the checks below prove nothing.
    for (const action of [...Object.values(AUDIT_ACTIONS), ...Object.values(V1_AUDIT_ACTIONS)]) {
      expect(actions).toContain(action);
    }
    expect(actions).toContain("tenant.member.removed");
    expect(targetTypes).toContain("webhook");
  });

  it("label every action in German and English", () => {
    expect(untranslated([...actions].map((action) => `events.${action}`))).toEqual([]);
  });

  it("label the category of every action", () => {
    const categories = new Set([...actions].map((action) => action.split(".")[0] ?? action));
    expect(untranslated([...categories].map((category) => `categories.${category}`))).toEqual([]);
  });

  it("label every target type", () => {
    expect(untranslated([...targetTypes].map((type) => `targetTypes.${type}`))).toEqual([]);
  });
});
