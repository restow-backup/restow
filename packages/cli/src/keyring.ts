/**
 * Key material for the standalone restore.
 *
 * A restore needs the tenant's data-encryption key(s) (DEK) to open the sealed
 * chunks. There are two ways to supply them, both self-contained (no running
 * Restow server, no database):
 *
 *   1. Key-encryption key (KEK). `--key` points to (or an env var holds) the
 *      raw 32-byte KEK the operator normally keeps in the environment / KMS. The
 *      wrapped DEKs already live in the store under `tenants/<tid>/keys/`; this
 *      tool reads and unwraps them with the KEK (see @restow/core `unwrapDek`).
 *      This is the primary path and matches the storage layout in
 *      docs/ARCHITECTURE.md (the `keys/` prefix holds only encrypted DEKs).
 *
 *   2. Exported keyring. `--key` points to (or an env var holds) a small JSON
 *      document carrying the raw DEK material directly, for the case where the
 *      operator exported the tenant key out of band rather than the KEK.
 *
 * Because chunks may have been sealed under several key versions after a
 * rotation, a {@link Keyring} can hold more than one DEK and picks the matching
 * one when opening a chunk.
 *
 * Chunk-id key. A chunk is stored under HMAC-SHA-256 of its plaintext, keyed
 * with a per-tenant key that the format derives with HKDF from the tenant's
 * first DEK (version 1, never deleted; @restow/core `deriveChunkIdKey`). When
 * that DEK is present, the keyring derives the key exactly as the server does,
 * so every restored chunk is re-addressed and checked against the id the
 * manifest asked for. An exported keyring may also carry the key explicitly.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { type Dek, decryptChunk, deriveChunkIdKey, unwrapDek } from "@restow/core";
import type { StorageBackend } from "@restow/core";

/** Version of a tenant's first DEK, the one the chunk-id key is derived from. */
const FIRST_KEY_VERSION = 1;

/**
 * The tenant's chunk-id key, derived from its first DEK; undefined when the
 * keyring does not hold that version (the chunk ids then cannot be recomputed).
 */
export function chunkIdKeyFor(tenantId: string, deks: readonly Dek[]): Buffer | undefined {
  const first = deks.find((dek) => dek.version === FIRST_KEY_VERSION);
  return first ? deriveChunkIdKey(tenantId, first) : undefined;
}

const KEY_BYTES = 32;

/** Shape of an exported keyring JSON document (path 2 above). */
interface ExportedKeyring {
  /** Optional tenant id, for the operator's own sanity checks. */
  tenantId?: string;
  /** One entry per key version. `material` is 32 bytes as hex or base64. */
  keys: Array<{ version: number; material: string }>;
  /**
   * Optional tenant HMAC key (see @restow/core `storedId`), 32 bytes as hex or
   * base64. When absent it is derived from the version 1 key, if present.
   * `restore` and `verify` recompute each chunk's stored id from the decrypted
   * plaintext with it.
   */
  hmacKey?: string;
}

/** Decode 32 bytes of key material from a hex or base64 string. */
function decodeKeyMaterial(text: string, label: string): Buffer {
  const trimmed = text.trim();
  let bytes: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    bytes = Buffer.from(trimmed, "hex");
  } else {
    bytes = Buffer.from(trimmed, "base64");
  }
  if (bytes.length !== KEY_BYTES) {
    throw new Error(`${label} must decode to ${KEY_BYTES} bytes, got ${bytes.length}`);
  }
  return bytes;
}

/**
 * Read the raw bytes named by `--key`: a file if one exists at that path,
 * otherwise an environment variable of that name. Never logs the value.
 */
async function resolveKeyBytes(keyRef: string): Promise<Buffer> {
  if (existsSync(keyRef)) {
    return readFile(keyRef);
  }
  const fromEnv = process.env[keyRef];
  if (fromEnv !== undefined) {
    return Buffer.from(fromEnv, "utf8");
  }
  throw new Error(
    `--key "${keyRef}" is neither a readable file nor the name of a set environment variable`,
  );
}

/** Try to interpret the key input as an exported keyring JSON document. */
function parseExportedKeyring(raw: Buffer): ExportedKeyring | null {
  let text: string;
  try {
    text = raw.toString("utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as ExportedKeyring).keys)) {
    return null;
  }
  return parsed as ExportedKeyring;
}

/** A set of tenant DEKs, plus an optional HMAC key for full hash verification. */
export class Keyring {
  private readonly deks: readonly Dek[];
  /** The tenant chunk-id (HMAC) key, supplied or derived; enables stored-id recomputation. */
  readonly hmacKey?: Buffer;

  constructor(deks: Dek[], hmacKey?: Buffer) {
    if (deks.length === 0) {
      throw new Error("keyring is empty: no data-encryption keys were resolved");
    }
    this.deks = deks;
    this.hmacKey = hmacKey;
  }

  /** Number of key versions held. */
  get size(): number {
    return this.deks.length;
  }

  /**
   * Open one sealed chunk. Tries each held DEK (chunks from before a key
   * rotation are sealed under an older version) and returns the first that
   * authenticates. Throws if none does.
   */
  decrypt(sealed: Buffer): Buffer {
    let lastError: unknown;
    for (const dek of this.deks) {
      try {
        return decryptChunk(dek, sealed);
      } catch (error) {
        lastError = error;
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`no key could open a sealed chunk (last error: ${detail})`);
  }
}

/** Inputs for {@link loadKeyring}. */
export interface LoadKeyringOptions {
  /** The `--key` argument: a file path or an environment variable name. */
  keyRef: string;
  /** The open storage backend (used to read wrapped DEKs in the KEK path). */
  backend: StorageBackend;
  /** Tenant id from the manifest, used to locate `tenants/<tid>/keys/`. */
  tenantId: string;
}

/**
 * Resolve a {@link Keyring} from `--key`, transparently supporting both the KEK
 * path (unwrap stored DEKs) and the exported-keyring path.
 */
export async function loadKeyring(options: LoadKeyringOptions): Promise<Keyring> {
  const raw = await resolveKeyBytes(options.keyRef);

  const exported = parseExportedKeyring(raw);
  if (exported) {
    const deks = exported.keys.map((entry) => {
      if (!Number.isInteger(entry.version) || entry.version < 0) {
        throw new Error(`exported keyring has an invalid key version: ${String(entry.version)}`);
      }
      return {
        version: entry.version,
        material: decodeKeyMaterial(entry.material, "DEK material"),
      };
    });
    const hmacKey = exported.hmacKey
      ? decodeKeyMaterial(exported.hmacKey, "HMAC key")
      : chunkIdKeyFor(options.tenantId, deks);
    return new Keyring(deks, hmacKey);
  }

  // KEK path: the input is the raw 32-byte KEK (raw bytes, hex or base64).
  const kek = raw.length === KEY_BYTES ? raw : decodeKeyMaterial(raw.toString("utf8"), "KEK");
  const keyPrefix = `tenants/${options.tenantId}/keys/`;
  const keyKeys = await options.backend.list(keyPrefix);
  const deks: Dek[] = [];
  for (const key of keyKeys) {
    const wrapped = await options.backend.get(key);
    try {
      deks.push(unwrapDek(kek, wrapped));
    } catch {
      // Not a wrapped DEK, or the KEK does not match this one — skip it.
    }
  }
  if (deks.length === 0) {
    throw new Error(
      `no tenant data key could be unwrapped from "${keyPrefix}" with the provided KEK (supply the correct KEK, or an exported keyring instead)`,
    );
  }
  return new Keyring(deks, chunkIdKeyFor(options.tenantId, deks));
}
