#!/usr/bin/env node
/**
 * Looks into a built tree of an image (the /prod trees of the application image,
 * the web interface the edge serves from /srv) for code that must not ship:
 *
 *   - always: license signing code. The product only verifies license keys; keys
 *     are issued elsewhere and the private key never enters this repository
 *     (docs/CI.md, "Image assertions"). Flagged are files named like a key
 *     generator, the former issuer (license/cli.js, license/issue.js), the test
 *     signer of ee/licensing/testing, and, in first-party code, the names of the
 *     signing functions, the signing key file and the generation of an Ed25519
 *     key pair (the key type of license keys).
 *   - with `--variant community`: any code of ee/: a directory named `ee` in
 *     first-party code (dist/ee of the api and the worker), an `@restow/ee-*`
 *     package, a relative import or source map path into ee/.
 *   - with `--require-ee` (the full build): each named tree must hold the ee/
 *     modules, so a full image can never ship without them unnoticed.
 *   - always: tests and sources. The image runs the compiled `dist` of each
 *     package; test files (`*.test.*`, compiled ones and their source maps
 *     included), test folders (`testing`, `testdata`, `fixtures`, `__tests__`,
 *     `__snapshots__`, `test-results`) and TypeScript sources (`*.ts`, `*.tsx`,
 *     not the `*.d.ts` declarations) never ship. The `files` list of each
 *     deployed package keeps them out (scripts/ci/check-package-files.mjs).
 *
 * First-party code is everything outside node_modules plus the workspace
 * packages (`@restow/*`) inside it. Third-party packages are not searched for
 * these names: they use them for their own purposes (React lists the HTML
 * element `<keygen>`, TLS libraries create key pairs). `createPrivateKey` and
 * key pair generation in general are not flagged either: the product reads TLS
 * and Entra certificates with them.
 *
 *   node scripts/docker/check-image-tree.mjs [--variant full|community] [--require-ee] DIR...
 *
 * Exit code 1 with the findings. Node built-ins only: it runs in the Dockerfile's
 * build and deploy stages and, mounted read-only, inside the application image
 * (release smoke check 1).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** Content of first-party files that only license signing code has. */
export const SIGNING_MARKERS = [
  { pattern: /\bsignLicenseToken\b/, what: "the license signing function signLicenseToken" },
  { pattern: /\bissueLicenseToken\b/, what: "the license issuing function issueLicenseToken" },
  {
    pattern: /\bgenerateLicenseSigningKeyPair\b/,
    what: "the key pair generator of the former license issuer",
  },
  { pattern: /\b(?:runLicenseCli|LICENSE_CLI_USAGE)\b/, what: "the former license issuing CLI" },
  { pattern: /\bcreateTestLicenseSigner\b/, what: "the test license signer" },
  { pattern: /license-signing\.key/, what: "the license signing key file" },
  {
    pattern: /generateKeyPair(?:Sync)?\(\s*["'`]ed25519["'`]/,
    what: "Ed25519 key pair generation (the key type of license keys)",
  },
];

/** Names of first-party files that only license signing code has. */
export const SIGNING_FILES = [
  { pattern: /(^|\/)[^/]*keygen[^/]*$/i, what: "a key generator" },
  { pattern: /(^|\/)license\/(cli|issue)\.[cm]?js$/, what: "the former license issuer" },
  { pattern: /(^|\/)test-signer\.[cm]?[jt]s$/, what: "the test license signer" },
  { pattern: /(^|\/)license-signing\.key$/, what: "the license signing key" },
];

/** Content of first-party files that only ee/ code has (Community build). */
export const EE_MARKERS = [
  {
    pattern: /(?:\.\.\/)+ee\/(?:api|worker|web|licensing)\//,
    what: "a relative import or source path into ee/",
  },
  { pattern: /@restow\/ee-[a-z]/, what: "an @restow/ee-* package" },
];

/** First-party folders that only hold tests, test doubles or test data. */
export const TEST_FOLDERS = new Set([
  "testing",
  "testdata",
  "fixtures",
  "__tests__",
  "__snapshots__",
  "test-results",
]);

/** Names of first-party files that are tests or sources, never run in the image. */
export const SOURCE_FILES = [
  { pattern: /\.test\.[^/]*$/, what: "a test file" },
  {
    pattern: /^(?![^/]*\.d\.[cm]?ts$)[^/]*\.(?:[cm]?ts|tsx)$/,
    what: "a TypeScript source (the image runs the compiled dist)",
  },
];

const TEXT_EXTENSIONS = /\.(?:[cm]?js|[cm]?ts|tsx|jsx|json|map|html|css|txt|md)$/;
const MAX_TEXT_BYTES = 32 * 1024 * 1024;
/** Findings printed per tree; the rest is counted. */
const MAX_PRINTED = 50;

/**
 * Walk a tree and call `onFile(path, relPath)` for every first-party file and
 * `onDir(path, relPath, kind)` for every directory (`code`, `package` for a
 * workspace package in node_modules). Symbolic links are not followed: pnpm's
 * node_modules links point into node_modules/.pnpm, which is walked itself.
 */
function walk(root, { onFile, onDir }) {
  const visit = (dir, rel, mode) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const path = join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (mode === "code") {
        if (entry.isDirectory()) {
          if (entry.name === "node_modules") {
            visit(path, relPath, "modules");
          } else {
            onDir(path, relPath, "code", entry.name);
            visit(path, relPath, "code");
          }
        } else if (entry.isFile()) {
          onFile(path, relPath);
        }
      } else if (mode === "modules") {
        // A node_modules directory: only the pnpm store and the workspace scope.
        if (!entry.isDirectory()) {
          continue;
        }
        if (entry.name === ".pnpm") {
          visit(path, relPath, "store");
        } else if (entry.name === "@restow") {
          visit(path, relPath, "scope");
        }
      } else if (mode === "scope") {
        if (entry.isDirectory()) {
          onDir(path, relPath, "package", `@restow/${entry.name}`);
          visit(path, relPath, "code");
        }
      } else if (mode === "store") {
        // node_modules/.pnpm/<name@version>/node_modules/...
        if (entry.isDirectory()) {
          if (entry.name.startsWith("@restow+")) {
            onDir(path, relPath, "package", `@restow/${entry.name.slice(8).split("@")[0]}`);
          }
          visit(path, relPath, "container");
        }
      } else if (mode === "container") {
        if (entry.isDirectory() && entry.name === "node_modules") {
          visit(path, relPath, "modules");
        }
      }
    }
  };
  visit(root, "", "code");
}

