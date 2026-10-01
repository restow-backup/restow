import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildRules,
  checkEeManifests,
  checkLicenseFields,
  checkRedistributedBinaries,
  classifyLicenses,
  isWorkspacePackage,
  judgeLicense,
  parseSpdx,
  workspaceDirs,
} from "./check-licenses.mjs";

const policy = {
  allowed: {
    MIT: { copyleft: "none", reason: "permissive" },
    "Apache-2.0": { copyleft: "none", reason: "permissive" },
    ISC: { copyleft: "none", reason: "permissive" },
    "MPL-2.0": { copyleft: "file", reason: "weak copyleft" },
    "OFL-1.1": { copyleft: "font", reason: "fonts" },
  },
  denied: {
    GPL: "strong copyleft",
    LGPL: "library copyleft",
    AGPL: "network copyleft",
    SSPL: "server side",
    EUPL: "copyleft",
  },
  overrides: {},
};
const rules = buildRules(policy);

const pkg = (name, ...versions) => ({
  name,
  versions,
  paths: versions.map((v) => `/repo/node_modules/.pnpm/${name}@${v}/node_modules/${name}`),
});

test("parses plain ids, operators, parentheses, a plus sign and WITH", () => {
  assert.deepEqual(parseSpdx("MIT"), { op: "license", id: "MIT" });
  assert.deepEqual(parseSpdx("EUPL-1.1+"), { op: "license", id: "EUPL-1.1" });
  assert.deepEqual(parseSpdx("(MIT OR CC0-1.0)"), {
    op: "or",
    nodes: [
      { op: "license", id: "MIT" },
      { op: "license", id: "CC0-1.0" },
    ],
  });
  // AND binds tighter than OR.
  assert.deepEqual(parseSpdx("MIT OR ISC AND Apache-2.0"), {
    op: "or",
    nodes: [
      { op: "license", id: "MIT" },
      {
        op: "and",
        nodes: [
          { op: "license", id: "ISC" },
          { op: "license", id: "Apache-2.0" },
        ],
      },
    ],
  });
  assert.deepEqual(parseSpdx("GPL-2.0-only WITH Classpath-exception-2.0"), {
    op: "license",
    id: "GPL-2.0-only",
    exception: "Classpath-exception-2.0",
  });
  assert.deepEqual(parseSpdx("mit or isc").op, "or");
});

test("rejects text that is not an SPDX expression", () => {
  for (const text of [
    "SEE LICENSE IN LICENSE.md",
    "Custom: https://example.com/license",
    "(MIT",
    "MIT)",
    "MIT OR",
    "AND MIT",
    "",
    "MIT WITH",
  ]) {
    assert.throws(() => parseSpdx(text), undefined, text);
  }
});

test("allows an allowed license and an AND of allowed licenses", () => {
  for (const expression of ["MIT", "mit", "Apache-2.0", "MIT AND ISC", "(MIT AND ISC)"]) {
    const judged = judgeLicense(expression, rules);
    assert.equal(judged.ok, true, expression);
  }
});

test("an OR expression passes when one alternative is allowed and names the elected one", () => {
  const judged = judgeLicense("(MIT OR EUPL-1.1+)", rules);
  assert.equal(judged.ok, true);
  assert.deepEqual(judged.used, ["MIT"]);
  assert.deepEqual(
    judged.passedOver.map((entry) => entry.id),
    ["EUPL-1.1"],
  );
  assert.equal(judgeLicense("GPL-3.0-only OR Apache-2.0", rules).ok, true);
});

test("an AND expression needs every part, an OR of bad licenses fails", () => {
  assert.equal(judgeLicense("MIT AND GPL-3.0-only", rules).ok, false);
  const both = judgeLicense("GPL-3.0-only OR AGPL-3.0-only", rules);
  assert.equal(both.ok, false);
  assert.equal(both.status, "denied");
});

