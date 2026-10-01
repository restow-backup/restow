import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type Dek,
  decryptChunk,
  encryptChunk,
  hmacSha256,
  sha256,
  unwrapDek,
  wrapDek,
} from "./crypto.js";

const key: Dek = { version: 1, material: Buffer.alloc(32, 0x07) };

describe("hash primitives", () => {
  it("matches known SHA-256 and HMAC-SHA-256 vectors", () => {
    // FIPS 180-4 example.
    expect(sha256(Buffer.from("abc")).toString("hex")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    // RFC 4231 HMAC-SHA-256 test case 1.
    expect(hmacSha256(Buffer.alloc(20, 0x0b), Buffer.from("Hi There")).toString("hex")).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });
});

describe("chunk sealing", () => {
  it("round-trips a sealed chunk", () => {
    const plaintext = Buffer.from("the object is chunked, sealed and deduplicated");
    const chunkId = sha256(plaintext);
    const sealed = encryptChunk(key, plaintext, chunkId);
    expect(decryptChunk(key, sealed).equals(plaintext)).toBe(true);
  });

  it("detects a flipped ciphertext byte", () => {
    const plaintext = Buffer.from("integrity is the product");
    const sealed = encryptChunk(key, plaintext, sha256(plaintext));
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] ^= 0x01; // the last byte is ciphertext
    expect(() => decryptChunk(key, tampered)).toThrow();
  });

  it("detects a flipped AAD (chunk id) byte", () => {
    const plaintext = Buffer.from("bound to its id");
    const chunkId = sha256(plaintext);
    const sealed = encryptChunk(key, plaintext, chunkId);
    // The AAD starts right after the 11-byte header; flipping it must fail the tag.
    const tampered = Buffer.from(sealed);
    tampered[11] ^= 0x80;
    expect(() => decryptChunk(key, tampered)).toThrow();
  });

  it("fails to decrypt with the wrong key", () => {
    const plaintext = Buffer.from("no cross-tenant reads");
    const sealed = encryptChunk(key, plaintext, sha256(plaintext));
    const wrong: Dek = { version: 1, material: Buffer.alloc(32, 0x09) };
    expect(() => decryptChunk(wrong, sealed)).toThrow();
  });

  it("rejects a key version mismatch", () => {
    const plaintext = Buffer.from("rotation aware");
    const sealed = encryptChunk(
      { version: 3, material: key.material },
      plaintext,
      sha256(plaintext),
    );
    expect(() => decryptChunk({ version: 4, material: key.material }, sealed)).toThrow();
  });
});

describe("DEK wrapping", () => {
  it("wraps and unwraps a DEK, preserving version and material", () => {
    const kek = Buffer.alloc(32, 0x03);
    const dek: Dek = { version: 5, material: randomBytes(32) };
    const wrapped = wrapDek(kek, dek);
    const restored = unwrapDek(kek, wrapped);
    expect(restored.version).toBe(5);
    expect(restored.material.equals(dek.material)).toBe(true);
  });

  it("fails to unwrap with the wrong KEK", () => {
    const dek: Dek = { version: 1, material: randomBytes(32) };
    const wrapped = wrapDek(Buffer.alloc(32, 0x03), dek);
    expect(() => unwrapDek(Buffer.alloc(32, 0x04), wrapped)).toThrow();
  });
});
