#!/usr/bin/env node
/**
 * Writes the release notes of a version: the CHANGELOG.md section, with the
 * Verification section completed by the release smoke report.
 *
 * Usage: node scripts/ci/release-notes.mjs --version 0.1.0 --out release-notes.md
 *          [--changelog CHANGELOG.md] [--smoke-report smoke-report.md] [--channel beta]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildReleaseNotes, findChangelogSection, summarizeSmokeReport } from "./release-lib.mjs";

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const version = argument("version");
const out = argument("out");
if (!version || !out) {
  console.error("release-notes: --version and --out are required");
  process.exit(2);
}
const changelog = readFileSync(argument("changelog", "CHANGELOG.md"), "utf8");
const section = findChangelogSection(changelog, version);
if (!section) {
  console.error(`release-notes: CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}
const reportPath = argument("smoke-report");
const summary =
  reportPath && existsSync(reportPath)
    ? summarizeSmokeReport(readFileSync(reportPath, "utf8"))
    : "";
writeFileSync(
  out,
  buildReleaseNotes({
    version,
    section,
    smokeSummary: summary,
    channel: argument("channel"),
    date: new Date().toISOString().slice(0, 10),
  }),
);
console.log(`release-notes: wrote ${out}`);
