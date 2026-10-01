/**
 * Reading archived items back: the item record from its storage key, and its
 * original bytes through the chunk store's own integrity-checked read path
 * (engine/chunkstore.ts). This is what the standalone restore (packages/cli)
 * needs against an archive target with no server and no database — see
 * FORMAT.md.
 */
import { type ChunkReader, readDecodedFromAnyTarget } from "../engine/chunkstore.js";
import type { StorageTargets, TenantKeyring } from "../engine/types.js";
import type { ManifestObject } from "../manifest.js";
import { openArchiveItem } from "./format.js";
import { archiveItemKey } from "./layout.js";
import type { ArchiveItemRecord } from "./types.js";

/**
 * Load one item's sealed record from storage (primary target first, falling
 * back to copies, like a manifest read) and open it with the tenant keyring.
 */
export async function loadArchiveItem(
  storage: StorageTargets,
  keys: TenantKeyring,
  tenantId: string,
  receivedAt: Date,
  itemId: string,
): Promise<ArchiveItemRecord> {
  const key = archiveItemKey(tenantId, receivedAt, itemId);
  const { value } = await readDecodedFromAnyTarget(storage, key, (bytes) =>
    openArchiveItem(bytes, { open: (sealed) => keys.open(sealed), storageKey: key }),
  );
  return value;
}

/** View a record as the {@link ManifestObject} its chunks reconstruct, for {@link ChunkReader}. */
export function archiveItemAsManifestObject(record: ArchiveItemRecord): ManifestObject {
  return {
    path: record.id,
    size: record.size,
    mtime: record.receivedAt.getTime(),
    id: record.id,
    type: "archive-item",
    sha256: record.itemHash,
    chunks: [...record.chunks],
  };
}

/**
 * Reconstruct an archived item's original bytes, verified against its
 * recorded size and SHA-256 (RestoreIntegrityError on mismatch, exactly as
 * for a backup object).
 */
export async function readArchiveItemOriginal(
  reader: ChunkReader,
  record: ArchiveItemRecord,
): Promise<Buffer> {
  return reader.readObjectToBuffer(archiveItemAsManifestObject(record));
}
