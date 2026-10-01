/**
 * Tenant keyring: the set of a tenant's data-encryption keys plus the stable
 * chunk-id key.
 *
 * Stored chunk ids are HMAC-SHA-256 over the plaintext with a per-tenant key
 * (docs/ARCHITECTURE.md). That key must not change when the DEK is rotated,
 * otherwise every chunk would get a new id and deduplication against existing
 * backups would break. It is therefore derived once, with HKDF, from the
 * tenant's *first* DEK (version 1), which is never deleted: older versions stay
 * in the keyring so chunks sealed before a rotation remain readable. Deriving a
 * separate key (instead of reusing DEK bytes) keeps the AES-GCM key and the
 * HMAC key cryptographically independent.
 */
import { hkdfSync } from "node:crypto";
import { CHUNK_MAGIC, type Dek, decryptChunk } from "../crypto.js";
import type { TenantKeyring } from "./types.js";

const KEY_LENGTH = 32;
/** HKDF info label; part of the format, never change it. */
const CHUNK_ID_INFO = "restow/chunk-id/v1";

/** Derive the stable chunk-id (HMAC) key for a tenant from its first DEK. */
export function deriveChunkIdKey(tenantId: string, firstDek: Dek): Buffer {
  const derived = hkdfSync(
    "sha256",
    firstDek.material,
    Buffer.from(tenantId, "utf8"),
    CHUNK_ID_INFO,
    KEY_LENGTH,
  );
  return Buffer.from(derived);
}

/** Read the key version named in a sealed chunk header (see crypto.ts layout). */
export function sealedKeyVersion(sealed: Buffer): number {
  const offset = CHUNK_MAGIC.length + 1;
  if (sealed.length < offset + 4) {
    throw new Error("sealed chunk is truncated (header)");
  }
  return sealed.readUInt32BE(offset);
}

/**
 * The additional data a sealed blob was bound to (the chunk's stored id, or a
 * secret's row id). Authenticated by GCM when the blob is opened.
 */
export function sealedAad(sealed: Buffer): Buffer {
  const lengthOffset = CHUNK_MAGIC.length + 1 + 4;
  if (sealed.length < lengthOffset + 2) {
    throw new Error("sealed chunk is truncated (header)");
  }
  const length = sealed.readUInt16BE(lengthOffset);
  const start = lengthOffset + 2;
  if (sealed.length < start + length) {
    throw new Error("sealed chunk is truncated (aad)");
  }
  return Buffer.from(sealed.subarray(start, start + length));
}

/** In-memory {@link TenantKeyring} over a list of unwrapped DEKs. */
export class Keyring implements TenantKeyring {
  readonly tenantId: string;
  readonly current: Dek;
  readonly chunkIdKey: Buffer;
  private readonly byVersionMap: Map<number, Dek>;

  constructor(tenantId: string, deks: readonly Dek[]) {
    if (deks.length === 0) {
      throw new Error(`tenant ${tenantId} has no data-encryption key`);
    }
    const sorted = [...deks].sort((a, b) => a.version - b.version);
    this.tenantId = tenantId;
    this.byVersionMap = new Map(sorted.map((dek) => [dek.version, dek]));
    if (this.byVersionMap.size !== sorted.length) {
      throw new Error(`tenant ${tenantId} has duplicate key versions`);
    }
    this.current = sorted[sorted.length - 1];
    this.chunkIdKey = deriveChunkIdKey(tenantId, sorted[0]);
  }

  versions(): number[] {
    return [...this.byVersionMap.keys()];
  }

  byVersion(version: number): Dek | undefined {
    return this.byVersionMap.get(version);
  }

  open(sealed: Buffer): Buffer {
    const version = sealedKeyVersion(sealed);
    const dek = this.byVersionMap.get(version);
    if (!dek) {
      throw new Error(
        `sealed chunk needs key version ${version}, keyring holds ${this.versions().join(",")}`,
      );
    }
    return decryptChunk(dek, sealed);
  }
}
