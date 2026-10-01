import {
  type ChunkIndex,
  type ChunkLocation,
  ChunkReader,
  Keyring,
  type ManifestObject,
  type TenantKeyring,
} from "@restow/core";
import { chunks, packs, tenantKeys } from "@restow/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { keyProvider } from "../../lib/secrets.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { resolveTenantStorage } from "../restore/storage.js";

/**
 * Reads the plaintext bytes of one manifest object (a mail message) straight
 * from the chunk store, for the mail preview (routes.ts). This is the read
 * side only of the worker's own path (apps/worker/src/handlers/framework.ts
 * `loadTenantKeyring` / `PgChunkIndex`): the preview never writes a chunk, so
 * it needs none of the writer's bookkeeping. Storage targets come from the
 * existing restore read path (restore/storage.ts, imported, not modified).
 */

/** All of a tenant's data-encryption keys, unwrapped, so a chunk of any age can be opened. */
export async function loadTenantKeyring(db: DbExecutor, tenantId: string): Promise<TenantKeyring> {
  const rows = await withTenantTx(db, tenantId, (tx) =>
    tx
      .select({ keyVersion: tenantKeys.keyVersion, encryptedDek: tenantKeys.encryptedDek })
      .from(tenantKeys)
      .where(eq(tenantKeys.tenantId, tenantId))
      .orderBy(asc(tenantKeys.keyVersion)),
  );
  if (rows.length === 0) {
    throw new ProblemError(500, "Tenant key missing", {
      type: "urn:restow:problem:tenant-key-missing",
      detail: "The tenant has no data encryption key; its backup content cannot be read.",
    });
  }
  const provider = keyProvider();
  const deks = await Promise.all(
    rows.map((row) => provider.unwrapDek(Buffer.from(row.encryptedDek, "base64"))),
  );
  return new Keyring(tenantId, deks);
}

/**
 * Locates chunks in `chunks`/`packs` for {@link ChunkReader}. Read-only: the
 * preview never records a pack or adjusts a refcount, so those methods are
 * refused rather than silently doing nothing.
 */
class ReadOnlyChunkIndex implements ChunkIndex {
  constructor(
    private readonly db: DbExecutor,
    private readonly tenantId: string,
  ) {}

  async locate(storedIds: readonly string[]): Promise<Map<string, ChunkLocation>> {
    const result = new Map<string, ChunkLocation>();
    if (storedIds.length === 0) {
      return result;
    }
    const rows = await withTenantTx(this.db, this.tenantId, (tx) =>
      tx
        .select({
          storedId: chunks.storedId,
          offset: chunks.offsetBytes,
          length: chunks.length,
          packPath: packs.path,
        })
        .from(chunks)
        .innerJoin(packs, eq(chunks.packId, packs.id))
        .where(and(eq(chunks.tenantId, this.tenantId), inArray(chunks.storedId, [...storedIds]))),
    );
    for (const row of rows) {
      result.set(row.storedId, row);
    }
    return result;
  }

  async existing(): Promise<Set<string>> {
    throw new Error("read-only chunk index: existing() is not supported");
  }

  async recordPack(): Promise<void> {
    throw new Error("read-only chunk index: recordPack() is not supported");
  }

  async addReferences(): Promise<void> {
    throw new Error("read-only chunk index: addReferences() is not supported");
  }

  async releaseReferences(): Promise<void> {
    throw new Error("read-only chunk index: releaseReferences() is not supported");
  }
}

/** The `manifest_objects` fields a chunk read needs. */
export interface ReadableManifestEntry {
  readonly path: string;
  readonly size: number;
  readonly mtime: Date | null;
  readonly itemId: string | null;
  readonly chunkRefs: readonly string[] | null;
  readonly metadata: Record<string, unknown> | null;
}

/** `ManifestObject.metadata` is a string map (the manifest contract); non-string values are dropped. */
function metadataStrings(
  metadata: Record<string, unknown> | null,
): Record<string, string> | undefined {
  if (!metadata) {
    return undefined;
  }
  const strings: Record<string, string> = {};
  let any = false;
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") {
      strings[key] = value;
      any = true;
    }
  }
  return any ? strings : undefined;
}

function toManifestObject(entry: ReadableManifestEntry): ManifestObject {
  const metadata = metadataStrings(entry.metadata);
  const sha256 = metadata?.sha256;
  return {
    path: entry.path,
    size: entry.size,
    mtime: entry.mtime ? entry.mtime.getTime() : 0,
    id: entry.itemId ?? undefined,
    type: "mail",
    ...(metadata ? { metadata } : {}),
    ...(sha256 ? { sha256 } : {}),
    chunks: [...(entry.chunkRefs ?? [])],
  };
}

/** The message's chunks are missing, damaged, or fail to decrypt/verify. */
export class ContentUnavailableError extends Error {
  constructor(cause: unknown) {
    super("the message content could not be read from storage", { cause });
    this.name = "ContentUnavailableError";
  }
}

/**
 * The plaintext bytes of one manifest object (a mail message), decrypted and
 * verified against the manifest's recorded size (and hash, when known). Pass
 * an open transaction as `db` to read within the caller's tenant pinning and
 * audit transaction (nested calls open a savepoint, see tenant-context.ts).
 */
export async function readManifestObjectBytes(
  db: DbExecutor,
  tenantId: string,
  entry: ReadableManifestEntry,
): Promise<Buffer> {
  // Sequential, not Promise.all: when `db` is itself an open transaction (the
  // caller's own tenant-pinned transaction), each of these opens a nested
  // savepoint on that one connection (tenant-context.ts `withTenantTx`).
  // Running them concurrently would race two savepoints for the same
  // auto-generated name on the one connection, corrupting whichever
  // statement rolls back; a connection runs one query at a time (see
  // verify/verification-state.ts).
  const keys = await loadTenantKeyring(db, tenantId);
  const storage = await resolveTenantStorage(db, tenantId);
  const reader = new ChunkReader({ storage, keys, index: new ReadOnlyChunkIndex(db, tenantId) });
  try {
    return await reader.readObjectToBuffer(toManifestObject(entry));
  } catch (error) {
    throw new ContentUnavailableError(error);
  }
}