function readText(path) {
  try {
    if (statSync(path).size > MAX_TEXT_BYTES) {
      return null;
    }
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Check one tree. Returns `{ findings, files, eeDirectories }`: what is wrong
 * (one line each), how many first-party files were looked at, and the
 * first-party `ee` directories found.
 */
export function scanTree(root, { variant = "full", requireEe = false } = {}) {
  const community = variant === "community";
  const findings = [];
  const eeDirectories = [];
  let files = 0;
  walk(root, {
    onDir(_path, relPath, kind, name) {
      if (kind === "code" && TEST_FOLDERS.has(name)) {
        findings.push(`${relPath}/: a test folder`);
      }
      if (kind === "code" && name === "ee") {
        eeDirectories.push(relPath);
        if (community) {
          findings.push(`${relPath}/: a directory of ee/ code`);
        }
      }
      if (kind === "package" && name.startsWith("@restow/ee-") && community) {
        findings.push(`${relPath}: the package ${name}`);
      }
    },
    onFile(path, relPath) {
      files += 1;
      for (const { pattern, what } of SIGNING_FILES) {
        if (pattern.test(relPath)) {
          findings.push(`${relPath}: ${what}`);
        }
      }
      for (const { pattern, what } of SOURCE_FILES) {
        if (pattern.test(basename(path))) {
          findings.push(`${relPath}: ${what}`);
        }
      }
      if (!TEXT_EXTENSIONS.test(basename(path))) {
        return;
      }
      const text = readText(path);
      if (text === null) {
        return;
      }
      for (const { pattern, what } of SIGNING_MARKERS) {
        if (pattern.test(text)) {
          findings.push(`${relPath}: ${what}`);
        }
      }
      if (community) {
        for (const { pattern, what } of EE_MARKERS) {
          if (pattern.test(text)) {
            findings.push(`${relPath}: ${what}`);
          }
        }
      }
    },
  });
  if (requireEe && eeDirectories.length === 0) {
    findings.push("no ee/ modules in this tree, but the full build must carry them");
  }
  return { findings, files, eeDirectories };
}

function parseArgs(argv) {
  const options = { variant: "full", requireEe: false, roots: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--variant") {
      options.variant = argv[index + 1];
      index += 1;
      if (options.variant !== "full" && options.variant !== "community") {
        throw new Error("--variant is full or community");
      }
    } else if (arg === "--require-ee") {
      options.requireEe = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      options.roots.push(resolve(arg));
    }
  }
  if (options.roots.length === 0) {
    throw new Error("usage: check-image-tree.mjs [--variant full|community] [--require-ee] DIR...");
  }
  if (options.requireEe && options.variant === "community") {
    throw new Error("--require-ee is for the full build");
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let failed = false;
  for (const root of options.roots) {
    if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      console.error(`check-image-tree: ${root} is not a directory`);
      failed = true;
      continue;
    }
    const { findings, files, eeDirectories } = scanTree(root, options);
    if (findings.length > 0) {
      failed = true;
      console.error(`check-image-tree: ${root} (${options.variant} build):`);
      for (const finding of findings.slice(0, MAX_PRINTED)) {
        console.error(`  ${finding}`);
      }
      if (findings.length > MAX_PRINTED) {
        console.error(`  ... and ${findings.length - MAX_PRINTED} more`);
      }
      continue;
    }
    const ee =
      options.variant === "community"
        ? "no ee/ code"
        : `${eeDirectories.length} ee/ module ${eeDirectories.length === 1 ? "directory" : "directories"}`;
    console.log(
      `check-image-tree: ${root}: ${files} first-party files, no license signing code, no tests or sources, ${ee}`,
    );
  }
  if (failed) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(`check-image-tree: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
}
