#!/usr/bin/env node
/**
 * CI guard: every Postgres-backed test ran and passed, none was skipped.
 *
 * The Postgres suites (`*.pg.test.ts`) and the Postgres sections of other test
 * files run only when RESTOW_TEST_DATABASE_URL points at a Postgres server and
 * skip themselves otherwise. A skipped suite still reports green, so this guard
 * fails the job when
 *   - RESTOW_TEST_DATABASE_URL is not set,
 *   - a workspace holding Postgres tests wrote no Vitest JSON report,
 *   - a Postgres test file is missing from its workspace's report or has no tests, or
 *   - any test in a Postgres test file did not pass (skipped, todo, pending, failed).
 *
 * Postgres test files are found from the source rather than from a list, so a
 * new suite is covered without touching this script: a test file named
 * `*.pg.test.*`, or one that reads RESTOW_TEST_DATABASE_URL itself or through
 * a relative import (a shared fixture module, for example).
 *
 * The reports are written by `pnpm test:ci` (Vitest's JSON reporter, one
 * `test-results/vitest.json` per workspace). The self-test lives next to this
 * file: `node --test scripts/ci/assert-pg-suites.test.mjs`.
 *
 * Usage: node scripts/ci/assert-pg-suites.mjs [--root <repository root>]
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DATABASE_ENV = "RESTOW_TEST_DATABASE_URL";
export const REPORT_FILE = join("test-results", "vitest.json");

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const POSTGRES_TEST_FILE = /\.pg\.test\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", "test-results"]);
// `from "./x.js"`, `import "./x.js"` and `import("./x.js")`, relative specifiers only.
const RELATIVE_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Workspace directories from pnpm-workspace.yaml (plain `dir` and `dir/*` entries). */
export function listWorkspaces(root) {
  const manifest = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const patterns = [...manifest.matchAll(/^\s*-\s*["']?([^"'\s#]+)["']?\s*$/gm)].map(
    (match) => match[1],
  );
  const workspaces = [];
  for (const pattern of patterns) {
    if (pattern.endsWith("/*")) {
      const parent = join(root, pattern.slice(0, -2));
      if (!existsSync(parent)) {
        continue;
      }
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        const candidate = join(parent, entry.name);
        if (entry.isDirectory() && existsSync(join(candidate, "package.json"))) {
          workspaces.push(candidate);
        }
      }
    } else if (!pattern.includes("*")) {
      if (existsSync(join(root, pattern, "package.json"))) {
        workspaces.push(join(root, pattern));
      }
    } else {
      throw new Error(`unsupported workspace pattern in pnpm-workspace.yaml: ${pattern}`);
    }
  }
  return workspaces.sort();
}

function walk(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
        walk(join(directory, entry.name), files);
      }
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

