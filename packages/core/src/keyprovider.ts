/**
 * Key management: envelope encryption of per-tenant data keys (DEKs).
 *
 * A KeyProvider wraps and unwraps tenant DEKs under a key-encryption key (KEK).
 * The KEK never appears in the chunk store; only wrapped DEKs are persisted.
 *
 * This is the pluggable seam for where the key encryption key (KEK) lives:
 *   - EnvKeyProvider, the default. The KEK comes from the operator environment
 *     (RESTOW_MASTER_KEY) and DEKs are wrapped locally (crypto.wrapDek).
 *   - a KMS/Vault-backed provider, not bundled yet. The KEK would stay inside the
 *     operator's KMS/HSM and the provider would delegate wrap/unwrap to it, so a
 *     plaintext KEK never reaches Restow.
 * Both satisfy the same async interface, so nothing else in Restow needs to know
 * where the KEK lives. Wrap/unwrap are async precisely so a network KMS fits.
 */
import { randomBytes } from "node:crypto";
import { type Dek, unwrapDek, wrapDek } from "./crypto.js";

const KEY_LENGTH = 32; // AES-256

/** Where the key-encryption key lives / how DEKs are wrapped. */
export type KeyProviderKind = "env" | "kms";

export interface KeyProvider {
  readonly kind: KeyProviderKind;
  /** Wrap a tenant DEK for storage. Returns opaque, self-describing bytes. */
  wrapDek(dek: Dek): Promise<Buffer>;
  /** Unwrap a DEK previously produced by {@link KeyProvider.wrapDek}. */
  unwrapDek(wrapped: Buffer): Promise<Dek>;
}

/** Generate a fresh random tenant DEK. */
export function generateDek(version = 1): Dek {
  return { version, material: randomBytes(KEY_LENGTH) };
}

/** Decode a base64 KEK (e.g. RESTOW_MASTER_KEY) into 32 raw bytes. */
export function kekFromBase64(encoded: string): Buffer {
  const kek = Buffer.from(encoded, "base64");
  if (kek.length !== KEY_LENGTH) {
    throw new RangeError(`KEK must decode to ${KEY_LENGTH} bytes, got ${kek.length}`);
  }
  return kek;
}

/**
 * Self-hosted provider: the KEK is held in memory (from the operator environment)
 * and DEKs are wrapped locally with AES-256-GCM (see crypto.wrapDek / unwrapDek).
 */
export class EnvKeyProvider implements KeyProvider {
  readonly kind = "env" as const;
  readonly #kek: Buffer;

  constructor(kek: Buffer) {
    if (kek.length !== KEY_LENGTH) {
      throw new RangeError(`KEK must be ${KEY_LENGTH} bytes, got ${kek.length}`);
    }
    // Copy so the caller cannot mutate the key material we hold.
    this.#kek = Buffer.from(kek);
  }

  // `async` so a synchronous failure inside crypto (e.g. a bad-decrypt on the wrong
  // KEK) surfaces as a rejected promise rather than a thrown exception.
  async wrapDek(dek: Dek): Promise<Buffer> {
    return wrapDek(this.#kek, dek);
  }

  async unwrapDek(wrapped: Buffer): Promise<Dek> {
    return unwrapDek(this.#kek, wrapped);
  }
}

export interface KeyProviderOptions {
  kind: KeyProviderKind;
  /** For kind "env": the raw 32-byte KEK, e.g. kekFromBase64(RESTOW_MASTER_KEY). */
  kek?: Buffer;
}

/**
 * Build the configured key provider. "kms" is reserved for an operator-run
 * KMS/Vault-backed provider, which is not bundled yet.
 */
export function createKeyProvider(options: KeyProviderOptions): KeyProvider {
  switch (options.kind) {
    case "env": {
      if (!options.kek) {
        throw new Error("env key provider requires a KEK (set RESTOW_MASTER_KEY)");
      }
      return new EnvKeyProvider(options.kek);
    }
    case "kms":
      throw new Error(
        "kms key provider is not available yet; use the env provider (RESTOW_MASTER_KEY)",
      );
    default:
      throw new Error(`unknown key provider kind: ${String(options.kind)}`);
  }
}
