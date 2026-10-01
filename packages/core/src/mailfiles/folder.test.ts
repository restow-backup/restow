import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ImportFolder,
  ImportFolderError,
  type ImportFolderWalkEntry,
  splitRelativePath,
} from "./folder.js";

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "restow-folder-"));
  root = join(base, "import");
  outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "secret.eml"), "From: secret@example.test\n\nsecret");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function collect(iterable: AsyncIterable<ImportFolderWalkEntry>): Promise<string[]> {
  const result: string[] = [];
  for await (const entry of iterable) {
    result.push(entry.kind === "dir" ? `d:${entry.path}` : `f:${entry.file.path}`);
  }
  return result;
}

async function expectCode(
  promise: Promise<unknown>,
  code: ImportFolderError["code"],
): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ImportFolderError);
  expect((error as ImportFolderError).code).toBe(code);
}

describe("splitRelativePath", () => {
  it("normalises separators and dots", () => {
    expect(splitRelativePath("")).toEqual([]);
    expect(splitRelativePath("/")).toEqual([]);
    expect(splitRelativePath("a//b/./c/")).toEqual(["a", "b", "c"]);
    expect(splitRelativePath("/a/b")).toEqual(["a", "b"]);
  });

  it("refuses parent components and NUL", () => {
    expect(() => splitRelativePath("..")).toThrow(ImportFolderError);
    expect(() => splitRelativePath("a/../b")).toThrow(ImportFolderError);
    expect(() => splitRelativePath("../outside")).toThrow(ImportFolderError);
    expect(() => splitRelativePath("a\0b")).toThrow(ImportFolderError);
  });

  it("keeps names that only contain dots", () => {
    expect(splitRelativePath("...")).toEqual(["..."]);
    expect(splitRelativePath("..a")).toEqual(["..a"]);
  });
});

describe("ImportFolder.isAvailable", () => {
  it("is true for a directory and false otherwise", async () => {
    expect(await new ImportFolder(root).isAvailable()).toBe(true);
    expect(await new ImportFolder(join(base, "missing")).isAvailable()).toBe(false);
    await writeFile(join(base, "file"), "x");
    expect(await new ImportFolder(join(base, "file")).isAvailable()).toBe(false);
  });
});

describe("ImportFolder.list", () => {
  it("lists one level sorted by UTF-16 code units, with size and type", async () => {
    await writeFile(join(root, "b.eml"), "12345");
    await writeFile(join(root, "B1.eml"), "1");
    await writeFile(join(root, "a.eml"), "");
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "dir", "inner.eml"), "x");
    const folder = new ImportFolder(root);
    const entries = await folder.list("");
    expect(entries.map((e) => e.name)).toEqual(["B1.eml", "a.eml", "b.eml", "dir"]);
    expect(entries.find((e) => e.name === "b.eml")).toMatchObject({
      path: "b.eml",
      type: "file",
      size: 5,
    });
    expect(entries.find((e) => e.name === "dir")).toMatchObject({ type: "directory", size: null });
    expect(entries[0]?.modifiedAt).toBeInstanceOf(Date);
    const inner = await folder.list("dir");
    expect(inner).toHaveLength(1);
    expect(inner[0]).toMatchObject({ name: "inner.eml", path: "dir/inner.eml" });
  });

  it("honours the limit", async () => {
    for (const name of ["a", "b", "c", "d"]) {
      await writeFile(join(root, name), "x");
    }
    expect((await new ImportFolder(root).list("", 2)).map((e) => e.name)).toEqual(["a", "b"]);
  });

  it("refuses paths that leave the folder", async () => {
    const folder = new ImportFolder(root);
    await expectCode(folder.list(".."), "outside_root");
    await expectCode(folder.list("../outside"), "outside_root");
    await expectCode(folder.list("a/../../outside"), "outside_root");
  });

  it("reports missing directories and files used as directories", async () => {
    await writeFile(join(root, "f.eml"), "x");
    const folder = new ImportFolder(root);
    await expectCode(folder.list("nope"), "not_found");
    await expectCode(folder.list("f.eml"), "not_a_directory");
    await expectCode(folder.list("f.eml/sub"), "not_found");
  });

  it("does not list links that point out of the folder, and lists links that stay inside", async () => {
    await symlink(outside, join(root, "escape-dir"));
    await symlink(join(outside, "secret.eml"), join(root, "escape-file.eml"));
    await writeFile(join(root, "real.eml"), "x");
    await symlink(join(root, "real.eml"), join(root, "inside-link.eml"));
    await symlink(join(root, "does-not-exist"), join(root, "dangling"));
    const names = (await new ImportFolder(root).list("")).map((e) => e.name);
    expect(names).toEqual(["inside-link.eml", "real.eml"]);
  });

  it("refuses to list through a link that leaves the folder", async () => {
    await symlink(outside, join(root, "escape-dir"));
    await expectCode(new ImportFolder(root).list("escape-dir"), "outside_root");
  });

  it("works when the import folder itself is reached through a symlink", async () => {
    await writeFile(join(root, "a.eml"), "x");
    const alias = join(base, "alias");
    await symlink(root, alias);
    expect((await new ImportFolder(alias).list("")).map((e) => e.name)).toEqual(["a.eml"]);
  });
});

