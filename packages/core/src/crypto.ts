/**
 * Cryptographic primitives for the Restow chunk store.
 *
 * Only Node's built-in `crypto` is used (no external crypto package). Every chunk
 * is sealed with AES-256-GCM; the sealed blob is self-describing so it can be
 * decrypted with just the data key, without any side channel carrying the IV,
 * tag or chunk identity. Data keys (DEK) are wrapped with a key-encryption key
 * (KEK) that lives only in the operator environment / KMS.
 *
 * Sealed chunk layout (all integers big-endian):
 *   magic "RSRC" (4) | format version (1) | key version (4) |
 *   aad length (2) | aad bytes (= chunkId, the GCM AAD) |
 *   iv (12) | auth tag (16) | ciphertext (rest)
 *
 * Wrapped DEK layout:
 *   magic "RSKW" (4) | format version (1) | key version (4) |
 *   iv (12) | auth tag (16) | ciphertext (wrapped 32-byte key material)
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

const GCM_ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // 96-bit nonce, the GCM standard
const TAG_LENGTH = 16; // 128-bit auth tag
const UINT32_MAX = 0xffff_ffff;

/** Magic marker at the front of every sealed chunk. */
export const CHUNK_MAGIC = Buffer.from("RSRC", "ascii");
/** On-disk format version for sealed chunks. */
export const CHUNK_FORMAT_VERSION = 1;
/** Magic marker at the front of every wrapped DEK. */
export const DEK_WRAP_MAGIC = Buffer.from("RSKW", "ascii");
/** On-disk format version for wrapped DEKs. */
export const DEK_WRAP_VERSION = 1;

const SEALED_HEADER_LENGTH = CHUNK_MAGIC.length + 1 + 4 + 2;
const WRAP_HEADER_LENGTH = DEK_WRAP_MAGIC.length + 1 + 4;

/**
 * A tenant data-encryption key. `version` is a monotonic counter: after a key
 * rotation, new chunks are sealed with the new version while old chunks stay
 * readable because their sealed header records the version they were sealed with.
 */
export interface Dek {
  /** Monotonic key version, recorded in every sealed blob. */
  readonly version: number;
  /** Raw 32-byte AES-256 key material. */
  readonly material: Buffer;
}

function assertKeyMaterial(material: Buffer, label: string): void {
  if (material.length !== KEY_LENGTH) {
    throw new RangeError(`${label} must be ${KEY_LENGTH} bytes, got ${material.length}`);
  }
}

function assertUint32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new RangeError(`${label} must be a uint32, got ${value}`);
  }
}

/** SHA-256 digest of a buffer (32 bytes). */
export function sha256(buf: Buffer): Buffer {
  return createHash("sha256").update(buf).digest();
}

/** HMAC-SHA-256 of a buffer under a key (32 bytes). */
export function hmacSha256(key: Buffer, buf: Buffer): Buffer {
  return createHmac("sha256", key).update(buf).digest();
}

/**
 * Seal a plaintext chunk with AES-256-GCM. `chunkId` is bound as the GCM AAD, so
 * a sealed chunk cannot be silently substituted for a different chunk id. The
 * chunk id is also embedded (and therefore authenticated) so {@link decryptChunk}
 * needs only the key.
 */
