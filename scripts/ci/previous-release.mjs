#!/usr/bin/env node
/**
 * Prints the newest published stable release below a version, or nothing.
 * Reads the release tags, one per line, from standard input.
 *
 * Usage: gh release list --json tagName --jq '.[].tagName' \
 *          | node scripts/ci/previous-release.mjs --version 0.2.0
 */
import { readFileSync } from "node:fs";
import { previousRelease } from "./release-lib.mjs";

const at = process.argv.indexOf("--version");
const version = at === -1 ? undefined : process.argv[at + 1];
if (!version) {
  console.error("previous-release: --version is required");
  process.exit(2);
}
const tags = readFileSync(0, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0);
process.stdout.write(previousRelease(version, tags) ?? "");
