/**
 * Chunk identifiers.
 *
 * - {@link dedupId}: SHA-256 over the plaintext. Used only in-process as the
 *   deduplication key (identical plaintext chunks dedupe within a tenant).
 * - {@link storedId}: HMAC-SHA-256 over the plaintext, keyed with the tenant key.
 *   This is the id a chunk is stored under, so ids cannot be used to confirm a
 *   guessed plaintext across tenants (each tenant has its own key).
 *
 * Deduplication is deliberately per-tenant only (see docs/ARCHITECTURE.md): the
 * stored id is tenant-scoped, so two tenants never share a chunk.
 */
import { hmacSha256, sha256 } from "./crypto.js";

/** In-process deduplication key for a plaintext chunk (SHA-256, 32 bytes). */
export function dedupId(plaintext: Buffer): Buffer {
  return sha256(plaintext);
}

/** Tenant-scoped stored id for a plaintext chunk (HMAC-SHA-256, 32 bytes). */
export function storedId(tenantKey: Buffer, plaintext: Buffer): Buffer {
  return hmacSha256(tenantKey, plaintext);
}
