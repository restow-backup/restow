import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  INSTALLATION_SECRETS_KEY_VERSION,
  deriveInstallationSecretsKey,
  openSecret,
  sealSecret,
  secretAad,
} from "./secret-seal.js";

// A test key and a ciphertext sealed with it once and pinned here: the stored
// format and the derivation must stay readable by every later release.
const FIXED_KEK = Buffer.alloc(32, 7);
const PINNED_ID = "3f1c2b7a-7d3e-4c1a-9a57-2c0e6f1b8d11";
const PINNED_SEALED =
  "UlNSQwEAAAABADJyZXN0b3cuc2VjcmV0OjNmMWMyYjdhLTdkM2UtNGMxYS05YTU3LTJjMGU2ZjFiOGQxMcmgjX9PYiV8o6GyPBzym/UOwCwSOsmbIFuIRGG8GS/6uvAbkuN+rsi5SDRLfAItAg==";

describe("deriveInstallationSecretsKey", () => {
  it("keeps the stored derivation (HKDF-SHA-256, salt and info unchanged)", () => {
    const key = deriveInstallationSecretsKey(FIXED_KEK);
    expect(key.version).toBe(INSTALLATION_SECRETS_KEY_VERSION);
    expect(key.material.toString("hex")).toBe(
      "3e8f979914d2dabe3eaafebec937d1a054367ba60cc1a9dbea30ffa0b52e6370",
    );
  });

  it("opens a secret sealed once and pinned", () => {
    const key = deriveInstallationSecretsKey(FIXED_KEK);
    expect(openSecret(key, PINNED_ID, PINNED_SEALED)).toBe("pinned-smtp-password");
  });
});

describe("sealSecret / openSecret", () => {
  const key = deriveInstallationSecretsKey(randomBytes(32));

  it("round-trips and never carries the plaintext", () => {
    const id = randomUUID();
    const sealed = sealSecret(key, id, "client-secret-value");
    expect(Buffer.from(sealed, "base64").toString("latin1")).not.toContain("client-secret-value");
    expect(openSecret(key, id, sealed)).toBe("client-secret-value");
  });

  it("refuses another row id or another key", () => {
    const id = randomUUID();
    const sealed = sealSecret(key, id, "value");
    expect(() => openSecret(key, randomUUID(), sealed)).toThrow();
    expect(() => openSecret(deriveInstallationSecretsKey(randomBytes(32)), id, sealed)).toThrow();
    expect(secretAad(id).toString("utf8")).toBe(`restow.secret:${id}`);
  });
});
