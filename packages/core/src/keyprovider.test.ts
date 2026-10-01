import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EnvKeyProvider, createKeyProvider, generateDek, kekFromBase64 } from "./keyprovider.js";

describe("EnvKeyProvider", () => {
  it("wraps and unwraps a DEK round-trip", async () => {
    const provider = new EnvKeyProvider(randomBytes(32));
    const dek = generateDek(1);
    const wrapped = await provider.wrapDek(dek);
    const back = await provider.unwrapDek(wrapped);
    expect(back.version).toBe(dek.version);
    expect(back.material.equals(dek.material)).toBe(true);
  });

  it("fails to unwrap a DEK produced under a different KEK", async () => {
    const a = new EnvKeyProvider(randomBytes(32));
    const b = new EnvKeyProvider(randomBytes(32));
    const wrapped = await a.wrapDek(generateDek());
    await expect(b.unwrapDek(wrapped)).rejects.toThrow();
  });

  it("rejects a KEK of the wrong length", () => {
    expect(() => new EnvKeyProvider(randomBytes(16))).toThrow(RangeError);
  });
});

describe("kekFromBase64", () => {
  it("decodes a 32-byte base64 KEK", () => {
    const kek = randomBytes(32);
    expect(kekFromBase64(kek.toString("base64")).equals(kek)).toBe(true);
  });

  it("rejects material that is not 32 bytes", () => {
    expect(() => kekFromBase64(Buffer.alloc(16).toString("base64"))).toThrow(RangeError);
  });
});

describe("createKeyProvider", () => {
  it("builds an env provider from a KEK", () => {
    expect(createKeyProvider({ kind: "env", kek: randomBytes(32) }).kind).toBe("env");
  });

  it("requires a KEK for the env provider", () => {
    expect(() => createKeyProvider({ kind: "env" })).toThrow(/RESTOW_MASTER_KEY/);
  });

  it("refuses the kms provider, which is not bundled yet", () => {
    expect(() => createKeyProvider({ kind: "kms" })).toThrow(/not available yet/);
  });
});
