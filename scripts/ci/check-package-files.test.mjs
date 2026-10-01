/**
 * Self-test of the package file guard (scripts/ci, see its header):
 * `node --test scripts/ci/*.test.mjs`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const { PACKAGES, checkPackages, findShippedTestFiles, listPackedFiles, testFileReason } =
  await import(new URL("./check-package-files.mjs", import.meta.url).href);

let root;

function write(path, content = "x") {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function makePackage(name, files) {
  write(`${name}/package.json`, JSON.stringify({ name, version: "1.0.0", files }));
  write(`${name}/dist/index.js`);
  write(`${name}/src/index.ts`);
  write(`${name}/src/index.test.ts`);
  write(`${name}/src/feature/feature.pg.test.ts`);
  write(`${name}/src/feature/testing/fake.ts`);
  write(`${name}/src/feature/testing.ts`);
  write(`${name}/src/feature/testdata/mail.msg`);
  write(`${name}/src/feature/fixtures/data.json`);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "check-package-files-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("testFileReason", () => {
  it("flags test files and test folders, not modules that merely have the word in their name", () => {
    assert.equal(testFileReason("src/a/b.test.ts"), "a test file");
    assert.equal(testFileReason("dist/a/b.test.js.map"), "a test file");
    assert.equal(testFileReason("src/a/b.pg.test.ts"), "a test file");
    assert.equal(testFileReason("src/a/testdata/x.msg"), "inside a testdata folder");
    assert.equal(testFileReason("src/a/testing/fake.ts"), "inside a testing folder");
    assert.equal(testFileReason("src/a/fixtures/x.json"), "inside a fixtures folder");
    assert.equal(testFileReason("test-results/vitest.json"), "inside a test-results folder");
    // Code with the word in its name is not a test file.
    assert.equal(testFileReason("src/verify/testing.ts"), null);
    assert.equal(testFileReason("src/entra/app-test.ts"), null);
    assert.equal(testFileReason("src/endpoints/restore-test.ts"), null);
    assert.equal(testFileReason("dist/index.js"), null);
  });
});

describe("findShippedTestFiles", () => {
  it("lists every offender with its reason", () => {
    const found = findShippedTestFiles(["dist/index.js", "src/a.test.ts", "src/x/testdata/y.msg"]);
    assert.deepEqual(found, [
      { file: "src/a.test.ts", reason: "a test file" },
      { file: "src/x/testdata/y.msg", reason: "inside a testdata folder" },
    ]);
  });
});

describe("listPackedFiles", () => {
  it("shows what a plain `src` entry ships: tests, test doubles, fixtures and test data", () => {
    makePackage("wide", ["dist", "src"]);
    const files = listPackedFiles(join(root, "wide"));
    assert.ok(files.includes("src/index.test.ts"));
    assert.ok(files.includes("src/feature/testdata/mail.msg"));
    const found = findShippedTestFiles(files).map((item) => item.file);
    assert.deepEqual(found.sort(), [
      "src/feature/feature.pg.test.ts",
      "src/feature/fixtures/data.json",
      "src/feature/testdata/mail.msg",
      "src/feature/testing/fake.ts",
      "src/index.test.ts",
    ]);
  });

  it("drops them with the exclusions the packages use and keeps the code", () => {
    makePackage("narrow", [
      "dist",
      "src",
      "!**/*.test.*",
      "!**/testdata",
      "!**/testing",
      "!**/fixtures",
    ]);
    const files = listPackedFiles(join(root, "narrow"));
    assert.deepEqual(findShippedTestFiles(files), []);
    assert.ok(files.includes("dist/index.js"));
    assert.ok(files.includes("src/index.ts"));
    // A module called testing.ts is code, not a test folder.
    assert.ok(files.includes("src/feature/testing.ts"));
  });
});

describe("checkPackages", () => {
  it("reports the package that ships test data and passes the one that does not", () => {
    makePackage("wide", ["dist", "src"]);
    makePackage("narrow", [
      "dist",
      "src",
      "!**/*.test.*",
      "!**/testdata",
      "!**/testing",
      "!**/fixtures",
    ]);
    const findings = checkPackages(["wide", "narrow"], root);
    assert.ok(findings.length > 0);
    assert.ok(findings.every((finding) => finding.pkg === "wide"));
  });
});

describe("the packages deployed into the image", () => {
  it("ship no test files and no test data", () => {
    assert.deepEqual(checkPackages(PACKAGES), []);
  });

  it("ship their package.json and dist, and no TypeScript source (the runtime loads dist)", () => {
    for (const pkg of PACKAGES) {
      const dir = new URL(`../../${pkg}`, import.meta.url).pathname;
      const files = listPackedFiles(dir);
      assert.ok(files.includes("package.json"), pkg);
      const { files: declared = [] } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      assert.ok(declared.includes("dist"), `${pkg} ships dist`);
      const sources = files.filter(
        (file) => /\.(?:[cm]?ts|tsx)$/.test(file) && !/\.d\.[cm]?ts$/.test(file),
      );
      assert.deepEqual(sources, [], `${pkg} ships TypeScript sources`);
    }
    // No Outlook .msg sample ships; the msgreader test data stays in the repository.
    const core = listPackedFiles(new URL("../../packages/core", import.meta.url).pathname);
    assert.equal(
      core.some((file) => file.endsWith(".msg")),
      false,
    );
  });
});
