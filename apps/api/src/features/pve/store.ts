import {
  type BlockMap,
  type ChunkIndex,
  type ChunkLocation,
  ChunkReader,
  type ChunkRecord,
  ChunkWriter,
  type PackRecord,
  type SecretReader,
  type StorageTargets,
  type TenantKeyring,
  decodeBlockMap,
  resolveStorageTargets,
} from "@restow/core";
import { chunks, packs, secrets, storageTargets } from "@restow/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db.js";
import { loadTenantDek, openSecret } from "../../lib/secrets.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import { currentDefaultStorage } from "../restore/storage.js";
import { loadTenantKeyring } from "../snapshots/content.js";

/**
 * The tenant's chunk store from the API process, for the server-side ingest
 * of VM disk blocks (docs/PROXMOX.md 2.4): the node sends plaintext blocks
 * over TLS, the server chunks, encrypts with the tenant DEK and packs them,
 * exactly as the worker does for mail. Writes go to the primary target and
 * every copy target (never to a retired `previous` target); reads fall back
 * to copies and previous targets.
 */

const INSERT_BATCH = 500;

function tenantSecretReader(tx: DbExecutor, tenantId: string): SecretReader {
  return {
    async get(secretId) {
      const [row] = await tx
        .select({ ciphertext: secrets.ciphertext, keyVersion: secrets.keyVersion })
        .from(secrets)
        .where(and(eq(secrets.tenantId, tenantId), eq(secrets.id, secretId)))
        .limit(1);
      if (!row) {
        return null;
      }
      const dek = await loadTenantDek(tx, tenantId, row.keyVersion);
      return openSecret(dek, secretId, row.ciphertext);
    },
  };
}

export interface TenantChunkStore {
  readonly tenantId: string;
  /** Primary and copies: where new packs and manifests go. */
  readonly write: StorageTargets;
  /** Primary, copies and retired targets: where reads look. */
  readonly read: StorageTargets;
  readonly keys: TenantKeyring;
  readonly index: ChunkIndex;
}

const CACHE_MS = 60_000;
const cache = new Map<string, { store: TenantChunkStore; expiresAt: number }>();

/** The chunk store of a tenant, cached for a minute (keys rotate rarely). */
export async function tenantChunkStore(
  tenantId: string,
  now = Date.now(),
): Promise<TenantChunkStore> {
  const hit = cache.get(tenantId);
  if (hit && hit.expiresAt > now) {
    return hit.store;
  }
  const resolved = await withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId))
      .orderBy(asc(storageTargets.createdAt));
    return resolveStorageTargets(rows, {
      secrets: tenantSecretReader(tx, tenantId),
      defaults: async () => {
        const d = await currentDefaultStorage();
        return { primary: d.primary, copies: d.copies };
      },
    });
  });
  const keys = await loadTenantKeyring(db, tenantId);
  const store: TenantChunkStore = {
    tenantId,
    write: { primary: resolved.primary, copies: resolved.copies },
    read: { primary: resolved.primary, copies: [...resolved.copies, ...resolved.previous] },
    keys,
    index: new PveChunkIndex(tenantId),
  };
  if (cache.size > 200) {
    cache.clear();
  }
  cache.set(tenantId, { store, expiresAt: now + CACHE_MS });
  return store;
}

export function forgetTenantChunkStore(tenantId?: string): void {
  if (tenantId) {
    cache.delete(tenantId);
  } else {
    cache.clear();
  }
}

export function newChunkWriter(store: TenantChunkStore): ChunkWriter {
  return new ChunkWriter({
    tenantId: store.tenantId,
    storage: store.write,
    keys: store.keys,
    index: store.index,
  });
}

export function newChunkReader(store: TenantChunkStore): ChunkReader {
  return new ChunkReader({ storage: store.read, keys: store.keys, index: store.index });
}

/** Read a whole small object (a block map, a config) back. */
export async function readObject(store: TenantChunkStore, ids: readonly string[]): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of newChunkReader(store).read(ids)) {
    parts.push(part);
  }
  return Buffer.concat(parts);
}

const mapCache = new Map<string, BlockMap>();

