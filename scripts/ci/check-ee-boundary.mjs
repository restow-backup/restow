#!/usr/bin/env node
/**
 * Import-direction lint: no file under apps/ or packages/ may import from
 * ee/ (dependencies run one way only: ee/ imports the core, see ee/README.md).
 * The one exception is exactly one designated loader file per app, which imports the
 * ee/ entry of that app and registers it with the app's extension points
 * (ee/README.md). Everything else in the core reaches ee/ code only through
 * those extension points (`apps/api/src/extensions.ts`,
 * `apps/worker/src/extensions.ts`, `apps/web/src/lib/extensions.tsx`).
 * The other direction, ee/ importing the core, is allowed and not checked.
 *
 * A source file "imports from ee/" when a static or dynamic import
 * specifier is a relative path that resolves into the top-level `ee/`
 * directory, or names an `@restow/ee-*` package. Run standalone
 * (`node scripts/ci/check-ee-boundary.mjs`) or via `pnpm lint`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Files allowed to import from ee/: the designated loader of each app. */
export const ALLOWED_LOADERS = new Set([
  "apps/api/src/ee.ts",
  "apps/worker/src/ee.ts",
  "apps/web/src/features/ee.ts",
]);

const IGNORED_DIR_NAMES = new Set(["node_modules", "dist", "test-results", ".git"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

const IMPORT_PATTERN = /(?:from\s+|import\(|require\()\s*["']([^"']+)["']/g;

function importsEe(specifier) {
  return specifier.startsWith("@restow/ee-") || /(^|\/)\.\.\/(?:\.\.\/)*ee\//.test(specifier);
}

/** Every `.ts`/`.tsx` file under `apps/` or `packages/`, as paths relative to `root`. */
function listSourceFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIR_NAMES.has(entry.name)) {
          walk(resolve(dir, entry.name));
        }
        continue;
      }
      const ext = entry.name.slice(entry.name.lastIndexOf("."));
      if (SOURCE_EXTENSIONS.has(ext)) {
        files.push(relative(root, resolve(dir, entry.name)).split("\\").join("/"));
      }
    }
  };
  for (const top of ["apps", "packages"]) {
    const dir = resolve(root, top);
    if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      walk(dir);
    }
  }
  return files;
}

export async function findViolations(root = ROOT) {
  const violations = [];
  for (const relPath of listSourceFiles(root)) {
    if (ALLOWED_LOADERS.has(relPath)) {
      continue;
    }
    const content = readFileSync(resolve(root, relPath), "utf8");
    for (const match of content.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1];
      if (importsEe(specifier)) {
        violations.push({ file: relPath, specifier });
      }
    }
  }
  return violations;
}

async function main() {
  const violations = await findViolations();
  if (violations.length === 0) {
    console.log("check-ee-boundary: no core file imports from ee/.");
    return;
  }
  console.error("check-ee-boundary: core files must not import from ee/:");
  for (const { file, specifier } of violations) {
    console.error(`  ${relative(ROOT, resolve(ROOT, file))}: "${specifier}"`);
  }
  console.error(
    "\nReach ee/ code through the app's extension points (apps/api/src/extensions.ts, " +
      "apps/worker/src/extensions.ts, apps/web/src/lib/extensions.tsx) instead; only the one " +
      "loader file per app in ALLOWED_LOADERS may import ee/ (see ee/README.md).",
  );
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
