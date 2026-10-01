import { hkdfSync } from "node:crypto";
import { type Dek, decryptChunk, encryptChunk } from "./crypto.js";
import { sealedAad } from "./engine/keyring.js";

/**
 * Sealing for the encrypted secret store (`secrets`, docs/ARCHITECTURE.md,
 * Sicherheit), shared by every process that reads or writes it: the API seals
 * what operators enter, the worker opens what it needs to reach Microsoft 365,
 * IMAP servers and storage targets.
 *
 * A secret is sealed with AES-256-GCM through the chunk crypto and stored as
 * base64. Its own row id is bound as GCM additional data, so a ciphertext moved
 * to another row fails authentication instead of opening under a new name.
 *
 * Installation-level secrets (no tenant) use a key derived from the master key
 * (RESTOW_MASTER_KEY) with HKDF: the raw KEK serves exactly one purpose
 * (wrapping tenant DEKs) and is never used as a bulk cipher key. The derivation
 * parameters are part of the stored format; changing them would make every
 * installation secret written so far unreadable.
 */

const INSTALLATION_SECRETS_HKDF_INFO = "restow/provider-secrets/v1";
const INSTALLATION_SECRETS_HKDF_SALT = "restow";
const KEY_LENGTH = 32;

/** Version recorded for installation-level secrets (the KEK has no rotation yet). */
export const INSTALLATION_SECRETS_KEY_VERSION = 1;

/** Derive the installation-level secrets key from the KEK (deterministic). */
export function deriveInstallationSecretsKey(kek: Buffer): Dek {
  const material = Buffer.from(
    hkdfSync(
      "sha256",
      kek,
      INSTALLATION_SECRETS_HKDF_SALT,
      INSTALLATION_SECRETS_HKDF_INFO,
      KEY_LENGTH,
    ),
  );
  return { version: INSTALLATION_SECRETS_KEY_VERSION, material };
}

/** GCM additional data binding a ciphertext to its `secrets` row. */
export function secretAad(secretId: string): Buffer {
  return Buffer.from(`restow.secret:${secretId}`, "utf8");
}

/** Seal a plaintext secret for the given row id; returns base64. */
export function sealSecret(key: Dek, secretId: string, plaintext: string): string {
  return encryptChunk(key, Buffer.from(plaintext, "utf8"), secretAad(secretId)).toString("base64");
}

/** Open a sealed secret; throws when the key, the row id or the ciphertext do not match. */
export function openSecret(key: Dek, secretId: string, sealed: string): string {
  const blob = Buffer.from(sealed, "base64");
  const plaintext = decryptChunk(key, blob);
  if (!sealedAad(blob).equals(secretAad(secretId))) {
    throw new Error("sealed secret is bound to a different secret id");
  }
  return plaintext.toString("utf8");
}
