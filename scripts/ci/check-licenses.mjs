#!/usr/bin/env node
/**
 * Dependency license check (CI). Reads the licenses of every production
 * dependency (`pnpm licenses list --json --prod`) and compares them with the
 * allowlist in scripts/ci/license-policy.json:
 *
 *   allowed   MIT, BSD, Apache-2.0, ISC, MPL-2.0, OFL-1.1, CC0-1.0, Unlicense and the
 *             permissive equivalents listed in the policy, each with its reason
 *   denied    GPL, LGPL, AGPL, SSPL and EUPL (also as an alternative of "A OR B" when no
 *             other alternative is allowed): fails
 *   unknown   anything else, including a missing or invalid license field: fails
 *
 * The packages of the ee/ workspaces (ee/LICENSE) must additionally be free of copyleft
 * of any kind, so MPL-2.0 and OFL-1.1 are not allowed there. Their dependencies are read
 * with `--no-optional`: optional packages (platform binaries, optional peers that pnpm
 * resolves from the workspace root) are not installed for them. The ee/ manifests may
 * not declare optionalDependencies or peerDependencies, so nothing hides behind that
 * flag. What ee/ reaches through the @restow/* workspace packages is covered by the
 * check of the whole repository.
 *
 * The license field of every workspace package.json is checked too: the core says
 * Apache-2.0, ee/* point to ee/LICENSE.
 *
 * Third-party programs Restow redistributes as separate binaries (restic) are checked
 * module by module ("redistributedBinaries" in the policy): every Go module compiled
 * into the binary (the vendored list, licenses/restic-deps/modules.json) needs a license
 * of the allowlist without copyleft, or an exception that names the module and its
 * license for that binary only (today: the MPL-2.0 module github.com/hashicorp/golang-lru/v2
 * in restic). An exception no module needs any more fails too, so the list stays honest.
 *
 * Usage: node scripts/ci/check-licenses.mjs [licenses.json] [--ee ee-licenses.json]
 * Without arguments it runs pnpm itself. With a file it checks that file only (and the
 * ee/ list when --ee is given), which is what the tests and offline runs use.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const POLICY_PATH = fileURLToPath(new URL("./license-policy.json", import.meta.url));

export const CORE_LICENSE_FIELD = "Apache-2.0";
export const EE_LICENSE_FIELD = "SEE LICENSE IN ../LICENSE";

const OPERATORS = new Set(["AND", "OR", "WITH"]);

/**
 * Pure: parse an SPDX license expression into a tree of
 * {op: "license", id, exception?} | {op: "and"|"or", nodes}. Throws on anything that is
 * not an expression (for example "SEE LICENSE IN LICENSE.md" or "Custom: ...").
 */
export function parseSpdx(expression) {
  const tokens = String(expression).match(/\(|\)|[^\s()]+/g) ?? [];
  let pos = 0;
  const isOperator = (token, name) => token !== undefined && token.toUpperCase() === name;

  function parseList(name, parseOperand) {
    const nodes = [parseOperand()];
    while (isOperator(tokens[pos], name)) {
      pos += 1;
      nodes.push(parseOperand());
    }
    return nodes.length === 1 ? nodes[0] : { op: name.toLowerCase(), nodes };
  }

  function parseTerm() {
    const token = tokens[pos];
    pos += 1;
    if (token === undefined) {
      throw new Error("the expression ends early");
    }
    if (token === "(") {
      const inner = parseList("OR", () => parseList("AND", parseTerm));
      if (tokens[pos] !== ")") {
        throw new Error("a parenthesis is not closed");
      }
      pos += 1;
      return inner;
    }
    if (token === ")" || OPERATORS.has(token.toUpperCase())) {
      throw new Error(`unexpected "${token}"`);
    }
    if (!/^[A-Za-z0-9.\-:_+]+$/.test(token)) {
      throw new Error(`"${token}" is not a license identifier`);
    }
    const node = { op: "license", id: token.replace(/\+$/, "") };
    if (isOperator(tokens[pos], "WITH")) {
      pos += 1;
      const exception = tokens[pos];
      pos += 1;
      if (exception === undefined || exception === "(" || exception === ")") {
        throw new Error("WITH needs an exception identifier");
      }
      node.exception = exception;
    }
    return node;
  }

  const tree = parseList("OR", () => parseList("AND", parseTerm));
  if (pos !== tokens.length) {
    throw new Error(`unexpected "${tokens[pos]}"`);
  }
  return tree;
}

/** Pure: the lookup tables for a policy. Identifiers compare case-insensitively. */
export function buildRules(policy) {
  const allowed = new Map(
    Object.entries(policy.allowed ?? {}).map(([id, info]) => [id.toLowerCase(), { id, ...info }]),
  );
  const denied = Object.entries(policy.denied ?? {}).map(([family, reason]) => ({
    family,
    reason,
    pattern: new RegExp(`^${family.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|-)`),
  }));
  return { allowed, denied };
}

