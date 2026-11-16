#!/usr/bin/env node
/**
 * Repository guard: every promise in the claims register is bound to a test.
 *
 * `docs/CLAIMS.md` lists what Restow says about its own behaviour, one entry per
 * claim under a heading `### <AREA>-<NNN>`, with the fields `Aussage`, `Fundstelle`,
 * `Öffentliche Seite`, `Tests`, `Belegt gegen` and `Stand`. A test proves a claim by
 * carrying its ID:
 *
 *   - vitest and node:test files (`*.test.ts`, `*.test.mjs`, ...): `[READY-001]` in the
 *     title of the test or of its `describe`;
 *   - Go: a comment `// claim: READY-001` in the comment block directly above the
 *     `func Test...`;
 *   - shell and PowerShell scripts, the smoke checks and the workflows: a comment
 *     `# claim: READY-001` (`// claim: ...` in JavaScript). Several IDs are separated
 *     by commas.
 *
 * The guard fails when
 *   - an entry is malformed (a field missing, an unknown `Stand`, an ID used twice),
 *   - a claim with `Stand: belegt` or `Stand: Abweichung` names no test,
 *   - a file named under `Tests` does not exist or does not carry the claim's ID,
 *   - a file carries a claim's ID and the entry does not name it,
 *   - a file carries an ID the register does not know,
 *   - an ID sits on a skipped test (`it.skip`, `it.todo`): a test that does not run
 *     proves nothing,
 *   - a claim is `belegt` and one of its tests is parked with `it.fails`,
 *   - a claim is `Abweichung` and none of its tests is parked with `it.fails`, or it
 *     lacks the fields `Erwartung` and `Abweichung`,
 *   - a claim is `nur behauptet` and lacks the field `Grund`, names a test, or a test
 *     carries its ID.
 *
 * `Stand: Abweichung` (the product does not do what the claim says; the failing
 * expectation is parked with `it.fails`, so the suite stays green and turns red the day
 * the product is fixed and the entry was not updated) and `Stand: nur behauptet` (no
 * test can be written here, with the reason) do not fail the guard: they are printed as
 * warnings with their count on every run, so they stay visible.
 *
 * Run standalone (`node scripts/ci/check-claims.mjs`) or via `pnpm lint`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const REGISTER_PATH = "docs/CLAIMS.md";

/** The guard's own files hold IDs as examples and are not searched. */
export const GUARD_PATHS = new Set([
  "scripts/ci/check-claims.mjs",
  "scripts/ci/check-claims.test.mjs",
]);

export const REQUIRED_FIELDS = [
  "Aussage",
  "Fundstelle",
  "Öffentliche Seite",
  "Tests",
  "Belegt gegen",
  "Stand",
];

export const STATES = ["belegt", "Abweichung", "nur behauptet"];

/** What `Belegt gegen` may start with; "nichts" only for `nur behauptet`. */
export const EVIDENCE_KINDS = ["Logik", "Simulator", "echtes System", "beides", "nichts"];

const ID = "[A-Z][A-Z0-9]*-\\d{3}";
const HEADING = new RegExp(`^###\\s+(${ID})\\s*$`);
const ANY_HEADING = /^#{1,6}\s/;
const FIELD = /^- ([^:]+):\s*(.*)$/;
const TITLE_TAG = new RegExp(`\\[(${ID})\\]`, "g");
const COMMENT_TAG = new RegExp(`(?:\\/\\/|#)\\s*claims?:\\s*(${ID}(?:\\s*,\\s*${ID})*)`, "g");
const ID_IN_LIST = new RegExp(ID, "g");

const JS_TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const GO_TEST_FILE = /_test\.go$/;
const SCRIPT_FILE = /\.(?:sh|ps1|t)$/;
const SMOKE_FILE = /^scripts\/(?:smoke|updater-e2e)\/.*\.m[jt]s$/;
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "test-results",
  "smoke-out",
  ".git",
]);

/** Whether a repository path is a file the guard searches for claim IDs. */
export function isSearchedFile(path) {
  if (GUARD_PATHS.has(path)) {
    return false;
  }
  return (
    JS_TEST_FILE.test(path) ||
    GO_TEST_FILE.test(path) ||
    SCRIPT_FILE.test(path) ||
    SMOKE_FILE.test(path) ||
    WORKFLOW_FILE.test(path)
  );
}

