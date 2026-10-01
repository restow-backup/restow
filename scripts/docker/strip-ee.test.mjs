/**
 * Self-test of the Community build's strip step (strip-ee.mjs):
 * `node --test scripts/docker/*.test.mjs`.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ALLOWED_LOADERS } from "../ci/check-ee-boundary.mjs";
import { LOADER_STUB, StripError, planStrip, stripEe } from "./strip-ee.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const INDEX_CSS = [
  '@import "tailwindcss";',
  '@import "tw-animate-css";',
  "",
  '@source "../../../ee/web/src";',
  "",
  ":root { --radius: 0.5rem; }",
  "",
].join("\n");

let root;

function write(path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

/** A small workspace shaped like the real one: three loaders, a stylesheet, ee/. */
function workspace() {
  write(
    "apps/api/src/ee.ts",
    'import { eeAuthExtension } from "../../../ee/api/src/auth.js";\nconst { eeApiExtension } = await import("../../../ee/api/src/index.js");\n',
  );
  write("apps/api/src/server.ts", 'await import("./ee.js");\n');
  write(
    "apps/worker/src/ee.ts",
    'import { eeWorkerExtension } from "../../../ee/worker/src/index.js";\n',
  );
  write(
    "apps/web/src/features/ee.ts",
    'import { eeWebExtension } from "../../../../ee/web/src/index";\n',
  );
  write("apps/web/src/features/registry.ts", 'import "./ee";\n');
  write("apps/web/src/index.css", INDEX_CSS);
  write("packages/core/src/index.ts", 'export * from "./crypto.js";\n');
  write("ee/api/src/index.ts", "export const eeApiExtension = {};\n");
  write("ee/web/src/index.ts", "export const eeWebExtension = {};\n");
  write("ee/LICENSE", "Restow Enterprise License\n");
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "strip-ee-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("stripEe", () => {
  it("empties every loader, drops the ee/ @source line and removes ee/", async () => {
    workspace();
    const result = await stripEe(root);
    assert.deepEqual(result.loaders, [...ALLOWED_LOADERS].sort());
    for (const loader of ALLOWED_LOADERS) {
      assert.equal(read(loader), LOADER_STUB);
    }
    assert.equal(existsSync(join(root, "ee")), false);
    const css = read("apps/web/src/index.css");
    assert.equal(css.includes("ee/web/src"), false);
    assert.equal(css, INDEX_CSS.replace('@source "../../../ee/web/src";\n', ""));
    // The rest of the core is untouched.
    assert.equal(read("apps/api/src/server.ts"), 'await import("./ee.js");\n');
    assert.equal(read("packages/core/src/index.ts"), 'export * from "./crypto.js";\n');
    assert.deepEqual(result.stylesheets, [
      { file: "apps/web/src/index.css", removed: ['@source "../../../ee/web/src";'] },
    ]);
  });

  it("leaves an empty module that imports nothing", () => {
    assert.equal(
      /\bimport\b|\bfrom\b|require\(/.test(LOADER_STUB.replace(/\/\*[\s\S]*?\*\//, "")),
      false,
    );
    assert.match(LOADER_STUB, /^export \{\};$/m);
    assert.equal(/ee\//.test(LOADER_STUB), false);
  });

  it("is idempotent", async () => {
    workspace();
    await stripEe(root);
    const second = await stripEe(root);
    assert.equal(second.eeDirectory, false);
    assert.deepEqual(second.stylesheets, []);
  });

  it("fails loudly and changes nothing when a loader is missing (a renamed loader)", async () => {
    workspace();
    rmSync(join(root, "apps/worker/src/ee.ts"));
    write(
      "apps/worker/src/modules.ts",
      'import { eeWorkerExtension } from "../../../ee/worker/src/index.js";\n',
    );
    await assert.rejects(stripEe(root), (error) => {
      assert.ok(error instanceof StripError);
      assert.ok(
        error.problems.some((problem) => problem.includes("apps/worker/src/ee.ts is missing")),
      );
      assert.ok(
        error.problems.some((problem) => problem.startsWith("apps/worker/src/modules.ts imports")),
      );
      return true;
    });
    assert.equal(existsSync(join(root, "ee/api/src/index.ts")), true);
    assert.match(read("apps/api/src/ee.ts"), /ee\/api\/src\/auth\.js/);
    assert.equal(read("apps/web/src/index.css"), INDEX_CSS);
  });

  it("refuses a core file other than a loader that imports from ee/", async () => {
    workspace();
    write("packages/core/src/extra.ts", 'import { x } from "@restow/ee-api";\n');
    await assert.rejects(stripEe(root), StripError);
    assert.equal(existsSync(join(root, "ee")), true);
  });

  it("refuses a stylesheet that imports from ee/ (only @source lines can go)", async () => {
    workspace();
    write("apps/web/src/extra.css", '@import "../../../ee/web/src/theme.css";\n');
    await assert.rejects(stripEe(root), (error) => {
      assert.ok(error.problems.some((problem) => problem.startsWith("apps/web/src/extra.css:1")));
      return true;
    });
    assert.equal(existsSync(join(root, "ee")), true);
  });

  it("keeps @source lines that do not point into ee/", async () => {
    workspace();
    write("apps/web/src/other.css", '@source "../../../packages/ui/src";\n@source "./eel";\n');
    await stripEe(root);
    assert.equal(
      read("apps/web/src/other.css"),
      '@source "../../../packages/ui/src";\n@source "./eel";\n',
    );
  });
});

describe("the real workspace", () => {
  it("can be stripped: every loader exists and nothing else reaches ee/", async () => {
    const plan = await planStrip(repoRoot);
    assert.deepEqual(plan.loaders, [
      "apps/api/src/ee.ts",
      "apps/web/src/features/ee.ts",
      "apps/worker/src/ee.ts",
    ]);
    assert.equal(plan.eeDirectory, true);
  });
});