/**
 * Pure: how one license identifier stands. Denied families are checked first, so a
 * policy entry can never allow GPL-3.0 by mistake ("GPL-2.0-only", "GPL-3.0-or-later"
 * and the old "GPL-2.0+" all belong to the family GPL, "LGPL-3.0" to LGPL).
 */
export function classifyId(id, rules, strict) {
  const key = id.toLowerCase();
  const family = rules.denied.find((entry) => entry.pattern.test(key));
  if (family) {
    return { id, status: "denied", reason: family.reason };
  }
  const entry = rules.allowed.get(key);
  if (!entry) {
    return { id, status: "unknown", reason: "not in the allowlist" };
  }
  if (strict && entry.copyleft !== "none") {
    return { id, status: "copyleft", reason: `copyleft (${entry.copyleft}) is not allowed in ee/` };
  }
  return { id, status: "allowed", reason: entry.reason };
}

/**
 * Pure: evaluate a parsed expression. "A OR B" is fine when one alternative is (the
 * first such alternative is elected, the others are reported as `passed over`), "A AND B"
 * needs both.
 */
function evaluate(node, rules, strict) {
  if (node.op === "license") {
    const found = classifyId(node.id, rules, strict);
    return found.status === "allowed"
      ? { ok: true, used: [node.id], passedOver: [], rejected: [] }
      : { ok: false, used: [], passedOver: [], rejected: [found] };
  }
  const parts = node.nodes.map((child) => evaluate(child, rules, strict));
  if (node.op === "and") {
    const ok = parts.every((part) => part.ok);
    return {
      ok,
      used: ok ? parts.flatMap((part) => part.used) : [],
      passedOver: parts.flatMap((part) => part.passedOver),
      rejected: parts.flatMap((part) => part.rejected),
    };
  }
  const elected = parts.find((part) => part.ok);
  if (elected) {
    return {
      ok: true,
      used: elected.used,
      passedOver: [
        ...elected.passedOver,
        ...parts.filter((part) => part !== elected).flatMap((part) => part.rejected),
      ],
      rejected: [],
    };
  }
  return { ok: false, used: [], passedOver: [], rejected: parts.flatMap((part) => part.rejected) };
}

/** Pure: judge one license string of a package: {ok, status, used, passedOver, rejected, reason}. */
export function judgeLicense(expression, rules, strict = false) {
  let tree;
  try {
    tree = parseSpdx(expression);
  } catch (error) {
    return {
      ok: false,
      status: "unknown",
      used: [],
      passedOver: [],
      rejected: [],
      reason: `not an SPDX license expression (${error.message})`,
    };
  }
  const result = evaluate(tree, rules, strict);
  if (result.ok) {
    return { ...result, status: "allowed", reason: "" };
  }
  const status = ["denied", "copyleft", "unknown"].find((candidate) =>
    result.rejected.some((entry) => entry.status === candidate),
  );
  return {
    ...result,
    status,
    reason: result.rejected.map((entry) => `${entry.id}: ${entry.reason}`).join("; "),
  };
}

/** Pure: a workspace package (no node_modules segment in any of its paths) is not a dependency. */
export function isWorkspacePackage(pkg) {
  const paths = pkg.paths ?? [];
  return (
    paths.length > 0 && paths.every((path) => !String(path).split(/[\\/]/).includes("node_modules"))
  );
}

/**
 * Pure: classify every package of a `pnpm licenses list --json` result. `strict` is the
 * ee/ mode (no copyleft). Returns the groups `allowed`, `denied`, `copyleft` and
 * `unknown`; each entry is {license, packages, used, passedOver, reason}. `used` is the
 * license the package is taken under (the elected alternative of an OR expression).
 */
export function classifyLicenses(report, policy, { strict = false } = {}) {
  const rules = buildRules(policy);
  const overrides = policy.overrides ?? {};
  const groups = new Map();
  for (const [reported, packages] of Object.entries(report)) {
    for (const pkg of packages) {
      if (isWorkspacePackage(pkg)) {
        continue;
      }
      for (const version of pkg.versions?.length ? pkg.versions : [""]) {
        const label = version ? `${pkg.name}@${version}` : pkg.name;
        const override = overrides[label];
        const license = override?.license ?? reported;
        const entry = groups.get(license) ?? { license, packages: [], overridden: [] };
        entry.packages.push(label);
        if (override) {
          entry.overridden.push(label);
        }
        groups.set(license, entry);
      }
    }
  }
  const result = { allowed: [], denied: [], copyleft: [], unknown: [] };
  for (const entry of groups.values()) {
    const judged = judgeLicense(entry.license, rules, strict);
    result[judged.ok ? "allowed" : judged.status].push({
      license: entry.license,
      packages: entry.packages.sort(),
      overridden: entry.overridden,
      used: judged.used,
      passedOver: judged.passedOver,
      reason: judged.reason,
    });
  }
  for (const list of Object.values(result)) {
    list.sort((a, b) => a.license.localeCompare(b.license));
  }
  return result;
}