/** Every file below `root` as a repository-relative path (for a tree that is no git checkout). */
export function walkFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIR_NAMES.has(entry.name)) {
          walk(join(dir, entry.name));
        }
      } else if (entry.isFile()) {
        files.push(relative(root, join(dir, entry.name)).split("\\").join("/"));
      }
    }
  };
  walk(root);
  return files.sort();
}

/**
 * Tracked files plus untracked files that are not ignored, so a new test counts before
 * its first commit; the walked tree where git cannot answer.
 */
export function listRepositoryFiles(root = ROOT) {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return [...new Set(output.split("\0").filter(Boolean))]
      .filter((path) => statSync(join(root, path), { throwIfNoEntry: false })?.isFile())
      .sort();
  } catch {
    return walkFiles(root);
  }
}

/**
 * The entries of the register: `{ id, line, area, fields }`, with `fields` a Map from field
 * name to value. A field's value may continue on following lines indented by two spaces.
 * Problems of the form itself are returned as `errors`.
 */
export function parseRegister(text) {
  const claims = [];
  const errors = [];
  let current = null;
  let lastField = null;
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const heading = HEADING.exec(line);
    if (heading) {
      current = {
        id: heading[1],
        line: index + 1,
        area: heading[1].slice(0, heading[1].lastIndexOf("-")),
        fields: new Map(),
      };
      claims.push(current);
      lastField = null;
      continue;
    }
    if (ANY_HEADING.test(line)) {
      if (/^###\s/.test(line)) {
        errors.push(`line ${index + 1}: "${line.trim()}" is no claim ID (expected AREA-NNN)`);
      }
      current = null;
      lastField = null;
      continue;
    }
    if (!current) {
      continue;
    }
    const field = FIELD.exec(line);
    if (field) {
      const name = field[1].trim();
      if (current.fields.has(name)) {
        errors.push(`${current.id}: the field "${name}" is given twice`);
      }
      current.fields.set(name, field[2].trim());
      lastField = name;
      continue;
    }
    if (lastField && /^ {2,}\S/.test(line)) {
      current.fields.set(lastField, `${current.fields.get(lastField)} ${line.trim()}`.trim());
      continue;
    }
    if (line.trim() !== "") {
      lastField = null;
    }
  }
  const seen = new Set();
  for (const claim of claims) {
    if (seen.has(claim.id)) {
      errors.push(`${claim.id}: the ID is used twice (line ${claim.line})`);
    }
    seen.add(claim.id);
  }
  return { claims, errors };
}

/** The paths of a `Tests` field; "keine" (or an empty value) is no path. */
export function testPathsOf(value) {
  if (!value || /^keine\b/i.test(value.trim())) {
    return [];
  }
  return value
    .split(",")
    .map((part) => part.trim().replace(/^`|`$/g, ""))
    .filter(Boolean);
}

