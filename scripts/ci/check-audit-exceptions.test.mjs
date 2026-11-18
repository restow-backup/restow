import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  check,
  compare,
  documentedAdvisories,
  ignoredAdvisories,
  patchedVersions,
} from "./check-audit-exceptions.mjs";

const ID = "GHSA-fc5q-39xc-vjpf";
const DOC = [
  "# CI",
  "",
  "## Audit exceptions",
  "",
  "| Advisory | Package | Why it does not count |",
  "|---|---|---|",
  `| \`${ID}\` | picomatch | test runner only |`,
  "",
  "## Next",
  "| `GHSA-xxxx-xxxx-xxxx` | not in the section |",
].join("\n");

const quiet = { warn() {} };
const answer =
  (body, ok = true) =>
  async () => ({ ok, status: ok ? 200 : 503, json: async () => body });

test("the ignored advisories come from pnpm.auditConfig.ignoreGhsas", () => {
  assert.deepEqual(ignoredAdvisories({}), []);
  assert.deepEqual(ignoredAdvisories({ pnpm: { auditConfig: { ignoreGhsas: [ID] } } }), [ID]);
  assert.throws(() => ignoredAdvisories({ pnpm: { auditConfig: { ignoreGhsas: ID } } }));
});

test("only the table of the section counts as documentation", () => {
  assert.deepEqual(documentedAdvisories(DOC), [ID]);
  assert.deepEqual(documentedAdvisories("# CI\n"), []);
});

test("configuration and documentation must name the same advisories", () => {
  assert.deepEqual(compare([ID], [ID]), []);
  assert.match(compare([ID], [])[0], /no row/);
  assert.match(compare([], [ID])[0], /not ignored/);
  assert.match(compare(["CVE-2026-1"], ["CVE-2026-1"])[0], /not a GHSA ID/);
});

test("patched versions are read from the advisory", () => {
  assert.deepEqual(patchedVersions({ vulnerabilities: [{ first_patched_version: null }] }), []);
  assert.deepEqual(
    patchedVersions({ vulnerabilities: [{ first_patched_version: { identifier: "4.0.8" } }] }),
    ["4.0.8"],
  );
  assert.deepEqual(patchedVersions({ vulnerabilities: [{ first_patched_version: "4.0.8" }] }), [
    "4.0.8",
  ]);
});

test("an exception without a fix passes", async () => {
  const pkg = { pnpm: { auditConfig: { ignoreGhsas: [ID] } } };
  const fetchImpl = answer({ vulnerabilities: [{ first_patched_version: null }] });
  assert.deepEqual(await check({ pkg, markdown: DOC, fetchImpl, log: quiet }), []);
});

test("an exception whose advisory has a fix fails", async () => {
  const pkg = { pnpm: { auditConfig: { ignoreGhsas: [ID] } } };
  const fetchImpl = answer({
    vulnerabilities: [{ first_patched_version: { identifier: "4.0.8" } }],
  });
  const problems = await check({ pkg, markdown: DOC, fetchImpl, log: quiet });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /has a fix now \(4\.0\.8\)/);
});

test("an unreachable advisory database warns, and fails only with --strict", async () => {
  const pkg = { pnpm: { auditConfig: { ignoreGhsas: [ID] } } };
  const fetchImpl = answer({}, false);
  const warnings = [];
  const log = { warn: (line) => warnings.push(line) };
  assert.deepEqual(await check({ pkg, markdown: DOC, fetchImpl, log }), []);
  assert.equal(warnings.length, 1);
  const strict = await check({ pkg, markdown: DOC, fetchImpl, log: quiet, strict: true });
  assert.match(strict[0], /could not be read/);
});

test("a refused token is tried once without", async () => {
  const seen = [];
  const fetchImpl = async (_url, { headers }) => {
    seen.push(Boolean(headers.authorization));
    return headers.authorization
      ? { ok: false, status: 401, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ vulnerabilities: [] }) };
  };
  const pkg = { pnpm: { auditConfig: { ignoreGhsas: [ID] } } };
  const prev = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "refused";
  try {
    assert.deepEqual(await check({ pkg, markdown: DOC, fetchImpl, log: quiet, strict: true }), []);
  } finally {
    if (prev === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prev;
  }
  assert.deepEqual(seen, [true, false]);
});

test("the repository's exceptions are documented", () => {
  const root = new URL("../../", import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  const markdown = readFileSync(new URL("docs/CI.md", root), "utf8");
  assert.deepEqual(compare(ignoredAdvisories(pkg), documentedAdvisories(markdown)), []);
});