/** Resolve a relative import the way the TypeScript sources write it (`./x.js` is `./x.ts`). */
function resolveImport(fromFile, specifier) {
  const target = resolve(dirname(fromFile), specifier);
  const withoutExtension = target.replace(/\.[cm]?[jt]sx?$/, "");
  const candidates = [
    ...RESOLVE_EXTENSIONS.map((extension) => withoutExtension + extension),
    target,
    ...RESOLVE_EXTENSIONS.map((extension) => join(target, `index${extension}`)),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

/** Reads source files once and answers which ones reach the database variable. */
class ImportGraph {
  #modules = new Map();
  #reaches = new Map();

  #module(file) {
    let module = this.#modules.get(file);
    if (!module) {
      const source = readFileSync(file, "utf8");
      const imports = [];
      for (const match of source.matchAll(RELATIVE_IMPORT)) {
        const imported = resolveImport(file, match[1]);
        if (imported) {
          imports.push(imported);
        }
      }
      module = { readsEnv: source.includes(DATABASE_ENV), imports };
      this.#modules.set(file, module);
    }
    return module;
  }

  /** True when `file`, or a module it imports relatively (at any depth), reads the variable. */
  readsDatabaseEnv(file) {
    const known = this.#reaches.get(file);
    if (known !== undefined) {
      return known;
    }
    const visited = new Set([file]);
    const pending = [file];
    while (pending.length > 0) {
      const current = pending.pop();
      if (this.#reaches.get(current) === true || this.#module(current).readsEnv) {
        this.#reaches.set(file, true);
        return true;
      }
      for (const imported of this.#module(current).imports) {
        if (!visited.has(imported)) {
          visited.add(imported);
          pending.push(imported);
        }
      }
    }
    // Nothing reachable from `file` reads it, so nothing reachable from any visited module does.
    for (const module of visited) {
      this.#reaches.set(module, false);
    }
    return false;
  }
}

/** Every test file that is (or contains) a Postgres suite, with its workspace. */
export function findPostgresTestFiles(root) {
  const graph = new ImportGraph();
  const found = [];
  for (const workspace of listWorkspaces(root)) {
    for (const file of walk(workspace)) {
      if (!TEST_FILE.test(file)) {
        continue;
      }
      if (POSTGRES_TEST_FILE.test(file) || graph.readsDatabaseEnv(file)) {
        found.push({ workspace, file });
      }
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function readReport(path) {
  try {
    return { report: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Check the Postgres test files against the Vitest reports. Returns one entry
 * per file (with its passed-test count) and the list of problems; an empty
 * problem list means every Postgres test ran and passed.
 */
export function checkPostgresSuites({ root, env = process.env }) {
  const problems = [];
  if (!env[DATABASE_ENV]) {
    problems.push(
      `${DATABASE_ENV} is not set: every Postgres suite and section skips itself without it.`,
    );
  }

  const files = findPostgresTestFiles(root);
  if (files.length === 0) {
    problems.push("no Postgres test files were found; the discovery rules no longer match.");
  }

  const reports = new Map();
  const results = [];
  for (const { workspace, file } of files) {
    const shown = relative(root, file);
    if (!reports.has(workspace)) {
      const path = join(workspace, REPORT_FILE);
      const loaded = existsSync(path) ? readReport(path) : { error: "missing" };
      if (loaded.error) {
        problems.push(
          `${relative(root, path)}: no readable Vitest JSON report (${loaded.error}); run the tests with \`pnpm test:ci\`.`,
        );
      }
      const byFile = new Map(
        (loaded.report?.testResults ?? []).map((result) => [canonical(result.name), result]),
      );
      reports.set(workspace, { available: !loaded.error, byFile });
    }
    const { available, byFile } = reports.get(workspace);
    if (!available) {
      continue;
    }
    const result = byFile.get(canonical(file));
    if (!result) {
      problems.push(`${shown}: not in the Vitest report, so it did not run.`);
      continue;
    }
    const assertions = result.assertionResults ?? [];
    if (assertions.length === 0) {
      problems.push(`${shown}: the report lists no tests for this file.`);
    }
    let passed = 0;
    for (const assertion of assertions) {
      if (assertion.status === "passed") {
        passed += 1;
      } else {
        problems.push(`${shown}: "${assertion.fullName}" is ${assertion.status}.`);
      }
    }
    results.push({ file: shown, passed, total: assertions.length });
  }
  return { files: results, problems };
}

function main(argv) {
  const rootFlag = argv.indexOf("--root");
  const root =
    rootFlag >= 0 && argv[rootFlag + 1]
      ? resolve(argv[rootFlag + 1])
      : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

  const { files, problems } = checkPostgresSuites({ root });
  for (const { file, passed, total } of files) {
    console.log(
      `${passed === total && total > 0 ? "ok  " : "FAIL"}  ${file}  (${passed}/${total})`,
    );
  }
  if (problems.length > 0) {
    console.error(`\nPostgres suites incomplete (${problems.length} problem(s)):`);
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    return 1;
  }
  const tests = files.reduce((sum, { passed }) => sum + passed, 0);
  console.log(`\n${files.length} Postgres test files, ${tests} tests passed, none skipped.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