export function encryptChunk(key: Dek, plaintext: Buffer, chunkId: Buffer): Buffer {
  assertKeyMaterial(key.material, "chunk key");
  assertUint32(key.version, "key version");
  if (chunkId.length > 0xffff) {
    throw new RangeError(`chunkId is too long to seal (${chunkId.length} bytes)`);
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(GCM_ALGORITHM, key.material, iv);
  cipher.setAAD(chunkId);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const header = Buffer.alloc(SEALED_HEADER_LENGTH);
  let offset = CHUNK_MAGIC.copy(header, 0);
  offset = header.writeUInt8(CHUNK_FORMAT_VERSION, offset);
  offset = header.writeUInt32BE(key.version, offset);
  header.writeUInt16BE(chunkId.length, offset);

  return Buffer.concat([header, chunkId, iv, tag, ciphertext]);
}

/**
 * Open a sealed chunk. Throws if the header is malformed, the key version does
 * not match, or the authentication tag fails (i.e. the ciphertext, AAD or header
 * was tampered with).
 */
export function decryptChunk(key: Dek, sealed: Buffer): Buffer {
  assertKeyMaterial(key.material, "chunk key");
  assertUint32(key.version, "key version");
  if (sealed.length < SEALED_HEADER_LENGTH) {
    throw new Error("sealed chunk is truncated (header)");
  }
  if (!sealed.subarray(0, CHUNK_MAGIC.length).equals(CHUNK_MAGIC)) {
    throw new Error("sealed chunk has a bad magic marker");
  }

  let offset = CHUNK_MAGIC.length;
  const version = sealed.readUInt8(offset);
  offset += 1;
  if (version !== CHUNK_FORMAT_VERSION) {
    throw new Error(`unsupported sealed chunk version ${version}`);
  }
  const keyVersion = sealed.readUInt32BE(offset);
  offset += 4;
  if (keyVersion !== key.version) {
    throw new Error(`key version mismatch: sealed=${keyVersion} provided=${key.version}`);
  }
  const aadLength = sealed.readUInt16BE(offset);
  offset += 2;

  const bodyStart = offset + aadLength;
  if (sealed.length < bodyStart + IV_LENGTH + TAG_LENGTH) {
    throw new Error("sealed chunk is truncated (body)");
  }
  const aad = sealed.subarray(offset, bodyStart);
  const iv = sealed.subarray(bodyStart, bodyStart + IV_LENGTH);
  const tag = sealed.subarray(bodyStart + IV_LENGTH, bodyStart + IV_LENGTH + TAG_LENGTH);
  const ciphertext = sealed.subarray(bodyStart + IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(GCM_ALGORITHM, key.material, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  // `final()` throws (bad decrypt) if the tag does not verify.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Encrypt (wrap) a DEK's key material under a KEK for storage. */
export function wrapDek(kek: Buffer, dek: Dek): Buffer {
  assertKeyMaterial(kek, "kek");
  assertKeyMaterial(dek.material, "dek");
  assertUint32(dek.version, "key version");

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(GCM_ALGORITHM, kek, iv);
  const versionAad = Buffer.alloc(4);
  versionAad.writeUInt32BE(dek.version, 0);
  cipher.setAAD(versionAad);
  const ciphertext = Buffer.concat([cipher.update(dek.material), cipher.final()]);
  const tag = cipher.getAuthTag();

  const header = Buffer.alloc(WRAP_HEADER_LENGTH);
  let offset = DEK_WRAP_MAGIC.copy(header, 0);
  offset = header.writeUInt8(DEK_WRAP_VERSION, offset);
  header.writeUInt32BE(dek.version, offset);

  return Buffer.concat([header, iv, tag, ciphertext]);
}

/** Decrypt (unwrap) a DEK previously produced by {@link wrapDek}. */
export function unwrapDek(kek: Buffer, wrapped: Buffer): Dek {
  assertKeyMaterial(kek, "kek");
  if (wrapped.length < WRAP_HEADER_LENGTH + IV_LENGTH + TAG_LENGTH) {
    throw new Error("wrapped dek is truncated");
  }
  if (!wrapped.subarray(0, DEK_WRAP_MAGIC.length).equals(DEK_WRAP_MAGIC)) {
    throw new Error("wrapped dek has a bad magic marker");
  }

  let offset = DEK_WRAP_MAGIC.length;
  const version = wrapped.readUInt8(offset);
  offset += 1;
  if (version !== DEK_WRAP_VERSION) {
    throw new Error(`unsupported wrapped dek version ${version}`);
  }
  const keyVersion = wrapped.readUInt32BE(offset);
  offset += 4;
  const iv = wrapped.subarray(offset, offset + IV_LENGTH);
  const tag = wrapped.subarray(offset + IV_LENGTH, offset + IV_LENGTH + TAG_LENGTH);
  const ciphertext = wrapped.subarray(offset + IV_LENGTH + TAG_LENGTH);

  const versionAad = Buffer.alloc(4);
  versionAad.writeUInt32BE(keyVersion, 0);
  const decipher = createDecipheriv(GCM_ALGORITHM, kek, iv);
  decipher.setAAD(versionAad);
  decipher.setAuthTag(tag);
  const material = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return { version: keyVersion, material };
}
