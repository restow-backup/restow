import { describe, expect, it } from "vitest";
import { dedupId, storedId } from "./chunkId.js";

describe("chunk identifiers", () => {
  it("dedupId is stable and content-addressed", () => {
    const data = Buffer.from("hello world");
    expect(dedupId(data).equals(dedupId(Buffer.from("hello world")))).toBe(true);
    expect(dedupId(data).equals(dedupId(Buffer.from("hello worlx")))).toBe(false);
    expect(dedupId(data).length).toBe(32);
  });

  it("storedId is stable per key and scoped to key and content", () => {
    const keyA = Buffer.alloc(32, 0x01);
    const keyB = Buffer.alloc(32, 0x02);
    const data = Buffer.from("chunk bytes");

    const first = storedId(keyA, data);
    const again = storedId(keyA, Buffer.from("chunk bytes"));
    expect(first.equals(again)).toBe(true); // stable across calls

    expect(first.equals(storedId(keyB, data))).toBe(false); // different tenant key
    expect(first.equals(storedId(keyA, Buffer.from("other")))).toBe(false); // different content
    expect(first.length).toBe(32);
  });
});