test("fails GPL, LGPL, AGPL, SSPL and EUPL in every spelling", () => {
  for (const id of [
    "GPL-2.0",
    "GPL-2.0-only",
    "GPL-3.0-or-later",
    "GPL-2.0+",
    "GPL-2.0-only WITH Classpath-exception-2.0",
    "LGPL-2.1",
    "LGPL-3.0-or-later",
    "AGPL-3.0-only",
    "AGPL-3.0",
    "SSPL-1.0",
    "EUPL-1.1",
    "EUPL-1.2",
    "gpl-3.0",
  ]) {
    const judged = judgeLicense(id, rules);
    assert.equal(judged.ok, false, id);
    assert.equal(judged.status, "denied", id);
  }
});

test("a denied family wins over an allowlist entry", () => {
  const mistaken = buildRules({
    ...policy,
    allowed: { ...policy.allowed, "GPL-3.0": { copyleft: "none", reason: "typo" } },
  });
  assert.equal(judgeLicense("GPL-3.0", mistaken).status, "denied");
});

test("fails an unknown license, a missing field and free text", () => {
  for (const text of [
    "UNLICENSED",
    "Unknown",
    "WTFPL",
    "SEE LICENSE IN LICENSE.md",
    "Custom: https://example.com",
    "BSD",
  ]) {
    const judged = judgeLicense(text, rules);
    assert.equal(judged.ok, false, text);
    assert.equal(judged.status, "unknown", text);
  }
});

test("strict mode (ee/) refuses every copyleft, weak or not", () => {
  assert.equal(judgeLicense("MPL-2.0", rules).ok, true);
  assert.equal(judgeLicense("OFL-1.1", rules).ok, true);
  for (const id of ["MPL-2.0", "OFL-1.1"]) {
    const judged = judgeLicense(id, rules, true);
    assert.equal(judged.ok, false, id);
    assert.equal(judged.status, "copyleft", id);
  }
  assert.equal(judgeLicense("MIT", rules, true).ok, true);
  // An alternative without copyleft is enough.
  assert.equal(judgeLicense("MPL-2.0 OR MIT", rules, true).ok, true);
});

test("sorts a report into allowed, denied, copyleft and unknown", () => {
  const report = {
    MIT: [{ name: "a", versions: ["1.0.0"] }],
    "MPL-2.0": [{ name: "c", versions: ["3.0.0"] }],
    "GPL-3.0": [{ name: "d", versions: ["4.0.0", "4.1.0"] }],
    "(MIT OR EUPL-1.1+)": [{ name: "e", versions: ["5.0.0"] }],
    "SEE LICENSE IN LICENSE": [{ name: "f", versions: ["6.0.0"] }],
  };
  const core = classifyLicenses(report, policy);
  assert.deepEqual(
    core.allowed.map((entry) => entry.license),
    ["(MIT OR EUPL-1.1+)", "MIT", "MPL-2.0"],
  );
  assert.deepEqual(core.denied, [
    {
      license: "GPL-3.0",
      packages: ["d@4.0.0", "d@4.1.0"],
      overridden: [],
      used: [],
      passedOver: [],
      reason: "GPL-3.0: strong copyleft",
    },
  ]);
  assert.deepEqual(
    core.unknown.map((entry) => entry.license),
    ["SEE LICENSE IN LICENSE"],
  );
  assert.deepEqual(core.copyleft, []);

  const ee = classifyLicenses(report, policy, { strict: true });
  assert.deepEqual(
    ee.copyleft.map((entry) => entry.license),
    ["MPL-2.0"],
  );
  assert.deepEqual(
    ee.allowed.map((entry) => entry.license),
    ["(MIT OR EUPL-1.1+)", "MIT"],
  );
});

test("an empty report passes", () => {
  const result = classifyLicenses({}, policy);
  assert.equal(result.denied.length + result.unknown.length + result.copyleft.length, 0);
});

test("workspace packages are not dependencies", () => {
  assert.equal(isWorkspacePackage({ name: "@restow/core", paths: ["/repo/packages/core"] }), true);
  assert.equal(isWorkspacePackage(pkg("left-pad", "1.0.0")), false);
  assert.equal(isWorkspacePackage({ name: "x" }), false);
  const result = classifyLicenses(
    { "SEE LICENSE IN ../LICENSE": [{ name: "@restow/ee-api", paths: ["/repo/ee/api"] }] },
    policy,
  );
  assert.equal(result.unknown.length, 0);
});

