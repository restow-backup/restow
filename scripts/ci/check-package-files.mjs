#!/usr/bin/env node
/**
 * Repository guard: test files and test data must not ship in the packages that
 * `pnpm deploy --prod` copies into the application image.
 *
 * `pnpm deploy` copies each workspace dependency the way `npm pack` would: only
 * what the package's `files` list names. `@restow/core` listed its whole `src`
 * folder, so the deployed image carried every `*.test.ts`, the test doubles in
 * `testing/` folders, the JSON fixtures and the Outlook `.msg` files under
 * `src/mailfiles/testdata` (third-party test data with a license of its own).
 * The runtime only loads `dist`. The apps themselves (`@restow/api`, `@restow/worker`,
 * `@restow/scheduler`) had no `files` list and shipped their `src` folder and every
 * compiled test (`*.test.js` under `dist`) as well.
 *
 * This asks npm for the file list of each package (`npm pack --dry-run`, the
 * same packlist pnpm uses) and fails when it holds a test file (`*.test.*`) or
 * a folder named `testdata`, `testing`, `fixtures`, `__tests__`, `__snapshots__`
 * or `test-results`. A module that is merely called `testing.ts` is code and is
 * not flagged: only folders are. Run standalone or via `pnpm lint`.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * The workspace packages the image deploys with a `files` list of their own: the three
 * server roles (`pnpm deploy` copies each app the same way) and the packages they take
 * along. The apps ship `dist` only; scripts/docker/check-image-tree.mjs checks the
 * built image for tests and TypeScript sources once more.
 */
export const PACKAGES = [
  "apps/api",
  "apps/worker",
  "apps/scheduler",
  "packages/core",
  "packages/cli",
  "packages/i18n",
];

const TEST_FOLDERS = new Set([
  "testdata",
  "testing",
  "fixtures",
  "__tests__",
  "__snapshots__",
  "test-results",
]);

/** The files `npm pack` would put in the package at `dir`, as paths relative to it. */
export function listPackedFiles(dir) {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const [pack] = JSON.parse(output);
  return pack.files.map((file) => file.path);
}

/** Why a packed path is a test file or test data, or null when it is neither. */
export function testFileReason(path) {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? "";
  if (/\.test\./.test(name)) {
    return "a test file";
  }
  const folder = segments.slice(0, -1).find((segment) => TEST_FOLDERS.has(segment));
  return folder ? `inside a ${folder} folder` : null;
}

/** Every packed path that is a test file or test data: `{ file, reason }`. */
export function findShippedTestFiles(files) {
  const found = [];
  for (const file of files) {
    const reason = testFileReason(file);
    if (reason) {
      found.push({ file, reason });
    }
  }
  return found;
}

/** Check the packages; returns the findings as `{ pkg, file, reason }`. */
export function checkPackages(packages = PACKAGES, root = ROOT) {
  const findings = [];
  for (const pkg of packages) {
    for (const found of findShippedTestFiles(listPackedFiles(resolve(root, pkg)))) {
      findings.push({ pkg, ...found });
    }
  }
  return findings;
}

function main() {
  const findings = checkPackages();
  if (findings.length === 0) {
    console.log(`check-package-files: ${PACKAGES.length} packages ship no test files.`);
    return;
  }
  console.error(
    "check-package-files: test files or test data would ship in the deployed image.\n" +
      "Narrow the package's `files` list (a `!` entry excludes a pattern):\n",
  );
  for (const { pkg, file, reason } of findings.slice(0, 50)) {
    console.error(`  ${pkg}: ${file} (${reason})`);
  }
  if (findings.length > 50) {
    console.error(`  ... and ${findings.length - 50} more`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
