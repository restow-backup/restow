import assert from "node:assert/strict";
import { test } from "node:test";
import { collectKeys, untranslatedIssue } from "./i18n-scan.mjs";

const keys = new Set();
collectKeys({ wizard: { next: "Next" }, nav: "Tenants" }, "", "tenants", keys);
const translations = { keys, topLevel: new Set(["wizard", "nav", "login", "backup"]) };

test("a printed key is an issue, with or without its namespace", () => {
  assert.match(untranslatedIssue("wizard.next", translations), /untranslated key/);
  assert.match(untranslatedIssue("tenants:wizard.next", translations), /untranslated key/);
  assert.match(untranslatedIssue("login.error.network", translations), /untranslated key/);
});

test("ordinary text, addresses and file names are not", () => {
  for (const text of [
    "Next",
    "Weiter",
    "example.com",
    "admin@smoke.test",
    "backup.eml",
    "v0.1.0",
    "12.5 MB",
  ]) {
    assert.equal(untranslatedIssue(text, translations), null, text);
  }
});

test("leftover placeholders are issues", () => {
  assert.match(untranslatedIssue("Hello {{name}}", translations), /leftover placeholder/);
  assert.match(untranslatedIssue("Added undefined", translations), /leftover placeholder/);
  assert.match(untranslatedIssue("[object Object]", translations), /leftover placeholder/);
});
