#!/usr/bin/env node
/**
 * Repository guard: the former product name must not come back.
 *
 * The product was renamed (the clean break of 2026-09-30) and nothing that
 * ships may name the old product any more: not a comment, a test fixture, a
 * document or a path. This fails when a tracked file (or an untracked one that
 * is not ignored, so a new file is caught before its first commit) contains
 * the former name, in any letter case, or has it in its path. Binary files are
 * skipped, the way git decides what is binary (a NUL byte near the start).
 *
 * The word is assembled from parts below, so this file does not match itself,
 * and its test builds the word the same way. Neither file name carries the
 * word (`check-legacy-name`), and `package.json` refers to the script by that
 * plain name. The contents of every file are always read, the guard's own
 * included. Run standalone or via `pnpm lint`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** The forbidden word, built so that this source does not contain it. */
const WORD = ["os", "iris"].join("");
const PATTERN = new RegExp(WORD, "i");

/**
 * The guard's own files. Their paths are exempt from the path check, a safeguard
 * for the day one of them is renamed to a name that carries the word; their
 * contents are still checked.
 */
export const GUARD_PATHS = new Set([
  "scripts/ci/check-legacy-name.mjs",
  "scripts/ci/check-legacy-name.test.mjs",
]);

/** How much of a file git looks at to decide that it is binary. */
const BINARY_SNIFF_BYTES = 8000;

/** Longest excerpt of a matching line printed in the report. */
const EXCERPT_LENGTH = 140;

/** Tracked files plus untracked files that are not ignored, as repository-relative paths. */
export function listRepositoryFiles(root = ROOT) {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return [...new Set(output.split("\0").filter(Boolean))].sort();
}

function isBinary(buffer) {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

function excerpt(line) {
  const text = line.trim();
  return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}...` : text;
}

/**
 * Every place that names the former product: `{ file, line, text }` for a
 * line of content (`line` is 1-based), `{ file, line: 0, text: "(path)" }` for
 * a path. A path git lists but the working tree no longer has (deleted, not
 * yet committed) is skipped.
 */
export function findViolations(root = ROOT, files = listRepositoryFiles(root)) {
  const violations = [];
  for (const file of files) {
    const path = resolve(root, file);
    if (!existsSync(path) || !statSync(path).isFile()) {
      continue;
    }
    const guardFile = GUARD_PATHS.has(file);
    if (!guardFile && PATTERN.test(file)) {
      violations.push({ file, line: 0, text: "(path)" });
    }
    const buffer = readFileSync(path);
    if (isBinary(buffer)) {
      continue;
    }
    const lines = buffer.toString("utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (PATTERN.test(line)) {
        violations.push({ file, line: index + 1, text: excerpt(line) });
      }
    });
  }
  return violations;
}

function main() {
  const violations = findViolations();
  if (violations.length === 0) {
    console.log("check-legacy-name: no tracked file or path names the former product.");
    return;
  }
  console.error("check-legacy-name: the former product name is back:");
  for (const { file, line, text } of violations) {
    console.error(line > 0 ? `  ${file}:${line}: ${text}` : `  ${file} ${text}`);
  }
  console.error(
    "\nThe product is called Restow. Rename the identifier, text or file; " +
      "a user-visible name comes from the branding ({appName}), never from a literal.",
  );
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