describe("ImportFolder.file", () => {
  it("opens a regular file for streaming and random access", async () => {
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "a.eml"), "0123456789");
    const file = await new ImportFolder(root).file("sub/a.eml");
    expect(file.path).toBe("sub/a.eml");
    expect(file.size).toBe(10);
    const streamed: Buffer[] = [];
    for await (const chunk of file.open()) {
      streamed.push(chunk as Buffer);
    }
    expect(Buffer.concat(streamed).toString()).toBe("0123456789");
    expect((await file.read(2, 3)).toString()).toBe("234");
    expect((await file.read(8, 100)).toString()).toBe("89");
    expect((await file.read(10, 5)).length).toBe(0);
    expect((await file.read(50, 5)).length).toBe(0);
    await expect(file.read(-1, 3)).rejects.toThrow(RangeError);
  });

  it("handles an empty file", async () => {
    await writeFile(join(root, "empty.eml"), "");
    const file = await new ImportFolder(root).file("empty.eml");
    expect(file.size).toBe(0);
    const chunks: Buffer[] = [];
    for await (const chunk of file.open()) {
      chunks.push(chunk as Buffer);
    }
    expect(chunks).toHaveLength(0);
    expect((await file.read(0, 10)).length).toBe(0);
  });

  it("normalises the path it reports", async () => {
    await writeFile(join(root, "a.eml"), "x");
    expect((await new ImportFolder(root).file("/./a.eml")).path).toBe("a.eml");
  });

  it("refuses traversal, directories, the root and missing files", async () => {
    const folder = new ImportFolder(root);
    await mkdir(join(root, "dir"));
    await expectCode(folder.file("../outside/secret.eml"), "outside_root");
    await expectCode(folder.file("dir"), "not_regular");
    await expectCode(folder.file(""), "not_regular");
    await expectCode(folder.file("missing.eml"), "not_found");
  });

  it("refuses a symlink that escapes, even for files", async () => {
    await symlink(join(outside, "secret.eml"), join(root, "link.eml"));
    await symlink(outside, join(root, "dir-link"));
    const folder = new ImportFolder(root);
    await expectCode(folder.file("link.eml"), "outside_root");
    await expectCode(folder.file("dir-link/secret.eml"), "outside_root");
  });

  it("refuses non-regular files such as a FIFO", async () => {
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("mkfifo", [join(root, "pipe")]);
    } catch {
      return; // no mkfifo on this platform
    }
    const folder = new ImportFolder(root);
    await expectCode(folder.file("pipe"), "not_regular");
    expect((await folder.list("")).map((e) => e.name)).toEqual([]);
    expect(await collect(folder.walk(""))).toEqual([]);
  });
});

