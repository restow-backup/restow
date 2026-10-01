import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStorage } from "../verify/testing.js";
import { listWithSizes, readRange } from "./backend.js";
import { LocalStorageBackend } from "./local.js";

async function text(stream: Readable): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of stream) {
    parts.push(part as Buffer);
  }
  return Buffer.concat(parts).toString("utf8");
}

describe("ranged reads and sized listings", () => {
  let root: string;
  let local: LocalStorageBackend;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "restow-ranges-"));
    local = new LocalStorageBackend(root);
    await local.put("a/one.txt", Buffer.from("0123456789"));
    await local.put("a/deep/two.txt", Buffer.from("abc"));
    await local.put("b/three.txt", Buffer.from("xyz"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads an inclusive byte range of a local file", async () => {
    expect(await text(await local.getRange("a/one.txt", 2, 5))).toBe("2345");
    expect(await text(await readRange(local, "a/one.txt", 7, 9))).toBe("789");
  });

  it("lists a local prefix with sizes, sorted, without descending where nothing can match", async () => {
    expect(await local.listWithSizes("a/")).toEqual([
      { key: "a/deep/two.txt", size: 3 },
      { key: "a/one.txt", size: 10 },
    ]);
    expect(await listWithSizes(local, "b/")).toEqual([{ key: "b/three.txt", size: 3 }]);
    expect(await listWithSizes(local, "missing/")).toEqual([]);
  });

  it("falls back to reading through a stream when the backend has no ranges", async () => {
    const plain = new MemoryStorage();
    await plain.put("k", Buffer.from("0123456789"));
    expect(await text(await readRange(plain, "k", 0, 0))).toBe("0");
    expect(await text(await readRange(plain, "k", 3, 6))).toBe("3456");
    expect(await text(await readRange(plain, "k", 8, 50))).toBe("89");
  });

  it("falls back to a listing plus a head per key when the backend has no sizes", async () => {
    const plain = new MemoryStorage();
    await plain.put("p/b", Buffer.from("12"));
    await plain.put("p/a", Buffer.from("1"));
    await plain.put("q/c", Buffer.from("123"));
    expect(await listWithSizes(plain, "p/")).toEqual([
      { key: "p/a", size: 1 },
      { key: "p/b", size: 2 },
    ]);
  });
});
