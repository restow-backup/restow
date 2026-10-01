/**
 * Storage key layout of the open format (docs/ARCHITECTURE.md, Chunk-Store).
 *
 *   tenants/<tid>/packs/<xx>/<packid>           sealed chunk packs
 *   tenants/<tid>/manifests/<snapshot>.json.zst  committed snapshot manifests
 *   tenants/<tid>/manifests/<snapshot>.partial   checkpoint of a manifest in progress
 *   tenants/<tid>/keys/<version>                 wrapped (never plaintext) DEKs
 *
 * packages/cli (the standalone restore) relies on exactly these prefixes.
 */

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) {
    throw new Error(`${label} contains characters that are not allowed in a storage key`);
  }
}

export function tenantPrefix(tenantId: string): string {
  assertSafeId(tenantId, "tenant id");
  return `tenants/${tenantId}/`;
}

export function packPrefix(tenantId: string): string {
  return `${tenantPrefix(tenantId)}packs/`;
}

/** Packs fan out into 256 shard directories by the first two characters of their id. */
export function packKey(tenantId: string, packId: string): string {
  assertSafeId(packId, "pack id");
  const shard = packId.slice(0, 2).toLowerCase();
  return `${packPrefix(tenantId)}${shard}/${packId}`;
}

export function manifestPrefix(tenantId: string): string {
  return `${tenantPrefix(tenantId)}manifests/`;
}

export function manifestKey(tenantId: string, snapshotId: string): string {
  assertSafeId(snapshotId, "snapshot id");
  return `${manifestPrefix(tenantId)}${snapshotId}.json.zst`;
}

export function partialManifestKey(tenantId: string, snapshotId: string): string {
  assertSafeId(snapshotId, "snapshot id");
  return `${manifestPrefix(tenantId)}${snapshotId}.partial`;
}

/** What a manifest storage key names. */
export interface ManifestKeyParts {
  readonly tenantId: string;
  readonly snapshotId: string;
  /** True for the checkpoint of a snapshot in progress (`.partial`). */
  readonly partial: boolean;
}

const MANIFEST_KEY =
  /^tenants\/([A-Za-z0-9._-]+)\/manifests\/([A-Za-z0-9._-]+?)(\.json\.zst|\.partial)$/;

/** Parse a key built by {@link manifestKey} or {@link partialManifestKey}; null for anything else. */
export function parseManifestKey(key: string): ManifestKeyParts | null {
  const match = MANIFEST_KEY.exec(key);
  if (!match) {
    return null;
  }
  return { tenantId: match[1], snapshotId: match[2], partial: match[3] === ".partial" };
}

export function keyPrefix(tenantId: string): string {
  return `${tenantPrefix(tenantId)}keys/`;
}

export function wrappedKeyKey(tenantId: string, keyVersion: number): string {
  if (!Number.isInteger(keyVersion) || keyVersion < 0) {
    throw new Error(`invalid key version ${keyVersion}`);
  }
  return `${keyPrefix(tenantId)}${keyVersion}`;
}

/** Download restores land here; the API serves them with an expiring link. */
export function downloadKey(tenantId: string, restoreJobId: string, fileName: string): string {
  assertSafeId(restoreJobId, "restore job id");
  assertSafeId(fileName, "file name");
  return `${tenantPrefix(tenantId)}downloads/${restoreJobId}/${fileName}`;
}
