import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hashBlob, sha256HexPure } from "./sha256";

const reference = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("sha256HexPure", () => {
  it("matches the published vectors", () => {
    expect(sha256HexPure(new TextEncoder().encode(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256HexPure(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches node's digest around the padding boundaries and for larger input", () => {
    for (const length of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70_000]) {
      const bytes = new Uint8Array(length).map((_, index) => (index * 31 + length) & 0xff);
      expect(sha256HexPure(bytes), `length ${length}`).toBe(reference(bytes));
    }
  });
});

describe("hashBlob", () => {
  it("hashes the bytes of a blob", async () => {
    const blob = new Blob(["Subject: hello\n"]);
    expect(await hashBlob(blob)).toBe(reference(new TextEncoder().encode("Subject: hello\n")));
  });

  it("falls back to the pure implementation when the page has no subtle crypto", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    try {
      const blob = new Blob(["plain http installation"]);
      expect(await hashBlob(blob)).toBe(
        reference(new TextEncoder().encode("plain http installation")),
      );
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "crypto", original);
      }
    }
  });
});
