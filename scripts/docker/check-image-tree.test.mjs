/**
 * Self-test of the image tree check (check-image-tree.mjs):
 * `node --test scripts/docker/*.test.mjs`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { scanTree } from "./check-image-tree.mjs";

let root;

function write(path, content = "") {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/** A /prod tree as `pnpm deploy` lays it out: the compiled dist and pnpm's node_modules. */
function prodTree({ withEe = false } = {}) {
  write("api/package.json", '{ "name": "@restow/api" }');
  write("api/dist/apps/api/src/server.js", 'await import("./ee.js");\n');
  write("api/dist/apps/api/src/ee.js", "export {};\n");
  write("api/dist/apps/api/src/server.js.map", '{"sources":["../../../../src/server.ts"]}');
  // The core reads certificates with createPrivateKey and mentions ee/ in comments.
  write(
    "api/dist/apps/api/src/auth.js",
    "// The Microsoft sign-in lives in a module (ee/api/src/sso).\nimport { createPrivateKey } from 'node:crypto';\n",
  );
  write(
    "api/node_modules/.pnpm/@restow+core@file+packages+core/node_modules/@restow/core/dist/entra/certificate.js",
    'generateKeyPairSync("rsa", { modulusLength: 2048 });\n',
  );
  // Third-party code is not searched: React knows <keygen>, libraries make key pairs.
  write(
    "api/node_modules/.pnpm/react-dom@19.0.0/node_modules/react-dom/cjs/react-dom.js",
    'var voids = ["keygen"]; crypto.generateKeyPairSync("ed25519");\n',
  );
  write("api/node_modules/.pnpm/selfsigned@2.0.0/node_modules/selfsigned/keygen.js", "");
  if (withEe) {
    write(
      "api/dist/apps/api/src/ee.js",
      'import { eeAuthExtension } from "../../../ee/api/src/auth.js";\n',
    );
    write("api/dist/ee/api/src/index.js", "export const eeApiExtension = {};\n");
    write("api/dist/ee/api/src/index.js.map", '{"sources":["../../../../../ee/api/src/index.ts"]}');
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "check-image-tree-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("license signing code", () => {
  it("passes a tree that only verifies keys, whatever third-party code contains", () => {
    prodTree({ withEe: true });
    assert.deepEqual(scanTree(root).findings, []);
  });

  it("flags signing functions, the key file and Ed25519 key generation in first-party code", () => {
    prodTree();
    write("api/dist/apps/api/src/a.js", "export function signLicenseToken() {}\n");
    write("api/dist/apps/api/src/b.js", "export const issueLicenseToken = 1;\n");
    write("api/dist/apps/api/src/c.js", "readFileSync('license-signing.key');\n");
    write("api/dist/apps/api/src/d.js", "generateKeyPairSync( 'ed25519' );\n");
    write("api/dist/apps/api/src/e.js", "const signer = createTestLicenseSigner();\n");
    write("cli/dist/f.js", "const pair = generateLicenseSigningKeyPair();\n");
    write("cli/dist/g.js", "export const LICENSE_CLI_USAGE = '';\nrunLicenseCli(process.argv);\n");
    const { findings } = scanTree(root);
    assert.equal(findings.length, 7, findings.join("\n"));
  });

  it("flags signing code inside a workspace package in node_modules", () => {
    prodTree();
    write(
      "api/node_modules/.pnpm/@restow+core@file+packages+core/node_modules/@restow/core/dist/license/issue.js",
      "export {};\n",
    );
    write(
      "api/node_modules/.pnpm/@restow+core@file+packages+core/node_modules/@restow/core/dist/license/cli.js",
      "export {};\n",
    );
    assert.equal(scanTree(root).findings.length, 2);
  });

  it("flags the test signer and key generators by file name", () => {
    prodTree();
    write("api/dist/ee/licensing/test-signer.mjs", "export {};\n");
    write("api/dist/tools/license-keygen.js", "export {};\n");
    const { findings } = scanTree(root);
    assert.equal(findings.length, 2, findings.join("\n"));
  });

  it("checks a web bundle the same way", () => {
    write("index.html", "<!doctype html>");
    write("assets/vendor-react-abc.js", 'var v=["keygen","link"];');
    assert.deepEqual(scanTree(root).findings, []);
    write("assets/index-def.js", "function signLicenseToken(){}");
    assert.equal(scanTree(root).findings.length, 1);
  });
});