/**
 * Pure: the modules of each redistributed binary against the policy. `binaries` is
 * {name: {modules: [{path, version, license}], exceptions: {path: {license, reason}}}}.
 * Returns {checked, excepted: [label], problems: [text]}.
 */
export function checkRedistributedBinaries(binaries, policy) {
  const rules = buildRules(policy);
  const result = { checked: 0, excepted: [], problems: [] };
  for (const [name, binary] of Object.entries(binaries)) {
    const exceptions = binary.exceptions ?? {};
    const used = new Set();
    for (const module of binary.modules) {
      result.checked += 1;
      const label = `${module.path}@${module.version}`;
      const exception = exceptions[module.path];
      if (exception) {
        used.add(module.path);
        if (exception.license !== module.license) {
          result.problems.push(
            `${name}: ${label} is licensed ${JSON.stringify(module.license)}, its exception allows ${JSON.stringify(exception.license)}`,
          );
        } else if (judgeLicense(module.license, rules, false).status === "denied") {
          result.problems.push(`${name}: ${label} is licensed ${module.license}, which is denied`);
        } else {
          result.excepted.push(`${name}: ${label} (${module.license})`);
        }
        continue;
      }
      // Without an exception a module of a redistributed binary must be free of copyleft.
      const judged = judgeLicense(module.license, rules, true);
      if (!judged.ok) {
        result.problems.push(
          `${name}: ${label} is licensed ${JSON.stringify(module.license)}: ${judged.status} (${judged.reason})`,
        );
      }
    }
    for (const path of Object.keys(exceptions)) {
      if (!used.has(path)) {
        result.problems.push(
          `${name}: the exception for ${path} is not needed any more (no such module); remove it from scripts/ci/license-policy.json`,
        );
      }
    }
  }
  return result;
}

/** The redistributed binaries of the policy with their vendored module lists. */
function readRedistributedBinaries(policy, root) {
  const binaries = {};
  for (const [name, entry] of Object.entries(policy.redistributedBinaries ?? {})) {
    if (name.startsWith("$")) {
      continue;
    }
    const file = join(root, entry.modules);
    if (!existsSync(file)) {
      throw new Error(`${entry.modules} (the modules of ${name}) is missing`);
    }
    binaries[name] = {
      modules: JSON.parse(readFileSync(file, "utf8")).modules,
      exceptions: entry.exceptions ?? {},
    };
  }
  return binaries;
}

/**
 * Pure: problems with the ee/ manifests that would let a dependency slip past the
 * `--no-optional` listing: optionalDependencies and peerDependencies of any kind.
 * `entries` is [{dir, manifest}].
 */
export function checkEeManifests(entries) {
  const problems = [];
  for (const { dir, manifest } of entries) {
    for (const field of ["optionalDependencies", "peerDependencies"]) {
      const names = Object.keys(manifest[field] ?? {});
      if (names.length > 0) {
        problems.push(
          `${dir}/package.json declares ${field} (${names.join(", ")}); ee/ packages may only use dependencies, so the license check can see all of them`,
        );
      }
    }
  }
  return problems;
}

/**
 * Pure: the license field of every workspace package.json. `entries` is
 * [{dir, manifest}] where dir is relative to the repository root ("" for the root).
 */
export function checkLicenseFields(entries) {
  const problems = [];
  for (const { dir, manifest } of entries) {
    const isEe = dir === "ee" || dir.startsWith("ee/");
    const expected = isEe ? EE_LICENSE_FIELD : CORE_LICENSE_FIELD;
    if (manifest.license !== expected) {
      problems.push(
        `${dir ? `${dir}/` : ""}package.json: "license" is ${JSON.stringify(manifest.license)}, expected ${JSON.stringify(expected)}`,
      );
    }
  }
  return problems;
}