test("an override replaces the license of exactly that version", () => {
  const withOverride = {
    ...policy,
    overrides: { "odd@1.0.0": { license: "MIT", reason: "LICENSE file checked by hand" } },
  };
  const report = {
    "SEE LICENSE IN LICENSE": [
      { name: "odd", versions: ["1.0.0", "2.0.0"] },
      { name: "other", versions: ["1.0.0"] },
    ],
  };
  const result = classifyLicenses(report, withOverride);
  assert.deepEqual(result.allowed[0].packages, ["odd@1.0.0"]);
  assert.deepEqual(result.allowed[0].overridden, ["odd@1.0.0"]);
  assert.deepEqual(result.unknown[0].packages, ["odd@2.0.0", "other@1.0.0"]);
});

test("the ee/ manifests may not hide dependencies in optional or peer fields", () => {
  assert.deepEqual(
    checkEeManifests([
      { dir: "ee/api", manifest: { dependencies: { hono: "^4" } } },
      { dir: "ee/web", manifest: { optionalDependencies: {}, peerDependencies: undefined } },
    ]),
    [],
  );
  const problems = checkEeManifests([
    {
      dir: "ee/api",
      manifest: { optionalDependencies: { fsevents: "^2" }, peerDependencies: { react: "^19" } },
    },
  ]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /ee\/api\/package\.json declares optionalDependencies \(fsevents\)/);
  assert.match(problems[1], /peerDependencies \(react\)/);
});

test("the license field is Apache-2.0 for the core and points to ee/LICENSE for ee/", () => {
  assert.deepEqual(
    checkLicenseFields([
      { dir: "", manifest: { license: "Apache-2.0" } },
      { dir: "apps/api", manifest: { license: "Apache-2.0" } },
      { dir: "ee/api", manifest: { license: "SEE LICENSE IN ../LICENSE" } },
    ]),
    [],
  );
  const problems = checkLicenseFields([
    { dir: "packages/core", manifest: { license: "AGPL-3.0-only" } },
    { dir: "apps/web", manifest: {} },
    { dir: "ee/web", manifest: { license: "Apache-2.0" } },
    { dir: "", manifest: { license: "MIT" } },
  ]);
  assert.equal(problems.length, 4);
  assert.match(problems[0], /^packages\/core\/package\.json: "license" is "AGPL-3\.0-only"/);
  assert.match(problems[3], /^package\.json: /);
});

test("reads the workspace directories from pnpm-workspace.yaml", () => {
  const root = mkdtempSync(join(tmpdir(), "restow-licenses-"));
  try {
    for (const dir of ["apps/api", "apps/web", "packages/core", "ee/api", "deploy/demo/seed"]) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "package.json"), "{}");
    }
    mkdirSync(join(root, "apps/no-manifest"), { recursive: true });
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      [
        "packages:",
        "  - apps/*",
        "  - packages/*",
        "  # a comment",
        "  - ee/*",
        "  - deploy/demo/seed",
        "  - 'gone/*'",
        "",
      ].join("\n"),
    );
    assert.deepEqual(workspaceDirs(root).sort(), [
      "",
      "apps/api",
      "apps/web",
      "deploy/demo/seed",
      "ee/api",
      "packages/core",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the shipped policy: every allowed license has a reason and the denied families are all there", () => {
  const shipped = JSON.parse(
    readFileSync(fileURLToPath(new URL("./license-policy.json", import.meta.url)), "utf8"),
  );
  assert.deepEqual(Object.keys(shipped.denied).sort(), ["AGPL", "EUPL", "GPL", "LGPL", "SSPL"]);
  for (const id of [
    "MIT",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "Apache-2.0",
    "ISC",
    "MPL-2.0",
    "OFL-1.1",
    "CC0-1.0",
    "Unlicense",
    "0BSD",
    "MIT-0",
    "BlueOak-1.0.0",
  ]) {
    assert.ok(shipped.allowed[id], `${id} is allowed`);
  }
  for (const [id, entry] of Object.entries(shipped.allowed)) {
    assert.ok(entry.reason.length > 10, `${id} has a reason`);
    assert.ok(["none", "file", "font"].includes(entry.copyleft), `${id} names its copyleft`);
  }
  // Only the copyleft-free licenses are allowed in ee/.
  assert.equal(shipped.allowed.MIT.copyleft, "none");
  assert.notEqual(shipped.allowed["MPL-2.0"].copyleft, "none");
  assert.notEqual(shipped.allowed["OFL-1.1"].copyleft, "none");
  // The dual licenses found in the tree today, under the real policy.
  const shippedRules = buildRules(shipped);
  for (const expression of [
    "(MIT OR EUPL-1.1+)",
    "(MIT OR CC0-1.0)",
    "MIT AND ISC",
    "MIT OR Apache-2.0",
  ]) {
    assert.equal(judgeLicense(expression, shippedRules, true).ok, true, expression);
  }
  assert.equal(judgeLicense("GPL-3.0-only", shippedRules).ok, false);
  assert.equal(judgeLicense("CC-BY-4.0", shippedRules).ok, false);
});