/** A decoded block map, cached by its stored chunk ids (maps never change). */
export async function readBlockMap(
  store: TenantChunkStore,
  mapChunks: readonly string[],
): Promise<BlockMap> {
  const key = `${store.tenantId}:${mapChunks.join(",")}`;
  const hit = mapCache.get(key);
  if (hit) {
    return hit;
  }
  const map = decodeBlockMap(await readObject(store, mapChunks));
  if (mapCache.size > 32) {
    mapCache.delete(mapCache.keys().next().value as string);
  }
  mapCache.set(key, map);
  return map;
}

function countOccurrences(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * The tenant's chunk index (`chunks`, `packs`) for the API process: the same
 * rules as the worker's PgChunkIndex (apps/worker handlers/framework.ts),
 * each call in its own tenant transaction.
 */
export class PveChunkIndex implements ChunkIndex {
  constructor(private readonly tenantId: string) {}

  private run<T>(fn: Parameters<typeof withTenantTx<T>>[2]): Promise<T> {
    return withTenantTx(db, this.tenantId, fn);
  }

  async existing(storedIds: readonly string[]): Promise<Set<string>> {
    if (storedIds.length === 0) {
      return new Set();
    }
    const rows = await this.run((tx) =>
      tx
        .select({ storedId: chunks.storedId })
        .from(chunks)
        .innerJoin(packs, eq(chunks.packId, packs.id))
        .where(
          and(
            eq(chunks.tenantId, this.tenantId),
            inArray(chunks.storedId, [...storedIds]),
            isNull(packs.damagedAt),
          ),
        ),
    );
    return new Set(rows.map((row) => row.storedId));
  }

  async recordPack(pack: PackRecord, records: readonly ChunkRecord[]): Promise<void> {
    const seen = new Set<string>();
    const rows = records.filter((r) => {
      const first = !seen.has(r.storedId);
      seen.add(r.storedId);
      return first;
    });
    await this.run(async (tx) => {
      await tx.insert(packs).values({
        id: pack.id,
        tenantId: this.tenantId,
        path: pack.path,
        sha256: pack.sha256,
        size: pack.size,
      });
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        const batch = rows.slice(i, i + INSERT_BATCH).map((r) => ({
          tenantId: this.tenantId,
          storedId: r.storedId,
          length: r.length,
          packId: pack.id,
          offsetBytes: r.offset,
        }));
        await tx
          .insert(chunks)
          .values(batch)
          .onConflictDoUpdate({
            target: [chunks.tenantId, chunks.storedId],
            set: {
              packId: sql`excluded.pack_id`,
              offsetBytes: sql`excluded.offset_bytes`,
              length: sql`excluded.length`,
            },
            setWhere: sql`${chunks.packId} IN (SELECT ${packs.id} FROM ${packs} WHERE ${packs.tenantId} = ${this.tenantId}::uuid AND ${packs.damagedAt} IS NOT NULL)`,
          });
      }
    });
  }

  async locate(storedIds: readonly string[]): Promise<Map<string, ChunkLocation>> {
    const result = new Map<string, ChunkLocation>();
    if (storedIds.length === 0) {
      return result;
    }
    const rows = await this.run((tx) =>
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

  async addReferences(storedIds: readonly string[]): Promise<void> {
    await this.adjust(storedIds, 1);
  }

  async releaseReferences(storedIds: readonly string[]): Promise<void> {
    await this.adjust(storedIds, -1);
  }

  private async adjust(storedIds: readonly string[], direction: 1 | -1): Promise<void> {
    const counts = [...countOccurrences(storedIds)];
    for (let i = 0; i < counts.length; i += INSERT_BATCH) {
      const batch = counts.slice(i, i + INSERT_BATCH);
      const values = sql.join(
        batch.map(([id, n]) => sql`(${id}::text, ${n * direction}::int)`),
        sql`, `,
      );
      await this.run((tx) =>
        tx.execute(sql`
          UPDATE ${chunks} AS c
          SET refcount = GREATEST(0, c.refcount + v.delta), updated_at = now()
          FROM (VALUES ${values}) AS v(stored_id, delta)
          WHERE c.tenant_id = ${this.tenantId}::uuid AND c.stored_id = v.stored_id
        `),
      );
    }
  }
}
