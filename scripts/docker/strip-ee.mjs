#!/usr/bin/env node
/**
 * Turns a copy of this workspace into the Community build: the Apache-2.0 core
 * without the Business and Service Provider modules (docs/CI.md, "Two build
 * targets"). The Dockerfile's `build-community` stage runs it after
 * `pnpm install` and before `pnpm -r build`:
 *
 *   1. every designated loader (ALLOWED_LOADERS of scripts/ci/check-ee-boundary.mjs,
 *      the only core files allowed to import from ee/) becomes an empty module,
 *      so the core's extension registries stay empty;
 *   2. every Tailwind `@source` line of a core stylesheet that points into ee/
 *      (apps/web/src/index.css scans the ee/ web sources for class names) is removed;
 *   3. the top-level ee/ directory is deleted;
 *   4. the result is checked: no file of apps/ or packages/ imports from ee/ and
 *      no stylesheet points into it.
 *
 * Everything is checked before anything is changed. A loader that is missing (a
 * renamed loader), a core file other than a loader that imports from ee/, or a
 * stylesheet that reaches ee/ in a way this script cannot remove stops it with
 * exit code 1 and leaves the tree untouched, so a Community build can never ship
 * ee/ code by accident.
 *
 *   node scripts/docker/strip-ee.mjs              strip the workspace this script lives in
 *   node scripts/docker/strip-ee.mjs --root DIR   strip another tree
 *   node scripts/docker/strip-ee.mjs --check      only check that the tree can be stripped
 *
 * It deletes ee/: run it in a build stage or a throwaway copy, never in a working copy.
 * Node built-ins only (it runs in the Node base image before the build).
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED_LOADERS, findViolations } from "../ci/check-ee-boundary.mjs";

const DEFAULT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** What every loader becomes: a module that registers nothing. */
export const LOADER_STUB = `/**
 * Community build: this build carries no Business or Service Provider modules.
 * scripts/docker/strip-ee.mjs replaced the loader with this empty module, so the
 * extension points of the core stay empty.
 */
export {};
`;

/** At-rules of a stylesheet that name a path: `@source "..."`, `@import "..."` and the like. */
const CSS_PATH_RULE = /^\s*@([a-z-]+)\s+(?:not\s+)?(?:url\()?["']([^"']+)["']\)?[^;]*;\s*$/;

const IGNORED_DIR_NAMES = new Set(["node_modules", "dist", "test-results", ".git"]);

export class StripError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`strip-ee: the tree cannot be stripped:\n  - ${problems.join("\n  - ")}`);
    this.name = "StripError";
    this.problems = problems;
  }
}

function toPosix(path) {
  return path.split(sep).join("/");
}

/** Whether `target` is the top-level ee/ directory of `root` or inside it. */
function insideEe(root, target) {
  const rel = toPosix(relative(resolve(root, "ee"), target));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

/** Every `.css` file under apps/ and packages/, relative to `root`. */
function listStylesheets(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIR_NAMES.has(entry.name)) {
          walk(resolve(dir, entry.name));
        }
      } else if (entry.isFile() && entry.name.endsWith(".css")) {
        files.push(toPosix(relative(root, resolve(dir, entry.name))));
      }
    }
  };
  for (const top of ["apps", "packages"]) {
    const dir = resolve(root, top);
    if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      walk(dir);
    }
  }
  return files.sort();
}

/**
 * The lines of each core stylesheet that point into ee/. `@source` lines can be
 * removed (they only widen Tailwind's class scan); anything else that reaches
 * ee/ (an `@import`, for example) is a problem this script does not solve.
 */
function stylesheetEdits(root, problems) {
  const edits = [];
  for (const file of listStylesheets(root)) {
    const lines = readFileSync(resolve(root, file), "utf8").split("\n");
    const remove = [];
    lines.forEach((line, index) => {
      const match = CSS_PATH_RULE.exec(line);
      if (!match) {
        return;
      }
      const [, rule, path] = match;
      if (!path.startsWith(".") || !insideEe(root, resolve(root, dirname(file), path))) {
        return;
      }
      if (rule === "source") {
        remove.push(index);
      } else {
        problems.push(`${file}:${index + 1} reaches ee/ with @${rule}, which cannot be stripped`);
      }
    });
    if (remove.length > 0) {
      edits.push({ file, lines, remove });
    }
  }
  return edits;
}

/**
 * Check the tree and work out what stripping changes, without changing anything.
 * Throws a StripError listing every problem.
 */
export async function planStrip(root = DEFAULT_ROOT) {
  const problems = [];
  const loaders = [...ALLOWED_LOADERS].sort();
  for (const loader of loaders) {
    if (!statSync(resolve(root, loader), { throwIfNoEntry: false })?.isFile()) {
      problems.push(
        `the ee/ loader ${loader} is missing; a renamed loader must be renamed in ALLOWED_LOADERS (scripts/ci/check-ee-boundary.mjs) too`,
      );
    }
  }
  for (const { file, specifier } of await findViolations(root)) {
    problems.push(`${file} imports "${specifier}" from ee/ but is not a designated loader`);
  }
  const stylesheets = stylesheetEdits(root, problems);
  if (problems.length > 0) {
    throw new StripError(problems);
  }
  return {
    loaders,
    stylesheets: stylesheets.map(({ file, lines, remove }) => ({
      file,
      removed: remove.map((index) => lines[index].trim()),
    })),
    eeDirectory: existsSync(resolve(root, "ee")),
    edits: stylesheets,
  };
}

/** Strip the tree (see the header). Returns what was changed. */
export async function stripEe(root = DEFAULT_ROOT) {
  const plan = await planStrip(root);
  for (const loader of plan.loaders) {
    writeFileSync(resolve(root, loader), LOADER_STUB);
  }
  for (const { file, lines, remove } of plan.edits) {
    const drop = new Set(remove);
    writeFileSync(resolve(root, file), lines.filter((_, index) => !drop.has(index)).join("\n"));
  }
  rmSync(resolve(root, "ee"), { recursive: true, force: true });

  // The result: nothing of the core reaches ee/ any more, and ee/ is gone.
  const problems = [];
  if (existsSync(resolve(root, "ee"))) {
    problems.push("ee/ still exists after it was removed");
  }
  for (const loader of plan.loaders) {
    if (readFileSync(resolve(root, loader), "utf8") !== LOADER_STUB) {
      problems.push(`${loader} is not the empty loader`);
    }
  }
  for (const { file, specifier } of await findViolations(root)) {
    problems.push(`${file} still imports "${specifier}" from ee/`);
  }
  stylesheetEdits(root, problems);
  if (problems.length > 0) {
    throw new StripError(problems);
  }
  return plan;
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--root needs a directory");
      }
      options.root = resolve(value);
      index += 1;
    } else if (arg === "--check") {
      options.check = true;
    } else {
      throw new Error(`unknown option ${arg} (usage: strip-ee.mjs [--root DIR] [--check])`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const plan = options.check ? await planStrip(options.root) : await stripEe(options.root);
  const verb = options.check ? "would replace" : "replaced";
  console.log(`strip-ee: ${verb} ${plan.loaders.length} loaders with an empty module:`);
  for (const loader of plan.loaders) {
    console.log(`  ${loader}`);
  }
  for (const { file, removed } of plan.stylesheets) {
    for (const line of removed) {
      console.log(`strip-ee: ${options.check ? "would remove" : "removed"} ${file}: ${line}`);
    }
  }
  console.log(
    plan.eeDirectory
      ? `strip-ee: ${options.check ? "would remove" : "removed"} ee/`
      : "strip-ee: there was no ee/ directory",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
