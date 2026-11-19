#!/usr/bin/env node
/**
 * Writes the release notes of a version: the CHANGELOG.md section, with the
 * Verification section completed by the release smoke report.
 *
 * Usage: node scripts/ci/release-notes.mjs --version 0.1.0 --out release-notes.md
 *          [--changelog CHANGELOG.md] [--smoke-report smoke-report.md] [--channel beta]
 *          [--max-chars 110000 --changelog-url <CHANGELOG.md at the tag>]
 *
 * With --max-chars the long sections that are no Summary, Breaking Changes, Security, Upgrade
 * Notes, Known Issues or Verification point to --changelog-url instead, until the text fits
 * (GitHub takes at most 125,000 characters; the release workflow appends its own part).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  buildReleaseNotes,
  findChangelogSection,
  fitReleaseNotes,
  summarizeSmokeReport,
} from "./release-lib.mjs";

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
let notes = buildReleaseNotes({
  version,
  section,
  smokeSummary: summary,
  channel: argument("channel"),
  date: new Date().toISOString().slice(0, 10),
});
const maxChars = argument("max-chars");
if (maxChars !== undefined) {
  const changelogUrl = argument("changelog-url");
  if (!/^\d+$/.test(maxChars) || !changelogUrl) {
    console.error("release-notes: --max-chars needs a number and --changelog-url");
    process.exit(2);
  }
  try {
    const fitted = fitReleaseNotes(notes, { maxChars: Number(maxChars), changelogUrl });
    notes = fitted.notes;
    if (fitted.shortened.length > 0) {
      console.log(`release-notes: pointing to CHANGELOG.md for ${fitted.shortened.join(", ")}`);
    }
  } catch (error) {
    console.error(`release-notes: ${error.message}`);
    process.exit(1);
  }
}
writeFileSync(out, notes);
console.log(`release-notes: wrote ${out}`);
