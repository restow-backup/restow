/**
 * Sealed manifests: the form every snapshot manifest and checkpoint
 * (`.partial`) takes in storage.
 *
 * A manifest names object paths built from mail subjects, event subjects,
 * contact names and file names, carries Message-IDs and folder names in its
 * metadata, and records the plaintext SHA-256 of every object. None of that
 * may be readable by whoever can read a storage target (the provider of an
 * offsite bucket, a storage admin), so it is sealed with the tenant DEK like
 * every chunk.
 *
 * Layout (docs/ARCHITECTURE.md):
 *   codec tag 0x10 (1) | sealed blob (crypto.ts layout)
 * The sealed blob is AES-256-GCM under the tenant's current DEK; its plaintext
 * is the unsealed serialization of the manifest (manifest.ts, any of its
 * codecs) and its AAD is the UTF-8 storage key the manifest is written under
 * (`tenants/<tid>/manifests/<snapshot>.json.zst` or `.partial`). The AAD sits
 * in the sealed header in clear text; it names only the tenant and snapshot
 * ids, which the storage key shows anyway. A reader therefore learns which
 * tenant key it needs before decrypting, and a manifest copied to another key
 * no longer opens there.
 *
 * Every manifest this product has ever written is sealed: `commit()` and
 * `checkpoint()` (engine/snapshot.ts) call {@link sealManifest}
 * unconditionally, and always have. {@link openManifest} therefore refuses
 * unsealed bytes by default — whoever can write to a storage target (a leaked
 * bucket key, an offsite-bucket or NAS admin) must never be able to make the
 * server trust a self-declared, unencrypted manifest in place of the sealed
 * one it expects: an unsealed manifest can name arbitrary chunk ids (a tenant-
 * wide data leak through restore) and carry a forged Graph delta/next link (an
 * app-token leak through the next backup, see GraphClient's own origin
 * check). A caller that genuinely needs to read a manifest from before this
 * module existed — a dedicated migration tool, never the server's own restore,
 * verify or backup path — opts in explicitly with `allowUnsealed`.
 */
import { type Dek, encryptChunk } from "../crypto.js";
import { type SnapshotManifest, deserializeManifest, serializeManifest } from "../manifest.js";
import { sealedAad } from "./keyring.js";
import { parseManifestKey } from "./layout.js";

/** Codec tag of a sealed manifest (the unsealed codecs of manifest.ts stay below it). */
export const SEALED_MANIFEST_CODEC = 0x10;

/** Opens a sealed blob with the key version its header names (a tenant keyring). */
export type SealedBlobOpener = (sealed: Buffer) => Buffer;

/**
 * Serialize and seal a manifest with the tenant DEK, bound to the storage key
 * it is written under.
 */
export async function sealManifest(
  manifest: SnapshotManifest,
  key: Dek,
  storageKey: string,
): Promise<Buffer> {
  const plaintext = await serializeManifest(manifest);
  const sealed = encryptChunk(key, plaintext, Buffer.from(storageKey, "utf8"));
  return Buffer.concat([Buffer.from([SEALED_MANIFEST_CODEC]), sealed]);
}

/** Whether serialized manifest bytes are sealed. */
export function isSealedManifest(bytes: Buffer): boolean {
  return bytes.length > 0 && bytes[0] === SEALED_MANIFEST_CODEC;
}

/**
 * The storage key a sealed manifest is bound to, read from its header
 * without any key. {@link parseManifestKey} turns it into the tenant whose
 * keyring opens the manifest. Throws for bytes that are not a sealed manifest.
 */
export function sealedManifestKey(bytes: Buffer): string {
  if (!isSealedManifest(bytes)) {
    throw new Error("manifest is not sealed");
  }
  return sealedAad(bytes.subarray(1)).toString("utf8");
}

export interface OpenManifestOptions {
  /** Opens the sealed blob with the tenant key. Required for a sealed manifest. */
  readonly open?: SealedBlobOpener;
  /**
   * The storage key the bytes were read from, when known. A sealed manifest
   * bound to another key is refused.
   */
  readonly storageKey?: string;
  /**
   * Accept manifest bytes that are not sealed at all, with no key and no
   * binding to `storageKey`. Every manifest the server itself ever writes is
   * sealed (see this file's doc comment), so `loadManifest` — the only reader
   * restore, verify, backup and the API's own snapshot browsing ever go
   * through — never sets this. Leave it unset unless the caller is a
   * deliberate, explicitly-invoked recovery tool reading a manifest an
   * operator handed it directly, outside normal operation.
   */
  readonly allowUnsealed?: boolean;
}

/**
 * Decode stored manifest bytes: a sealed manifest (opened with `open`, and
 * checked against `storageKey` and against the tenant and snapshot its key
 * names). Unsealed bytes are refused unless `allowUnsealed` says otherwise
 * (see {@link OpenManifestOptions}).
 */
export async function openManifest(
  bytes: Buffer,
  options: OpenManifestOptions = {},
): Promise<SnapshotManifest> {
  if (!isSealedManifest(bytes)) {
    if (!options.allowUnsealed) {
      throw new Error(
        "manifest is not sealed; refusing to trust unencrypted manifest content from storage",
      );
    }
    return deserializeManifest(bytes);
  }
  const boundTo = sealedManifestKey(bytes);
  if (options.storageKey !== undefined && options.storageKey !== boundTo) {
    throw new Error(`manifest is bound to ${boundTo}, not to ${options.storageKey}`);
  }
  if (!options.open) {
    throw new Error("manifest is encrypted; the tenant key is needed to read it");
  }
  const plaintext = options.open(bytes.subarray(1));
  if (isSealedManifest(plaintext)) {
    throw new Error("sealed manifest has an invalid payload");
  }
  const manifest = await deserializeManifest(plaintext);
  // The key names the tenant and the snapshot, and it is authenticated along
  // with the content, so the two must agree.
  const named = parseManifestKey(boundTo);
  if (!named || named.tenantId !== manifest.tenantId || named.snapshotId !== manifest.snapshotId) {
    throw new Error(`manifest content does not belong to ${boundTo}`);
  }
  return manifest;
}
