#!/usr/bin/env node
/**
 * Release gate (release workflow, first job): the tag is a release tag, the
 * version in package.json matches it, and CHANGELOG.md has a finished section
 * with a real date for it. Prints the Docker tags and channel the version
 * gets; with --github-output they are also written to $GITHUB_OUTPUT.
 *
 * Usage: node scripts/ci/check-release.mjs --tag v0.1.0
 *          [--package package.json] [--changelog CHANGELOG.md]
 *          [--today YYYY-MM-DD] [--github-output <file>]
 */
import { appendFileSync, readFileSync } from "node:fs";
import { validateRelease } from "./release-lib.mjs";

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) {
    return fallback;
  }
  return process.argv[at + 1];
}

function main() {
  const tag = argument("tag");
  if (!tag) {
    console.error("check-release: --tag is required");
    process.exit(2);
  }
  const packagePath = argument("package", "package.json");
  const changelogPath = argument("changelog", "CHANGELOG.md");
  const today = argument("today", new Date().toISOString().slice(0, 10));
  const packageVersion = JSON.parse(readFileSync(packagePath, "utf8")).version;
  const changelog = readFileSync(changelogPath, "utf8");

  const result = validateRelease({ tag, packageVersion, changelog, today });
  for (const warning of result.warnings) {
    console.log(`::warning::${warning}`);
  }
  for (const error of result.errors) {
    console.error(`::error::${error}`);
  }
  if (result.errors.length > 0) {
    process.exit(1);
  }
  console.log(`check-release: ${tag} is releasable (channel ${result.channel})`);
  console.log(`check-release: Docker tags ${result.tags.join(", ")}`);

  const outputFile = argument("github-output");
  if (outputFile) {
    appendFileSync(
      outputFile,
      [
        `version=${result.parsed.version}`,
        `channel=${result.channel}`,
        `tags=${result.tags.join(",")}`,
        `prerelease=${result.parsed.prerelease ? "true" : "false"}`,
        "",
      ].join("\n"),
    );
  }
}

main();