/** The directories named by pnpm-workspace.yaml (single-level `dir/*` patterns and plain paths). */
export function workspaceDirs(root) {
  const file = join(root, "pnpm-workspace.yaml");
  if (!existsSync(file)) {
    return [];
  }
  const dirs = [""];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*-\s+["']?([^"'\s#]+)["']?\s*(?:#.*)?$/.exec(line);
    if (!match) {
      continue;
    }
    const pattern = match[1].replace(/\/$/, "");
    if (pattern.endsWith("/*")) {
      const parent = pattern.slice(0, -2);
      const base = join(root, parent);
      if (existsSync(base)) {
        for (const entry of readdirSync(base, { withFileTypes: true })) {
          if (entry.isDirectory() && existsSync(join(base, entry.name, "package.json"))) {
            dirs.push(`${parent}/${entry.name}`);
          }
        }
      }
    } else if (existsSync(join(root, pattern, "package.json"))) {
      dirs.push(pattern);
    }
  }
  return dirs;
}

function readManifests(root) {
  return workspaceDirs(root).map((dir) => ({
    dir,
    manifest: JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")),
  }));
}

function runPnpm(args) {
  try {
    return execFileSync("pnpm", args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.replace(/\s+/g, " ").trim();
    console.error(
      `::error::pnpm ${args.join(" ")} failed${detail ? `: ${detail}` : ""}. Are the dependencies installed and pnpm-lock.yaml up to date with every workspace (pnpm install)?`,
    );
    process.exit(1);
  }
}

function count(list) {
  return list.reduce((sum, entry) => sum + entry.packages.length, 0);
}

/** Print one result block; returns the number of failures. */
function report(title, result) {
  console.log(
    `check-licenses: ${title}: ${count(result.allowed)} allowed in ${result.allowed.length} license groups, ${count(result.denied)} denied, ${count(result.copyleft)} copyleft, ${count(result.unknown)} unknown`,
  );
  for (const entry of result.allowed) {
    if (entry.passedOver.length > 0) {
      console.log(
        `  ${entry.license}: used under ${entry.used.join(", ")}, not under ${entry.passedOver.map((rejected) => rejected.id).join(", ")} (${entry.packages.join(", ")})`,
      );
    }
    if (entry.overridden.length > 0) {
      console.log(
        `  ${entry.license}: set by the overrides of scripts/ci/license-policy.json for ${entry.overridden.join(", ")}`,
      );
    }
  }
  const failures = [
    ["denied", result.denied],
    ["copyleft", result.copyleft],
    ["unknown", result.unknown],
  ];
  let failed = 0;
  for (const [kind, entries] of failures) {
    for (const entry of entries) {
      failed += entry.packages.length;
      console.error(
        `::error::${title}: license ${JSON.stringify(entry.license)} is ${kind} (${entry.reason}): ${entry.packages.join(", ")}`,
      );
    }
  }
  return failed;
}

function parseArgs(argv) {
  const args = { core: undefined, ee: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--ee") {
      args.ee = argv[index + 1];
      index += 1;
    } else {
      args.core = argv[index];
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = JSON.parse(readFileSync(POLICY_PATH, "utf8"));
  const offline = args.core !== undefined;
  let failures = 0;

  const manifests = readManifests(ROOT);
  const fieldProblems = checkLicenseFields(manifests);
  for (const problem of fieldProblems) {
    console.error(`::error::${problem}`);
  }
  failures += fieldProblems.length;

  const coreRaw = args.core
    ? readFileSync(args.core, "utf8")
    : runPnpm(["licenses", "list", "--json", "--prod"]);
  failures += report("all workspaces", classifyLicenses(JSON.parse(coreRaw), policy));

  const eeManifests = manifests.filter((entry) => entry.dir.startsWith("ee/"));
  if (eeManifests.length === 0) {
    console.log("check-licenses: ee/: no ee/ workspace in this tree, nothing to check");
  } else if (offline && !args.ee) {
    console.log("check-licenses: ee/: skipped (offline run without --ee)");
  } else {
    const eeProblems = checkEeManifests(eeManifests);
    for (const problem of eeProblems) {
      console.error(`::error::${problem}`);
    }
    failures += eeProblems.length;
    const eeRaw = args.ee
      ? readFileSync(args.ee, "utf8")
      : runPnpm(["licenses", "list", "--json", "--prod", "--no-optional", "--filter", "./ee/*"]);
    failures += report(
      "ee/ (no copyleft)",
      classifyLicenses(JSON.parse(eeRaw), policy, { strict: true }),
    );
  }

  const redistributed = checkRedistributedBinaries(readRedistributedBinaries(policy, ROOT), policy);
  console.log(
    `check-licenses: redistributed binaries: ${redistributed.checked} compiled-in modules, ${redistributed.excepted.length} allowed by a named exception (${redistributed.excepted.join(", ") || "none"}), ${redistributed.problems.length} problems`,
  );
  for (const problem of redistributed.problems) {
    console.error(`::error::${problem}`);
  }
  failures += redistributed.problems.length;

  if (failures > 0) {
    console.error(
      "check-licenses: failed. A new license needs a decision: add it to scripts/ci/license-policy.json with its reason, or replace the dependency.",
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