const TEST_CALL = /\b(?:it|test|describe)((?:\.\w+)*)\s*[(`]/;

/**
 * How the test a tag sits on is run: "fails" for a parked expectation (`it.fails`),
 * "skipped" for a test that never runs (`it.skip`, `it.todo`), else "runs". The call is
 * looked for on the tag's line and up to three lines above it (a wrapped call puts the
 * title on a line after `it.fails(`); `skipIf` and `runIf` are conditions, not skips.
 */
function runModeAt(lines, index) {
  for (let at = index; at >= Math.max(0, index - 3); at--) {
    const call = TEST_CALL.exec(lines[at]);
    if (!call) {
      continue;
    }
    const modifiers = call[1].split(".").filter(Boolean);
    if (modifiers.includes("fails")) {
      return "fails";
    }
    if (modifiers.includes("skip") || modifiers.includes("todo")) {
      return "skipped";
    }
    return "runs";
  }
  return "runs";
}

/** Whether the comment at `index` of a Go test file belongs to the block above a test function. */
function goCommentIsAboveTest(lines, index) {
  for (let next = index + 1; next < lines.length; next++) {
    const line = lines[next].trim();
    if (line.startsWith("//")) {
      continue;
    }
    return /^func Test\w*\(/.test(line);
  }
  return false;
}

/**
 * Every claim ID a file carries: `{ id, line, mode }` with `mode` "runs", "fails" or
 * "skipped", and `misplaced` for a Go comment that is not directly above a test function.
 * A vitest or node:test file carries an ID in a title (`[ID]`), every other file in a
 * comment (`claim: ID`).
 */
export function findTags(path, content) {
  const tags = [];
  const lines = content.split(/\r?\n/);
  const jsTest = JS_TEST_FILE.test(path);
  const goTest = GO_TEST_FILE.test(path);
  for (const [index, line] of lines.entries()) {
    if (jsTest) {
      for (const match of line.matchAll(TITLE_TAG)) {
        tags.push({ id: match[1], line: index + 1, mode: runModeAt(lines, index) });
      }
      continue;
    }
    for (const match of line.matchAll(COMMENT_TAG)) {
      for (const id of match[1].match(ID_IN_LIST) ?? []) {
        const tag = { id, line: index + 1, mode: "runs" };
        if (goTest && !goCommentIsAboveTest(lines, index)) {
          tag.misplaced = true;
        }
        tags.push(tag);
      }
    }
  }
  return tags;
}

/**
 * Check the register of the repository at `root` against the files that carry claim IDs.
 * Returns `{ claims, errors, warnings, summary }`; the tree passes when `errors` is empty.
 */
export function checkClaims(root = ROOT, options = {}) {
  const errors = [];
  const warnings = [];
  const registerFile = join(root, REGISTER_PATH);
  if (!existsSync(registerFile)) {
    return {
      claims: [],
      errors: [`${REGISTER_PATH} does not exist`],
      warnings,
      summary: { total: 0, byState: {}, byArea: {} },
    };
  }
  const { claims, errors: formErrors } = parseRegister(readFileSync(registerFile, "utf8"));
  errors.push(...formErrors);
  if (claims.length === 0) {
    errors.push(`${REGISTER_PATH} holds no claim (### AREA-NNN)`);
  }

  // Which file carries which ID, and how its test runs.
  const files = options.files ?? listRepositoryFiles(root);
  const tagsById = new Map();
  for (const path of files) {
    if (!isSearchedFile(path)) {
      continue;
    }
    for (const tag of findTags(path, readFileSync(join(root, path), "utf8"))) {
      if (tag.misplaced) {
        errors.push(
          `${path}:${tag.line}: the comment "claim: ${tag.id}" is not directly above a test function`,
        );
      }
      if (tag.mode === "skipped") {
        errors.push(
          `${path}:${tag.line}: ${tag.id} sits on a skipped test; a test that does not run proves nothing ` +
            "(park a failing expectation with it.fails and set Stand: Abweichung)",
        );
      }
      const list = tagsById.get(tag.id) ?? [];
      list.push({ ...tag, path });
      tagsById.set(tag.id, list);
    }
  }

  const known = new Set(claims.map((claim) => claim.id));
  for (const [id, tags] of tagsById) {
    if (!known.has(id)) {
      for (const tag of tags) {
        errors.push(`${tag.path}:${tag.line}: carries ${id}, which ${REGISTER_PATH} does not know`);
      }
    }
  }

  const summary = { total: claims.length, byState: {}, byArea: {} };
  for (const claim of claims) {
    const { id, fields } = claim;
    for (const name of REQUIRED_FIELDS) {
      if (!fields.get(name)) {
        errors.push(`${id}: the field "${name}" is missing or empty`);
      }
    }
    const state = fields.get("Stand") ?? "";
    if (state && !STATES.includes(state)) {
      errors.push(`${id}: Stand "${state}" is none of ${STATES.join(", ")}`);
    }
    const evidence = fields.get("Belegt gegen") ?? "";
    if (evidence && !EVIDENCE_KINDS.some((kind) => evidence.startsWith(kind))) {
      errors.push(`${id}: "Belegt gegen" must start with one of ${EVIDENCE_KINDS.join(", ")}`);
    }
    summary.byState[state] = (summary.byState[state] ?? 0) + 1;
    summary.byArea[claim.area] ??= { total: 0 };
    const area = summary.byArea[claim.area];
    area.total += 1;
    area[state] = (area[state] ?? 0) + 1;

    const listed = testPathsOf(fields.get("Tests"));
    const tags = tagsById.get(id) ?? [];
    const carrying = new Set(tags.map((tag) => tag.path));

    if (state === "nur behauptet") {
      if (!fields.get("Grund")) {
        errors.push(`${id}: Stand "nur behauptet" needs the field "Grund"`);
      }
      if (listed.length > 0) {
        errors.push(`${id}: Stand "nur behauptet" but "Tests" names a file; write "keine"`);
      }
      for (const tag of tags) {
        errors.push(`${tag.path}:${tag.line}: carries ${id}, whose Stand is "nur behauptet"`);
      }
      if (evidence && !evidence.startsWith("nichts")) {
        errors.push(`${id}: Stand "nur behauptet" is proven against "nichts"`);
      }
      warnings.push(`${id}: nur behauptet (${fields.get("Grund") ?? "no reason given"})`);
      continue;
    }

    if (evidence.startsWith("nichts")) {
      errors.push(`${id}: "Belegt gegen: nichts" is only for Stand "nur behauptet"`);
    }
    if (listed.length === 0) {
      errors.push(`${id}: no test proves this claim ("Tests" is empty)`);
    }
    for (const path of listed) {
      if (!existsSync(join(root, path))) {
        errors.push(`${id}: the test ${path} does not exist`);
      } else if (!isSearchedFile(path)) {
        errors.push(`${id}: ${path} is no test file the guard searches`);
      } else if (!carrying.has(path)) {
        errors.push(`${id}: ${path} does not carry the ID (expected [${id}] or "claim: ${id}")`);
      }
    }
    for (const path of carrying) {
      if (!listed.includes(path)) {
        errors.push(`${id}: ${path} carries the ID but the entry does not name it under "Tests"`);
      }
    }

    const parked = tags.filter((tag) => tag.mode === "fails");
    if (state === "belegt") {
      for (const tag of parked) {
        errors.push(
          `${tag.path}:${tag.line}: ${id} is "belegt" but this test is parked with it.fails ` +
            '(set Stand: Abweichung, or remove ".fails" once the product does what the claim says)',
        );
      }
    }
    if (state === "Abweichung") {
      for (const name of ["Erwartung", "Abweichung"]) {
        if (!fields.get(name)) {
          errors.push(`${id}: Stand "Abweichung" needs the field "${name}"`);
        }
      }
      if (parked.length === 0 && listed.length > 0) {
        errors.push(
          `${id}: Stand "Abweichung" but no test with its ID is parked with it.fails ` +
            "(the failing expectation must stay in the suite)",
        );
      }
      const where = parked.map((tag) => `${tag.path}:${tag.line}`).join(", ");
      warnings.push(`${id}: Abweichung, parked expectation in ${where || "no test"}`);
    }
  }

  return { claims, errors, warnings, summary };
}

function formatSummary(summary) {
  const lines = [];
  for (const area of Object.keys(summary.byArea).sort()) {
    const counts = summary.byArea[area];
    const rest = STATES.filter((state) => counts[state])
      .map((state) => `${counts[state]} ${state}`)
      .join(", ");
    lines.push(`  ${area.padEnd(8)} ${String(counts.total).padStart(3)}  (${rest})`);
  }
  return lines.join("\n");
}

function main() {
  const { errors, warnings, summary } = checkClaims();
  const annotate = process.env.GITHUB_ACTIONS === "true";
  if (errors.length > 0) {
    console.error(`check-claims: ${errors.length} problem(s) in ${REGISTER_PATH} or its tests:`);
    for (const error of errors) {
      console.error(`  ${error}`);
    }
    console.error(
      `\nEvery claim in ${REGISTER_PATH} needs a test that carries its ID, and every ID in a test ` +
        "needs its entry (see the head of the register).",
    );
    process.exitCode = 1;
    return;
  }
  const deviations = summary.byState.Abweichung ?? 0;
  const unproven = summary.byState["nur behauptet"] ?? 0;
  console.log(
    `check-claims: ${summary.total} claims, ${summary.byState.belegt ?? 0} belegt, ` +
      `${deviations} Abweichung, ${unproven} nur behauptet.`,
  );
  console.log(formatSummary(summary));
  if (warnings.length > 0) {
    console.log(
      `check-claims: ${warnings.length} warning(s): ${deviations} claim(s) the product does not ` +
        `keep, ${unproven} claim(s) without a test:`,
    );
    for (const warning of warnings) {
      console.log(`  ${warning}`);
    }
    if (annotate) {
      console.log(
        `::warning title=Claims register::${deviations} deviation(s), ${unproven} claim(s) ` +
          `without a test (${REGISTER_PATH})`,
      );
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
