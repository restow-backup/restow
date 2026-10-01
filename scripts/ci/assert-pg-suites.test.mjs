/**
 * Self-test of the Postgres suite guard (assert-pg-suites.mjs), run in CI
 * before the guard is trusted: `node --test scripts/ci/assert-pg-suites.test.mjs`.
 *
 * Each case builds a small throwaway workspace with synthetic Vitest JSON
 * reports and checks that the guard fails on every way a Postgres suite can
 * silently not run, and passes only when all of them ran and passed.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DATABASE_ENV,
  REPORT_FILE,
  checkPostgresSuites,
  findPostgresTestFiles,
} from "./assert-pg-suites.mjs";

const ENV = { [DATABASE_ENV]: "postgres://ci@localhost:5432/postgres" };

/** A workspace with one suite, one section behind a fixture import and one plain test file. */
const SOURCES = {
  "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
  "apps/api/package.json": "{}",
  "apps/api/src/store.pg.test.ts": 'describe.skipIf(!url)("store", () => {});\n',
  "apps/api/src/testing/fixture.ts": `export const url = process.env.${DATABASE_ENV};\n`,
  "apps/api/src/handler.test.ts": 'import { url } from "./testing/fixture.js";\n',
  "apps/api/src/plain.test.ts": 'import { format } from "./format.js";\n',
  "apps/api/src/format.ts": "export const format = String;\n",
  "apps/web/package.json": "{}",
  "apps/web/src/view.test.ts": "it('renders', () => {});\n",
};

let root;

function write(path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function assertion(fullName, status = "passed") {
  return { fullName, status, title: fullName, ancestorTitles: [] };
}

/** Write the api workspace's Vitest report; `overrides` replaces a file's assertions. */
function writeReport(overrides = {}) {
  const files = {
    "apps/api/src/store.pg.test.ts": [assertion("store writes"), assertion("store reads")],
    "apps/api/src/handler.test.ts": [assertion("handler parses"), assertion("handler persists")],
    "apps/api/src/plain.test.ts": [assertion("plain formats")],
    ...overrides,
  };
  const testResults = Object.entries(files)
    .filter(([, assertions]) => assertions !== null)
    .map(([file, assertionResults]) => ({
      name: join(root, file),
      status: "passed",
      assertionResults,
    }));
  write(join("apps/api", REPORT_FILE), JSON.stringify({ testResults }));
}

describe("assert-pg-suites", () => {
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "restow-pg-guard-")));
    for (const [path, content] of Object.entries(SOURCES)) {
      write(path, content);
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds suites by name and sections through a relative import, nothing else", () => {
    const found = findPostgresTestFiles(root).map(({ file }) => file.slice(root.length + 1));
    assert.deepEqual(found, ["apps/api/src/handler.test.ts", "apps/api/src/store.pg.test.ts"]);
  });

  it("passes when every Postgres test ran and passed", () => {
    writeReport();
    const { files, problems } = checkPostgresSuites({ root, env: ENV });
    assert.deepEqual(problems, []);
    assert.deepEqual(
      files.map(({ passed, total }) => [passed, total]),
      [
        [2, 2],
        [2, 2],
      ],
    );
  });

  it("fails without the database variable", () => {
    writeReport();
    const { problems } = checkPostgresSuites({ root, env: {} });
    assert.equal(problems.length, 1);
    assert.match(problems[0], new RegExp(`${DATABASE_ENV} is not set`));
  });

  it("fails when a Postgres suite or section was skipped", () => {
    writeReport({
      "apps/api/src/store.pg.test.ts": [
        assertion("store writes", "skipped"),
        assertion("store reads", "skipped"),
      ],
      "apps/api/src/handler.test.ts": [
        assertion("handler parses"),
        assertion("handler persists", "skipped"),
      ],
    });
    const { problems } = checkPostgresSuites({ root, env: ENV });
    assert.equal(problems.length, 3);
    assert.ok(problems.every((problem) => problem.endsWith("is skipped.")));
  });

  it("fails on todo, pending and failed Postgres tests", () => {
    writeReport({
      "apps/api/src/store.pg.test.ts": [
        assertion("store writes", "todo"),
        assertion("store reads", "failed"),
      ],
      "apps/api/src/handler.test.ts": [assertion("handler parses", "pending")],
    });
    const { problems } = checkPostgresSuites({ root, env: ENV });
    assert.deepEqual(
      problems.map((problem) => problem.split(" is ")[1]),
      ["pending.", "todo.", "failed."],
    );
  });

  it("ignores skipped tests outside the Postgres files", () => {
    writeReport({ "apps/api/src/plain.test.ts": [assertion("plain formats", "skipped")] });
    assert.deepEqual(checkPostgresSuites({ root, env: ENV }).problems, []);
  });

  it("fails when a Postgres file is missing from the report or has no tests", () => {
    writeReport({ "apps/api/src/store.pg.test.ts": null, "apps/api/src/handler.test.ts": [] });
    const { problems } = checkPostgresSuites({ root, env: ENV });
    assert.equal(problems.length, 2);
    assert.match(problems[0], /handler\.test\.ts: the report lists no tests/);
    assert.match(problems[1], /store\.pg\.test\.ts: not in the Vitest report/);
  });

  it("fails when the workspace wrote no report", () => {
    const { problems } = checkPostgresSuites({ root, env: ENV });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /no readable Vitest JSON report/);
  });

  it("fails when no Postgres test file exists at all", () => {
    rmSync(join(root, "apps/api/src"), { recursive: true });
    const { problems } = checkPostgresSuites({ root, env: ENV });
    assert.deepEqual(problems, [
      "no Postgres test files were found; the discovery rules no longer match.",
    ]);
  });

  it("finds the Postgres suites and sections of this repository", () => {
    const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const found = findPostgresTestFiles(repository).map(({ file }) => file);
    assert.ok(found.some((file) => /\.pg\.test\.ts$/.test(file)));
    // Sections inside ordinary test files, found through the variable.
    assert.ok(found.some((file) => !/\.pg\.test\.ts$/.test(file)));
  });
});
