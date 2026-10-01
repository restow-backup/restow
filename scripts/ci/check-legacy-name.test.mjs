/**
 * Self-test of the former-name guard (scripts/ci, see its header):
 * `node --test scripts/ci/*.test.mjs`. The word is assembled from parts, like
 * in the guard, so this file does not name it either.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const WORD = ["os", "iris"].join("");
const { GUARD_PATHS, findViolations, listRepositoryFiles } = await import(
  new URL("./check-legacy-name.mjs", import.meta.url).href
);
const CAPITALISED = WORD[0].toUpperCase() + WORD.slice(1);

let root;

function write(path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function git(...args) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "check-former-name-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("findViolations", () => {
  it("passes files that do not name the former product", () => {
    write("README.md", "# Restow\n\nBackup you can prove is restorable.\n");
    write("src/index.ts", 'export const name = "restow";\n');
    assert.deepEqual(findViolations(root, ["README.md", "src/index.ts"]), []);
  });

  it("flags the name in a capitalised, lowercase and uppercase spelling, with its line", () => {
    write("a.md", `first\nThe ${CAPITALISED} agent\nthird ${WORD.toUpperCase()}_MODE\n`);
    write("b.ts", `const x = "${WORD}-agent";\n`);
    const violations = findViolations(root, ["a.md", "b.ts"]);
    assert.deepEqual(
      violations.map(({ file, line }) => `${file}:${line}`),
      ["a.md:2", "a.md:3", "b.ts:1"],
    );
    assert.match(violations[0].text, /agent/);
  });

  it("flags a name inside a longer identifier, a URL and a package scope", () => {
    write(
      "c.txt",
      `@${WORD}/core\nhttps://${WORD}backup.example/\nlooksLike${CAPITALISED}Session\n`,
    );
    assert.equal(findViolations(root, ["c.txt"]).length, 3);
  });

  it("flags a path that names it, once, even when the content is clean", () => {
    write(`agent/cmd/${WORD}-agent/main.go`, "package main\n");
    assert.deepEqual(findViolations(root, [`agent/cmd/${WORD}-agent/main.go`]), [
      { file: `agent/cmd/${WORD}-agent/main.go`, line: 0, text: "(path)" },
    ]);
  });

  it("skips binary files, the way git decides", () => {
    writeFileSync(
      join(root, "image.png"),
      Buffer.concat([Buffer.from([0x89, 0x50, 0, 0]), Buffer.from(WORD)]),
    );
    assert.deepEqual(findViolations(root, ["image.png"]), []);
  });

  it("skips a listed path that is gone from the working tree", () => {
    assert.deepEqual(findViolations(root, ["deleted-but-not-committed.md"]), []);
  });

  it("allows the name in the paths of the guard's own files only", () => {
    assert.equal(GUARD_PATHS.size, 2);
    for (const path of GUARD_PATHS) {
      write(path, "export {};\n");
      assert.deepEqual(findViolations(root, [path]), []);
    }
    write(`scripts/ci/other-${WORD}.mjs`, "export {};\n");
    assert.equal(findViolations(root, [`scripts/ci/other-${WORD}.mjs`]).length, 1);
  });

  it("still reads the contents of the guard's own files", () => {
    const [path] = GUARD_PATHS;
    write(path, `// ${CAPITALISED}\n`);
    assert.equal(findViolations(root, [path]).length, 1);
  });
});

describe("listRepositoryFiles", () => {
  it("lists tracked files and untracked ones that are not ignored, nothing ignored", () => {
    git("init", "-q");
    write(".gitignore", "ignored.txt\nbuild/\n");
    write("tracked.md", "tracked\n");
    write("ignored.txt", `${WORD}\n`);
    write("build/out.js", `${WORD}\n`);
    git("add", ".gitignore", "tracked.md");
    write("new-untracked.md", `Hello ${CAPITALISED}\n`);

    assert.deepEqual(listRepositoryFiles(root), [".gitignore", "new-untracked.md", "tracked.md"]);
    const violations = findViolations(root);
    assert.deepEqual(
      violations.map(({ file }) => file),
      ["new-untracked.md"],
    );
  });
});
