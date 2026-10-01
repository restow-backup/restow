import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSmokeReport, summarizeSmokeReport } from "../../ci/release-lib.mjs";
import { CheckRun, RESULT, Report, formatDuration } from "./report.mjs";

const META = {
  version: "0.1.0",
  image: "ghcr.io/restow-backup/restow@sha256:abc",
  revision: "deadbeef",
  platform: "linux/amd64",
  runner: "test",
};

test("formatDuration", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(95_400), "95s");
  assert.equal(formatDuration(125_000), "2m 05s");
});

test("a skipped check is named in the verdict and never counted as passed", () => {
  const report = new Report(META);
  report.add({ id: 1, name: "Install", result: RESULT.PASS, summary: "ok", durationMs: 1000 });
  report.add({
    id: 4,
    name: "Microsoft 365 backup and restore",
    result: RESULT.SKIPPED,
    summary: "skipped: no dev tenant credentials",
  });
  assert.match(
    report.verdict(),
    /^PASS with gaps: 1 of 2 checks passed in full, 0 partly, 1 skipped/,
  );
  const markdown = report.toMarkdown();
  assert.match(
    markdown,
    /## Skipped or partial checks\n\n- 4\. Microsoft 365 backup and restore \(SKIPPED\): skipped: no dev tenant credentials/,
  );
  assert.match(
    markdown,
    /\| 4 \| Microsoft 365 backup and restore \| SKIPPED \| 0s \| skipped: no dev tenant credentials \|/,
  );
});

test("the report names the build it tested", () => {
  assert.match(new Report(META).toMarkdown(), /^- Build: full \(/m);
  assert.match(
    new Report({ ...META, variant: "community" }).toMarkdown(),
    /^- Build: Community \(the Apache-2\.0 core without ee\/, Dockerfile targets runtime-community and web-community\)$/m,
  );
});

test("a failed check fails the verdict", () => {
  const report = new Report(META);
  report.add({ id: 1, name: "Install", result: RESULT.FAIL, summary: "boom" });
  assert.match(report.verdict(), /^FAIL: 1 of 1/);
});

test("cell text cannot break the table", () => {
  const report = new Report(META);
  report.add({ id: 2, name: "Health | ready", result: RESULT.PASS, summary: "a | b\nc" });
  assert.match(report.toMarkdown(), /\| 2 \| Health \\\| ready \| PASS \| 0s \| a \\\| b c \|/);
});

test("the release tooling reads the table back", () => {
  const report = new Report(META);
  report.add({ id: 1, name: "Install", result: RESULT.PASS, summary: "ok", durationMs: 95_000 });
  report.add({
    id: "10",
    name: "Endpoint backup",
    result: RESULT.SKIPPED,
    summary: "skipped: absent",
  });
  const rows = parseSmokeReport(report.toMarkdown());
  assert.deepEqual(
    rows.map((row) => [row.id, row.result, row.duration]),
    [
      ["1", "PASS", "95s"],
      ["10", "SKIPPED", "0s"],
    ],
  );
  assert.match(
    summarizeSmokeReport(report.toMarkdown()),
    /1 of 2 checks passed in full, 0 partly, 1 skipped, 0 failed/,
  );
});

test("CheckRun records steps and derives the row", async () => {
  const run = new CheckRun("5", "IMAP", () => {});
  await run.step("seed", async () => "20 messages");
  run.skip("optional", "not configured");
  const ok = run.finish();
  assert.equal(ok.result, RESULT.PARTIAL);
  assert.match(ok.summary, /1 steps passed; not run: optional \(not configured\)/);
  const clean = new CheckRun("6", "Journal", () => {});
  await clean.step("receipt", async () => "accepted");
  assert.equal(clean.finish().result, RESULT.PASS);

  const failing = new CheckRun("5", "IMAP", () => {});
  await assert.rejects(
    failing.step("compare", async () => {
      throw new Error("hash differs");
    }),
    /hash differs/,
  );
  const bad = failing.finish();
  assert.equal(bad.result, RESULT.FAIL);
  assert.match(bad.summary, /compare: hash differs/);

  const skipped = new CheckRun("4", "M365", () => {}).finish({
    skippedSummary: "skipped: no dev tenant credentials",
  });
  assert.equal(skipped.result, RESULT.SKIPPED);
});