test("a redistributed binary's modules need a copyleft-free license or a named exception", () => {
  const module = (path, license, version = "v1.0.0") => ({ path, version, license });
  const binaries = {
    restic: {
      modules: [
        module("example.com/mit", "MIT"),
        module("example.com/mixed", "Apache-2.0 AND MIT"),
        module("example.com/lru", "MPL-2.0"),
        module("example.com/fonts", "OFL-1.1"),
        module("example.com/gpl", "GPL-3.0-only"),
        module("example.com/odd", "WTFPL"),
      ],
      exceptions: { "example.com/lru": { license: "MPL-2.0", reason: "unmodified" } },
    },
  };
  const result = checkRedistributedBinaries(binaries, policy);
  assert.equal(result.checked, 6);
  assert.deepEqual(result.excepted, ["restic: example.com/lru@v1.0.0 (MPL-2.0)"]);
  // MPL is allowed in the core's npm graph, but in a redistributed binary only by name;
  // other copyleft, a denied and an unknown license fail.
  assert.equal(result.problems.length, 3);
  assert.match(result.problems[0], /example\.com\/fonts@v1\.0\.0 .*copyleft/);
  assert.match(result.problems[1], /example\.com\/gpl@v1\.0\.0 .*denied/);
  assert.match(result.problems[2], /example\.com\/odd@v1\.0\.0 .*unknown/);
});

test("an exception is for that module, with that license, in that binary only", () => {
  const lru = { path: "example.com/lru", version: "v2.0.7", license: "MPL-2.0" };
  const exceptions = { "example.com/lru": { license: "MPL-2.0", reason: "unmodified" } };
  // The same module in another binary without the exception fails.
  const other = checkRedistributedBinaries(
    { restic: { modules: [lru], exceptions }, other: { modules: [lru], exceptions: {} } },
    policy,
  );
  assert.equal(other.problems.length, 1);
  assert.match(other.problems[0], /^other: example\.com\/lru@v2\.0\.7/);
  // A module whose license changed is no longer covered.
  const changed = checkRedistributedBinaries(
    { restic: { modules: [{ ...lru, license: "MPL-2.0 AND MIT" }], exceptions } },
    policy,
  );
  assert.match(changed.problems[0], /its exception allows "MPL-2\.0"/);
  // An exception nothing needs any more is reported.
  const stale = checkRedistributedBinaries({ restic: { modules: [], exceptions } }, policy);
  assert.match(stale.problems[0], /not needed any more/);
});

test("the shipped policy allows the restic modules: MPL-2.0 only for golang-lru, nothing else with copyleft", () => {
  const shipped = JSON.parse(
    readFileSync(fileURLToPath(new URL("./license-policy.json", import.meta.url)), "utf8"),
  );
  const restic = shipped.redistributedBinaries.restic;
  assert.deepEqual(Object.keys(restic.exceptions), ["github.com/hashicorp/golang-lru/v2"]);
  assert.equal(restic.exceptions["github.com/hashicorp/golang-lru/v2"].license, "MPL-2.0");
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../${restic.modules}`, import.meta.url)), "utf8"),
  );
  const result = checkRedistributedBinaries(
    { restic: { modules: manifest.modules, exceptions: restic.exceptions } },
    shipped,
  );
  assert.deepEqual(result.problems, []);
  assert.equal(result.checked, manifest.modules.length);
  assert.equal(result.excepted.length, 1);
});
