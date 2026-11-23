/**
 * The signed agent of a release build (agent/prebuilt, Dockerfile stage agent-build): every file
 * the signed SHA256SUMS lists must be there and match, except the one line of the recovery ISO
 * (recovery/restow-recovery_<v>_amd64.iso), which names no file of the image. The release run
 * 44386727507 stopped at exactly that line. The test runs the Dockerfile's own commands.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const dockerfile = readFileSync(join(repo, "Dockerfile"), "utf8");

/** The Dockerfile's check of agent/prebuilt against SHA256SUMS, as shell lines. */
function prebuiltCheck() {
  const lines = dockerfile.split("\n");
  const start = lines.findIndex((line) => line.includes("grep -Ev ") && line.includes("recovery/"));
  assert.ok(start > 0, "the Dockerfile has no filter for the recovery ISO line");
  const check = lines.slice(start, start + 3).map((line) => line.trim().replace(/; \\$/, ""));
  assert.match(check[1], /^test -s \/tmp\/agent-sums$/);
  assert.match(check[2], /^sha256sum -c \/tmp\/agent-sums$/);
  return check.map((line) => line.replaceAll("/tmp/agent-sums", "agent-sums")).join("\n");
}

const sha = (text) => createHash("sha256").update(text).digest("hex");
const ISO = `${"a".repeat(64)}  recovery/restow-recovery_0.5.0_amd64.iso`;

function run(sums, files) {
  const dir = mkdtempSync(join(tmpdir(), "prebuilt-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    writeFileSync(join(dir, "SHA256SUMS"), `${sums.join("\n")}\n`);
    execFileSync("sh", ["-c", `set -eu\n${prebuiltCheck()}`], { cwd: dir, stdio: "pipe" });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the signed agent in a release build", () => {
  const files = { "linux-amd64/restow-agent": "agent", "linux-amd64/restic": "restic" };
  const lines = Object.entries(files).map(([name, text]) => `${sha(text)}  ${name}`);

  it("passes with the recovery ISO's line in the signed list", () => {
    assert.equal(run([...lines, ISO], files), true);
  });

  it("still checks every other file", () => {
    assert.equal(run([...lines, ISO], { ...files, "linux-amd64/restic": "changed" }), false);
    assert.equal(run([...lines, ISO], { "linux-amd64/restow-agent": "agent" }), false);
  });

  it("skips no other line under recovery/", () => {
    const other = `${"b".repeat(64)}  recovery/other.bin`;
    assert.equal(run([...lines, ISO, other], files), false);
  });

  it("refuses a list that holds only the ISO", () => {
    assert.equal(run([ISO], {}), false);
  });
});
