/**
 * Self-test of the ee/ import-direction guard (check-ee-boundary.mjs):
 * `node --test scripts/ci/check-ee-boundary.test.mjs`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ALLOWED_LOADERS, findViolations } from "./check-ee-boundary.mjs";

let root;

function write(path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "check-ee-boundary-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("findViolations", () => {
  it("passes a repo where nothing under apps/ or packages/ imports ee/", async () => {
    write("apps/api/src/app.ts", 'import { db } from "./db.js";\n');
    write("packages/core/src/index.ts", 'export * from "./crypto.js";\n');
    assert.deepEqual(await findViolations(root), []);
  });

  it("flags a relative import into a top-level ee/ directory", async () => {
    write("apps/api/src/routes/v1.ts", 'import { x } from "../../../ee/api/src/index.js";\n');
    const violations = await findViolations(root);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, "apps/api/src/routes/v1.ts");
  });

  it("flags an @restow/ee-* package import", async () => {
    write("packages/core/src/index.ts", 'import { x } from "@restow/ee-api";\n');
    const violations = await findViolations(root);
    assert.equal(violations.length, 1);
  });

  it("flags a dynamic import too", async () => {
    write("apps/web/src/app.tsx", 'const m = await import("@restow/ee-web");\n');
    assert.equal((await findViolations(root)).length, 1);
  });

  it("does not flag a normal relative import that merely contains 'ee'", async () => {
    write("apps/api/src/features/fee/routes.ts", 'import { x } from "../../lib/fee.js";\n');
    assert.deepEqual(await findViolations(root), []);
  });

  it("allows the designated loader files to import ee/", async () => {
    for (const loader of ALLOWED_LOADERS) {
      write(loader, 'import { registerEe } from "@restow/ee-api";\n');
    }
    assert.deepEqual(await findViolations(root), []);
  });

  it("allows exactly one loader per app: api, worker and web", () => {
    assert.deepEqual([...ALLOWED_LOADERS].sort(), [
      "apps/api/src/ee.ts",
      "apps/web/src/features/ee.ts",
      "apps/worker/src/ee.ts",
    ]);
  });

  it("allows the real loaders' relative imports into ee/", async () => {
    write("apps/api/src/ee.ts", 'const m = await import("../../../ee/api/src/index.js");\n');
    write("apps/worker/src/ee.ts", 'import { x } from "../../../ee/worker/src/index.js";\n');
    write("apps/web/src/features/ee.ts", 'import { x } from "../../../../ee/web/src/index";\n');
    assert.deepEqual(await findViolations(root), []);
  });

  it("flags a file next to a loader that imports ee/", async () => {
    write("apps/api/src/ee-helper.ts", 'import { x } from "../../../ee/api/src/index.js";\n');
    write(
      "apps/web/src/features/registry.ts",
      'import { x } from "../../../../ee/web/src/index";\n',
    );
    const files = (await findViolations(root)).map((violation) => violation.file).sort();
    assert.deepEqual(files, ["apps/api/src/ee-helper.ts", "apps/web/src/features/registry.ts"]);
  });

  it("does not check imports from ee/ into the core", async () => {
    write("ee/api/src/index.ts", 'import { x } from "../../../apps/api/src/extensions.js";\n');
    assert.deepEqual(await findViolations(root), []);
  });

  it("does not scan node_modules or dist", async () => {
    write("apps/api/node_modules/pkg/index.ts", 'import { x } from "@restow/ee-api";\n');
    write("apps/api/dist/index.ts", 'import { x } from "@restow/ee-api";\n');
    assert.deepEqual(await findViolations(root), []);
  });
});