describe("tests and sources", () => {
  it("flags compiled tests, their source maps and TypeScript sources of the apps", () => {
    prodTree();
    write("api/dist/apps/api/src/app.test.js", "export {};\n");
    write("api/dist/apps/api/src/app.test.js.map", "{}");
    write("api/dist/apps/api/src/lib/db.pg.test.js", "export {};\n");
    write("api/src/server.ts", "export {};\n");
    write("api/src/components/view.tsx", "export {};\n");
    const { findings } = scanTree(root);
    assert.deepEqual(findings.sort(), [
      "api/dist/apps/api/src/app.test.js.map: a test file",
      "api/dist/apps/api/src/app.test.js: a test file",
      "api/dist/apps/api/src/lib/db.pg.test.js: a test file",
      "api/src/components/view.tsx: a TypeScript source (the image runs the compiled dist)",
      "api/src/server.ts: a TypeScript source (the image runs the compiled dist)",
    ]);
  });

  it("flags test folders and tests inside a workspace package in node_modules", () => {
    prodTree();
    const core = "api/node_modules/.pnpm/@restow+core@file+packages+core/node_modules/@restow/core";
    write(`${core}/dist/restore/testing/zip-reader.js`, "export {};\n");
    write(`${core}/src/mailfiles/testdata/sample.msg`, "x");
    write(`${core}/dist/index.test.js`, "export {};\n");
    write("worker/dist/apps/worker/src/fixtures/job.json", "{}");
    const { findings } = scanTree(root);
    assert.ok(
      findings.includes(`${core}/dist/restore/testing/: a test folder`),
      findings.join("\n"),
    );
    assert.ok(findings.includes(`${core}/src/mailfiles/testdata/: a test folder`));
    assert.ok(findings.includes(`${core}/dist/index.test.js: a test file`));
    assert.ok(findings.includes("worker/dist/apps/worker/src/fixtures/: a test folder"));
  });

  it("keeps declarations, modules that merely have the word in their name, and third-party tests", () => {
    prodTree();
    write("worker/dist/apps/worker/src/index.d.ts", "export {};\n");
    write("worker/dist/apps/worker/src/restore-test.js", "export {};\n");
    write("worker/dist/apps/worker/src/verify/testing.js", "export {};\n");
    write("api/node_modules/.pnpm/pg@8.13.0/node_modules/pg/test/client.test.js", "");
    write("api/node_modules/.pnpm/zod@3.24.0/node_modules/zod/src/index.ts", "");
    assert.deepEqual(scanTree(root).findings, []);
  });
});

describe("the community build", () => {
  it("passes a tree without ee/ code", () => {
    prodTree();
    const result = scanTree(root, { variant: "community" });
    assert.deepEqual(result.findings, []);
    assert.ok(result.files >= 4);
  });

  it("flags dist/ee, the loader's import and the source map path into ee/", () => {
    prodTree({ withEe: true });
    const { findings } = scanTree(root, { variant: "community" });
    assert.ok(findings.some((finding) => finding.startsWith("api/dist/ee/: ")));
    assert.ok(findings.some((finding) => finding.startsWith("api/dist/apps/api/src/ee.js: ")));
    assert.ok(findings.some((finding) => finding.startsWith("api/dist/ee/api/src/index.js.map: ")));
  });

  it("flags an @restow/ee-* package in node_modules", () => {
    prodTree();
    write("api/node_modules/@restow/ee-api/package.json", '{ "name": "@restow/ee-api" }');
    write(
      "api/node_modules/.pnpm/@restow+ee-worker@file+ee+worker/node_modules/@restow/ee-worker/index.js",
      "",
    );
    const { findings } = scanTree(root, { variant: "community" });
    assert.ok(findings.some((finding) => finding.includes("the package @restow/ee-api")));
    assert.ok(findings.some((finding) => finding.includes("the package @restow/ee-worker")));
  });

  it("does not follow symbolic links (pnpm's links point into the store, which is walked)", () => {
    prodTree();
    mkdirSync(join(root, "outside/ee"), { recursive: true });
    write("outside/ee/x.js", "");
    symlinkSync(join(root, "outside"), join(root, "api/dist/linked"));
    assert.deepEqual(scanTree(join(root, "api"), { variant: "community" }).findings, []);
    assert.equal(scanTree(join(root, "outside"), { variant: "community" }).findings.length, 1);
  });
});

describe("--require-ee (the full build)", () => {
  it("passes when the tree carries the ee/ modules", () => {
    prodTree({ withEe: true });
    const result = scanTree(join(root, "api"), { requireEe: true });
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.eeDirectories, ["dist/ee"]);
  });

  it("fails when they are missing", () => {
    prodTree();
    assert.equal(scanTree(join(root, "api"), { requireEe: true }).findings.length, 1);
  });
});
