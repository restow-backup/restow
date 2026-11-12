/**
 * The container entrypoint the Dockerfile writes into the image
 * (`/usr/local/bin/restow-entrypoint`), run as it is with a stand-in for `node`:
 * `node --test scripts/docker/entrypoint.test.mjs`.
 *
 * What it proves is the order of the api's start (docs/LICENSING.md, "When a
 * version starts that the key does not cover"): the licence start check runs
 * before the database migrations, and a release the installed key does not
 * cover ends the start there, so no migration runs and nothing is started.
 * The check itself is tested where it lives (ee/api/src/license); this test
 * is about the script around it, which no other test runs.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const posix = process.platform !== "win32";

/** The entrypoint script, cut out of the Dockerfile's heredoc. */
function entrypointSource() {
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  const start = dockerfile.indexOf("COPY <<'EOF' /usr/local/bin/restow-entrypoint\n");
  assert.notEqual(start, -1, "the Dockerfile no longer writes restow-entrypoint from a heredoc");
  const body = dockerfile.slice(dockerfile.indexOf("\n", start) + 1);
  const end = body.indexOf("\nEOF\n");
  assert.notEqual(end, -1, "the entrypoint heredoc has no end");
  return `${body.slice(0, end)}\n`;
}

let work;

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "restow-entrypoint-")));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function write(path, content, mode) {
  const target = join(work, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  if (mode !== undefined) {
    chmodSync(target, mode);
  }
}

/**
 * Run the entrypoint for `role` against a `/prod` tree in the work folder. `node` is a
 * stand-in that records each call and ends the licence start check with `startupExit`.
 * `fullBuild` decides whether the tree holds the check (the Community build has none).
 */
function runEntrypoint({ role = "api", fullBuild = true, startupExit = 0 } = {}) {
  const prod = join(work, "prod");
  // The only change to the script: where the image keeps the roles.
  write("entrypoint.sh", entrypointSource().replaceAll("/prod/", `${prod}/`), 0o755);
  write(`prod/${role}/package.json`, JSON.stringify({ scripts: { start: "node dist/index.js" } }));
  if (fullBuild) {
    write("prod/api/dist/ee/api/src/license/startup-check.js", "");
  }
  write(
    "bin/node",
    [
      "#!/bin/sh",
      'case "$*" in',
      '  *license/startup-check.js*) echo "startup-check" >> "$CALLS"; exit "$STARTUP_EXIT" ;;',
      '  *@restow/db/migrate*) echo "migrate" >> "$CALLS"; exit 0 ;;',
      '  -p*) echo "node dist/index.js"; exit 0 ;;',
      '  dist/index.js) echo "start" >> "$CALLS"; exit 0 ;;',
      "esac",
      'echo "unexpected: $*" >> "$CALLS"',
      "exit 0",
      "",
    ].join("\n"),
    0o755,
  );
  const calls = join(work, "calls");
  const result = spawnSync("sh", [join(work, "entrypoint.sh")], {
    encoding: "utf8",
    env: {
      PATH: `${join(work, "bin")}:${process.env.PATH}`,
      ROLE: role,
      CALLS: calls,
      STARTUP_EXIT: String(startupExit),
    },
  });
  return {
    status: result.status,
    stderr: result.stderr,
    calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
  };
}

describe("the api's start in the container entrypoint", { skip: !posix }, () => {
  it("checks the licence key before the migrations, then migrates and starts", () => {
    const run = runEntrypoint();
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.calls, ["startup-check", "migrate", "start"]);
  });

  it("stops a release the key does not cover before any migration, and starts nothing [LICENSE-004]", () => {
    const run = runEntrypoint({ startupExit: 1 });
    assert.equal(run.status, 1);
    // The check ran, and nothing after it: no migration, no api.
    assert.deepEqual(run.calls, ["startup-check"]);
    assert.match(run.stderr, /not covered by the installed licence key/);
    assert.match(run.stderr, /the database was not changed/);
    assert.doesNotMatch(run.stderr, /applying database migrations/);
  });

  it("migrates without a check in the Community build, which has none", () => {
    const run = runEntrypoint({ fullBuild: false });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.calls, ["migrate", "start"]);
  });

  it("runs neither the check nor the migrations for the worker and the scheduler", () => {
    for (const role of ["worker", "scheduler"]) {
      rmSync(join(work, "calls"), { force: true });
      const run = runEntrypoint({ role, startupExit: 1 });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(run.calls, ["start"]);
    }
  });

  it("refuses an unknown role", () => {
    const run = runEntrypoint({ role: "cron" });
    assert.equal(run.status, 64);
    assert.deepEqual(run.calls, []);
  });
});
