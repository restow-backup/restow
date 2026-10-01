/**
 * What the passkey E2E treats as a missing translation. i18next prints the key
 * itself when it finds no text for it, so a screen with a gap shows something
 * like "tenants.wizard.next" where a label belongs. The E2E hands every leaf
 * text of a screen to {@link untranslatedIssue}; this file is pure so its rules
 * are covered by i18n-scan.test.mjs.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Key paths of the shipped translations: `{ keys, topLevel }` over de and en. */
export function loadTranslations(directory) {
  const result = { topLevel: new Set(), keys: new Set() };
  for (const language of ["de", "en"]) {
    for (const file of readdirSync(join(directory, language))) {
      if (!file.endsWith(".json")) {
        continue;
      }
      const namespace = file.slice(0, -".json".length);
      const tree = JSON.parse(readFileSync(join(directory, language, file), "utf8"));
      collectKeys(tree, "", namespace, result.keys);
      for (const key of Object.keys(tree)) {
        result.topLevel.add(key);
      }
    }
  }
  return result;
}

export function collectKeys(tree, prefix, namespace, into) {
  for (const [key, child] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      collectKeys(child, path, namespace, into);
    } else {
      into.add(path);
      into.add(`${namespace}:${path}`);
    }
  }
}

const KEY_SHAPE = /^[a-z][A-Za-z0-9_]*(?::[A-Za-z0-9_.]+|(?:\.[A-Za-z0-9_]+)+)$/u;
const LEFTOVER = /\{\{|\}\}|\[object Object\]|\bundefined\b/u;
// A file name is not a key: "report.pdf" starts with a word that may also be a namespace.
const FILE_EXTENSION =
  /\.(eml|msg|pdf|txt|zip|json|csv|docx?|xlsx?|pptx?|png|jpe?g|gif|md|log|ics|vcf|bin|html?)$/iu;

/** The problem with a screen text, or null when it looks fine. */
export function untranslatedIssue(text, translations) {
  if (LEFTOVER.test(text)) {
    return `leftover placeholder: "${text}"`;
  }
  if (!KEY_SHAPE.test(text) || FILE_EXTENSION.test(text)) {
    return null;
  }
  const bare = text.includes(":") ? text.split(":")[1] : text;
  const top = bare.split(".")[0];
  if (
    translations.keys.has(text) ||
    translations.keys.has(bare) ||
    translations.topLevel.has(top)
  ) {
    return `untranslated key: "${text}"`;
  }
  return null;
}
