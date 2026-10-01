import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildReleaseNotes,
  dockerTags,
  findChangelogSection,
  isCalendarDate,
  parseSmokeReport,
  parseTag,
  previousRelease,
  summarizeSmokeReport,
  validateRelease,
} from "./release-lib.mjs";

const SECTIONS = [
  "Summary",
  "Breaking Changes",
  "Added",
  "Changed",
  "Fixed",
  "Security",
  "Upgrade Notes",
  "Known Issues",
  "Verification",
];

function changelog(version, date, { skip = [], verification = "Everything ran." } = {}) {
  const body = SECTIONS.filter((title) => !skip.includes(title))
    .map((title) => `### ${title}\n\n${title === "Verification" ? verification : "None."}\n`)
    .join("\n");
  return `# Changelog\n\n## [${version}] - ${date}\n\nBeta release.\n\n${body}\n## [0.0.9] - 2026-01-01\n\nOld.\n`;
}

const base = { tag: "v0.1.0", packageVersion: "0.1.0", today: "2026-09-30" };

test("parseTag accepts release tags and pre-releases only", () => {
  assert.equal(parseTag("v0.1.0")?.version, "0.1.0");
  assert.equal(parseTag("v1.2.0-rc.1")?.prerelease, "rc.1");
  for (const bad of ["0.1.0", "v0.1", "v01.2.3", "v1.2.3+build", "latest", "v1.2.3-", "vx.y.z"]) {
    assert.equal(parseTag(bad), null, bad);
  }
});

test("dockerTags follows the documented rules: beta below 1.0, latest and floating tags from 1.0", () => {
  assert.deepEqual(dockerTags(parseTag("v0.1.0")), { channel: "beta", tags: ["0.1.0", "beta"] });
  assert.deepEqual(dockerTags(parseTag("v0.12.3")), { channel: "beta", tags: ["0.12.3", "beta"] });
  assert.deepEqual(dockerTags(parseTag("v1.2.3")), {
    channel: "stable",
    tags: ["1.2.3", "1.2", "1", "latest"],
  });
  assert.deepEqual(dockerTags(parseTag("v1.2.0-rc.1")), {
    channel: "prerelease",
    tags: ["1.2.0-rc.1"],
  });
  assert.deepEqual(dockerTags(parseTag("v0.2.0-rc.1")), {
    channel: "prerelease",
    tags: ["0.2.0-rc.1"],
  });
});

test("isCalendarDate rejects placeholders and impossible dates", () => {
  assert.equal(isCalendarDate("2026-09-30"), true);
  assert.equal(isCalendarDate("YYYY-MM-DD"), false);
  assert.equal(isCalendarDate("2026-02-30"), false);
  assert.equal(isCalendarDate("2026-9-3"), false);
});

test("a finished release passes", () => {
  const result = validateRelease({ ...base, changelog: changelog("0.1.0", "2026-09-30") });
  assert.deepEqual(result.errors, []);
  assert.equal(result.channel, "beta");
  assert.deepEqual(result.tags, ["0.1.0", "beta"]);
});

test("the tag must match package.json", () => {
  const result = validateRelease({
    ...base,
    packageVersion: "0.2.0",
    changelog: changelog("0.1.0", "2026-09-30"),
  });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /does not match the version in package\.json/);
});

