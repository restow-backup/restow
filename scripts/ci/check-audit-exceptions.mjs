#!/usr/bin/env node
/**
 * Repository guard for the exceptions of `pnpm audit`.
 *
 * `package.json` may name advisories under `pnpm.auditConfig.ignoreGhsas` that the
 * audit (CI job "Dependency audit" and release smoke check 9) does not count. An
 * exception is allowed only for an advisory without a fix whose package does not run in
 * production; docs/CI.md ("Audit exceptions") gives the reason for each one.
 *
 * The guard fails when
 *   - an ignored advisory has no row in the table of docs/CI.md, or a row names an
 *     advisory that is not ignored (the table and the configuration say the same),
 *   - an ID is not a GHSA ID,
 *   - the advisory database lists a patched version for an ignored advisory: then the
 *     dependency is to be updated and the exception removed.
 *
 * When the advisory database cannot be reached it warns and passes (the audit itself
 * still runs); `--strict` turns that into a failure.
 *
 *   node scripts/ci/check-audit-exceptions.mjs [--strict]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const SECTION = "## Audit exceptions";

/** The advisories `pnpm audit` ignores, from the root package.json. */
export function ignoredAdvisories(pkg) {
  const list = pkg?.pnpm?.auditConfig?.ignoreGhsas ?? [];
  if (!Array.isArray(list)) throw new Error("pnpm.auditConfig.ignoreGhsas must be a list");
  return list;
}

/** The GHSA IDs in the first column of the table under "## Audit exceptions". */
export function documentedAdvisories(markdown) {
  const start = markdown.indexOf(`\n${SECTION}\n`);
  if (start < 0) return [];
  const rest = markdown.slice(start + SECTION.length + 2);
  const end = rest.search(/\n## /);
  const section = end < 0 ? rest : rest.slice(0, end);
  const ids = [];
  for (const line of section.split("\n")) {
    const match = /^\|\s*`?(GHSA-[^|`\s]+)`?\s*\|/.exec(line);
    if (match) ids.push(match[1]);
  }
  return ids;
}

/** Problems between the configuration and the documentation. */
export function compare(ignored, documented) {
  const problems = [];
  for (const id of ignored) {
    if (!GHSA.test(id)) problems.push(`${id} is not a GHSA ID`);
    if (!documented.includes(id))
      problems.push(`${id} is ignored but has no row in docs/CI.md "${SECTION.slice(3)}"`);
  }
  for (const id of documented) {
    if (!ignored.includes(id))
      problems.push(`${id} has a row in docs/CI.md but is not ignored in package.json`);
  }
  return problems;
}

/** The patched versions the advisory database lists (empty: no fix yet). */
export function patchedVersions(advisory) {
  return (advisory?.vulnerabilities ?? [])
    .map((v) => v?.first_patched_version?.identifier ?? v?.first_patched_version)
    .filter((v) => typeof v === "string" && v.length > 0);
}

export async function fetchAdvisory(id, fetchImpl = fetch, token = process.env.GITHUB_TOKEN) {
  const url = `https://api.github.com/advisories/${id}`;
  const request = (withToken) => {
    const headers = { accept: "application/vnd.github+json", "user-agent": "restow-ci" };
    if (withToken) headers.authorization = `Bearer ${token}`;
    return fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
  };
  let response = await request(Boolean(token));
  // The advisory database is public: a token it refuses is tried once without.
  if (token && (response.status === 401 || response.status === 403))
    response = await request(false);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function check({ pkg, markdown, strict = false, fetchImpl = fetch, log = console }) {
  const ignored = ignoredAdvisories(pkg);
  const problems = compare(ignored, documentedAdvisories(markdown));
  for (const id of ignored.filter((value) => GHSA.test(value))) {
    try {
      const patched = patchedVersions(await fetchAdvisory(id, fetchImpl));
      if (patched.length > 0) {
        problems.push(
          `${id} has a fix now (${patched.join(", ")}): update the dependency and remove the exception`,
        );
      }
    } catch (error) {
      const message = `${id}: the advisory database could not be read (${error.message})`;
      if (strict) problems.push(message);
      else log.warn(`warning: ${message}`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL("../../", import.meta.url);
  const problems = await check({
    pkg: JSON.parse(readFileSync(new URL("package.json", root), "utf8")),
    markdown: readFileSync(new URL("docs/CI.md", root), "utf8"),
    strict: process.argv.includes("--strict"),
  });
  for (const problem of problems) console.error(`audit exceptions: ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log("audit exceptions: documented, and none has a fix yet");
}