describe("ImportFolder.walk", () => {
  it("walks recursively in UTF-16 code unit order with directories before their content", async () => {
    await writeFile(join(root, "z.eml"), "z");
    await writeFile(join(root, "a.eml"), "a");
    await mkdir(join(root, "Inbox"));
    await mkdir(join(root, "Inbox", "Sub"));
    await writeFile(join(root, "Inbox", "Sub", "deep.eml"), "d");
    await writeFile(join(root, "Inbox", "m.eml"), "m");
    await mkdir(join(root, "empty"));
    await writeFile(join(root, "b"), "b");
    const list = await collect(new ImportFolder(root).walk(""));
    expect(list).toEqual([
      "d:Inbox",
      "d:Inbox/Sub",
      "f:Inbox/Sub/deep.eml",
      "f:Inbox/m.eml",
      "f:a.eml",
      "f:b",
      "d:empty",
      "f:z.eml",
    ]);
  });

  it("interleaves files and directories by name", async () => {
    await writeFile(join(root, "a"), "1");
    await mkdir(join(root, "b"));
    await writeFile(join(root, "b", "x"), "1");
    await writeFile(join(root, "c"), "1");
    expect(await collect(new ImportFolder(root).walk(""))).toEqual(["f:a", "d:b", "f:b/x", "f:c"]);
  });

  it("makes file paths relative to the walked directory", async () => {
    await mkdir(join(root, "Archive", "2019"), { recursive: true });
    await writeFile(join(root, "Archive", "2019", "a.eml"), "x");
    await writeFile(join(root, "Archive", "top.eml"), "x");
    await writeFile(join(root, "other.eml"), "x");
    expect(await collect(new ImportFolder(root).walk("Archive"))).toEqual([
      "d:2019",
      "f:2019/a.eml",
      "f:top.eml",
    ]);
    expect(await collect(new ImportFolder(root).walk("/Archive/"))).toEqual([
      "d:2019",
      "f:2019/a.eml",
      "f:top.eml",
    ]);
  });

  it("yields files that can be read", async () => {
    await mkdir(join(root, "d"));
    await writeFile(join(root, "d", "a.eml"), "hello");
    for await (const entry of new ImportFolder(root).walk("")) {
      if (entry.kind === "file") {
        expect((await entry.file.read(0, 100)).toString()).toBe("hello");
      }
    }
  });

  it("does not follow links that leave the folder and reports them as skipped", async () => {
    await symlink(outside, join(root, "escape-dir"));
    await symlink(join(outside, "secret.eml"), join(root, "escape.eml"));
    await writeFile(join(root, "ok.eml"), "x");
    const skipped: string[] = [];
    const list = await collect(
      new ImportFolder(root).walk("", { onSkipped: (path) => skipped.push(path) }),
    );
    expect(list).toEqual(["f:ok.eml"]);
    expect(skipped.sort()).toEqual(["escape-dir", "escape.eml"]);
  });

  it("stops at a link that points back to a parent directory", async () => {
    await mkdir(join(root, "a"));
    await writeFile(join(root, "a", "x.eml"), "x");
    await symlink(root, join(root, "a", "loop"));
    const skipped: string[] = [];
    const list = await collect(
      new ImportFolder(root).walk("", { onSkipped: (path) => skipped.push(path) }),
    );
    expect(list).toEqual(["d:a", "f:a/x.eml"]);
    expect(skipped).toEqual(["a/loop"]);
  });

  it("follows links that stay inside the folder", async () => {
    await mkdir(join(root, "real"));
    await writeFile(join(root, "real", "x.eml"), "x");
    await symlink(join(root, "real"), join(root, "alias"));
    expect(await collect(new ImportFolder(root).walk(""))).toEqual([
      "d:alias",
      "f:alias/x.eml",
      "d:real",
      "f:real/x.eml",
    ]);
  });

  it("refuses to walk outside, files and missing directories", async () => {
    const folder = new ImportFolder(root);
    await writeFile(join(root, "f.eml"), "x");
    await expectCode(collect(folder.walk("..")), "outside_root");
    await expectCode(collect(folder.walk("f.eml")), "not_a_directory");
    await expectCode(collect(folder.walk("nope")), "not_found");
  });

  it("is abortable", async () => {
    await writeFile(join(root, "a.eml"), "x");
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(new ImportFolder(root).walk("", { signal: controller.signal })),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("is deterministic across runs", async () => {
    for (const name of ["m", "e", "z", "a", "K", "é"]) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, "1.eml"), "x");
    }
    const first = await collect(new ImportFolder(root).walk(""));
    const second = await collect(new ImportFolder(root).walk(""));
    expect(first).toEqual(second);
    expect(first.filter((p) => p.startsWith("d:"))).toEqual([
      "d:K",
      "d:a",
      "d:e",
      "d:m",
      "d:z",
      "d:é",
    ]);
  });
});