test("the changelog needs a section with a real date for the version", () => {
  const missing = validateRelease({ ...base, changelog: changelog("0.0.8", "2026-09-30") });
  assert.match(missing.errors.join("\n"), /no section "## \[0\.1\.0\]/);
  const placeholder = validateRelease({ ...base, changelog: changelog("0.1.0", "YYYY-MM-DD") });
  assert.match(placeholder.errors.join("\n"), /no real release date/);
  const future = validateRelease({ ...base, changelog: changelog("0.1.0", "2027-01-01") });
  assert.match(future.errors.join("\n"), /lies in the future/);
  const tomorrow = validateRelease({ ...base, changelog: changelog("0.1.0", "2026-10-01") });
  assert.deepEqual(tomorrow.errors, []);
});

test("every required section must exist and hold text", () => {
  const result = validateRelease({
    ...base,
    changelog: changelog("0.1.0", "2026-09-30", { skip: ["Security", "Upgrade Notes"] }),
  });
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /### Security/);
  const empty = validateRelease({
    ...base,
    changelog: changelog("0.1.0", "2026-09-30", { verification: "" }),
  });
  assert.match(empty.errors.join("\n"), /"### Verification" section of 0\.1\.0 is empty/);
});

test("a Verification placeholder is a warning, not an error", () => {
  const result = validateRelease({
    ...base,
    changelog: changelog("0.1.0", "2026-09-30", { verification: "To be filled by the smoke run." }),
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
});

test("findChangelogSection stops at the next version heading", () => {
  const section = findChangelogSection(changelog("0.1.0", "2026-09-30"), "0.1.0");
  assert.equal(section?.date, "2026-09-30");
  assert.ok(section?.body.includes("### Summary"));
  assert.ok(!section?.body.includes("Old."));
  assert.equal(findChangelogSection(changelog("0.1.0", "2026-09-30"), "9.9.9"), null);
});

const REPORT = `# Restow release smoke report

| # | Check | Result | Duration | Detail |
| --- | --- | --- | --- | --- |
| 1 | Image, compose up, migrations | PASS | 95s | ok |
| 2 | Health and readiness | PASS | 3s | ok |
| 4 | Microsoft 365 backup and restore | SKIPPED | 0s | skipped: no dev tenant credentials |
| 6 | Journal receipt | FAIL | 12s | chain broken |
`;

test("parseSmokeReport and summarizeSmokeReport read the check table", () => {
  const rows = parseSmokeReport(REPORT);
  assert.deepEqual(
    rows.map((row) => [row.id, row.result]),
    [
      ["1", "PASS"],
      ["2", "PASS"],
      ["4", "SKIPPED"],
      ["6", "FAIL"],
    ],
  );
  const summary = summarizeSmokeReport(REPORT);
  assert.match(summary, /2 of 4 checks passed in full, 0 partly, 1 skipped, 1 failed/);
  assert.equal(summarizeSmokeReport("nothing"), "");
});

test("buildReleaseNotes fills a placeholder Verification and extends a written one", () => {
  const withPlaceholder = findChangelogSection(
    changelog("0.1.0", "2026-09-30", { verification: "To be filled by the smoke run." }),
    "0.1.0",
  );
  const notes = buildReleaseNotes({
    version: "0.1.0",
    section: withPlaceholder,
    smokeSummary: "| table |",
    date: "2026-09-30",
    channel: "beta",
  });
  assert.ok(notes.startsWith("Restow 0.1.0. Released 2026-09-30, channel beta.\n\n"));
  assert.ok(!notes.includes("To be filled"));
  assert.match(notes, /### Verification\n\nRelease pipeline, 2026-09-30:\n\n\| table \|/);

  const written = findChangelogSection(changelog("0.1.0", "2026-09-30"), "0.1.0");
  const kept = buildReleaseNotes({
    version: "0.1.0",
    section: written,
    smokeSummary: "| table |",
    date: "2026-09-30",
  });
  assert.match(kept, /### Verification\n\nEverything ran\.\n\nRelease pipeline, 2026-09-30:/);
  const plain = buildReleaseNotes({
    version: "0.1.0",
    section: written,
    smokeSummary: "",
    date: "x",
  });
  assert.ok(!plain.includes("Release pipeline"));
});

test("previousRelease picks the newest stable version below the current one", () => {
  const tags = ["v0.1.0", "v0.2.0", "v0.3.0-rc.1", "v0.10.0", "v0.2.1", "nightly", "v1.0.0"];
  assert.equal(previousRelease("0.3.0", tags), "0.2.1");
  assert.equal(previousRelease("0.2.0", tags), "0.1.0");
  assert.equal(previousRelease("0.10.0", tags), "0.2.1");
  assert.equal(previousRelease("0.1.0", tags), null);
  assert.equal(previousRelease("0.1.0", []), null);
  assert.equal(previousRelease("not-a-version", tags), null);
});

test("buildReleaseNotes keeps the sections that follow Verification", () => {
  const section = {
    date: "2026-09-30",
    body: "### Summary\n\nS.\n\n### Verification\n\nTo be filled.\n\n### Afterword\n\nA.",
  };
  const notes = buildReleaseNotes({
    version: "0.1.0",
    section,
    smokeSummary: "| table |",
    date: "2026-09-30",
  });
  assert.match(
    notes,
    /### Verification\n\nRelease pipeline, 2026-09-30:\n\n\| table \|\n\n### Afterword\n\nA\./,
  );
  assert.ok(!notes.includes("To be filled"));
});
