import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PROVIDER_KEY_VERSION,
  deriveProviderSecretsKey,
  openSecret,
  sealSecret,
  secretAad,
} from "./secrets.js";

const kek = randomBytes(32);

describe("deriveProviderSecretsKey", () => {
  it("derives a stable 32-byte key that differs from the KEK itself", () => {
    const first = deriveProviderSecretsKey(kek);
    const second = deriveProviderSecretsKey(kek);
    expect(first.material).toHaveLength(32);
    expect(first.material.equals(second.material)).toBe(true);
    expect(first.material.equals(kek)).toBe(false);
    expect(first.version).toBe(PROVIDER_KEY_VERSION);
  });

  it("changes with the KEK", () => {
    const other = deriveProviderSecretsKey(randomBytes(32));
    expect(other.material.equals(deriveProviderSecretsKey(kek).material)).toBe(false);
  });
});

describe("sealSecret / openSecret", () => {
  const key = deriveProviderSecretsKey(kek);

  it("round-trips a secret bound to its row id", () => {
    const id = randomUUID();
    const sealed = sealSecret(key, id, "s3cret-p@ssword");
    expect(sealed).not.toContain("s3cret");
    expect(openSecret(key, id, sealed)).toBe("s3cret-p@ssword");
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    const id = randomUUID();
    expect(sealSecret(key, id, "same")).not.toBe(sealSecret(key, id, "same"));
  });

  it("refuses to open a ciphertext under another key, id or after tampering", () => {
    const id = randomUUID();
    const sealed = sealSecret(key, id, "value");
    expect(() => openSecret(deriveProviderSecretsKey(randomBytes(32)), id, sealed)).toThrow();
    expect(() => openSecret(key, randomUUID(), sealed)).toThrow();

    const bytes = Buffer.from(sealed, "base64");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    expect(() => openSecret(key, id, bytes.toString("base64"))).toThrow();
  });

  it("binds the row id as additional data", () => {
    expect(secretAad("abc").toString("utf8")).toBe("restow.secret:abc");
  });
});
