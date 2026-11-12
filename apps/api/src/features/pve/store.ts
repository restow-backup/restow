import {
  type BlockMap,
  type ChunkIndex,
  type ChunkLocation,
  ChunkReader,
  type ChunkRecord,
  ChunkWriter,
  decodeBlockMap,
  INSTALLATION_DEFAULT_TARGET_ID,
  type PackRecord,
  type ResolvedStorageTarget,
  resolveStorageTargets,
  type SecretReader,
  type StorageBackend,
  type StorageTargets,
  storageTargetById,
  type TenantKeyring,
} from "@restow/core";
import { chunks, packs, secrets, storageGeneration, storageTargets } from "@restow/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db.js";
import { loadTenantDek, openSecret } from "../../lib/secrets.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import { defaultWriteOnce } from "../../lib/write-once.js";
import { currentDefaultStorage } from "../restore/storage.js";
import { markerWrapper } from "../restore-mode/markers.js";
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
  /**
   * Every target of the tenant by the id a run records (`pve_runs.storage_target`): primary,
   * copies, retired targets (a retired installation default as `installation_default`).
   */
  readonly targets: readonly ResolvedStorageTarget[];
  /** The primary's id: its row id, or `installation_default`. */
  readonly primaryTarget: string;
  /** The tenant's storage generation these targets were resolved at (`@restow/db`). */
  readonly generation: string;
  /**
   * The installation default, also when it is no target of the tenant (a promotion of 0.4.1
   * dropped it without a trace): runs pinned to it and the search for a repository still
   * reach it. Null when it cannot be opened.
   */
  readonly installationDefault: StorageBackend | null;
}

const CACHE_MS = 60_000;
const cache = new Map<string, { store: TenantChunkStore; expiresAt: number }>();

/**
 * The chunk store of a tenant, cached for a minute (keys rotate rarely). A caller that knows
 * the tenant's current storage generation (the restic routes read it with the run) passes it:
 * a cached store of another generation is resolved afresh, so a change of the primary is seen
 * at once instead of after up to a minute (docs/STORAGE.md, "Runs and storage changes").
 */
export async function tenantChunkStore(
  tenantId: string,
  now = Date.now(),
  generation?: string,
): Promise<TenantChunkStore> {
  const hit = cache.get(tenantId);
  if (
    hit &&
    hit.expiresAt > now &&
    (generation === undefined || hit.store.generation === generation)
  ) {
    return hit.store;
  }
  const { resolved, current } = await withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId))
      .orderBy(asc(storageTargets.createdAt));
    const current = await storageGeneration(tx, tenantId);
    const resolved = await resolveStorageTargets(rows, {
      secrets: tenantSecretReader(tx, tenantId),
      defaults: async () => {
        const d = await currentDefaultStorage();
        return { primary: d.primary, copies: d.copies };
      },
      defaultWriteOnce,
    });
    return { resolved, current };
  });
  const keys = await loadTenantKeyring(db, tenantId);
  const installationDefault =
    resolved.targets.find((target) => target.id === INSTALLATION_DEFAULT_TARGET_ID)?.backend ??
    (await currentDefaultStorage()
      .then((d) => d.primary)
      .catch(() => null));
  // What the api writes for VMs records the database's progress first (restore mode); every
  // backend keeps one wrapper, so `targets`, `write` and `read` still name the same objects.
  const ids = new Map(resolved.targets.map((target) => [target.backend, target.id]));
  const wrap = markerWrapper(tenantId, (backend, fallback) => ids.get(backend) ?? fallback);
  const primary = wrap(resolved.primary, "primary");
  const copies = resolved.copies.map((copy, index) => wrap(copy, `copy:${index}`));
  const store: TenantChunkStore = {
    tenantId,
    write: { primary, copies },
    read: { primary, copies: [...copies, ...resolved.previous] },
    keys,
    index: new PveChunkIndex(tenantId),
    targets: resolved.targets.map((target) =>
      target.role === "previous" ? target : { ...target, backend: wrap(target.backend, target.id) },
    ),
    primaryTarget: resolved.primaryTarget,
    generation: current,
    installationDefault,
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

/**
 * Whether the target a run recorded (or the primary) is write-once (docs/STORAGE.md,
 * "Write-once storage"): its last probe found that it refuses to overwrite or delete.
 */
export function storeTargetWriteOnce(store: TenantChunkStore, id: string): boolean {
  return store.targets.find((target) => target.id === id)?.writeOnce === true;
}

/** A target of the store by the id a run recorded, or null when the tenant has none such. */
export function storeTarget(store: TenantChunkStore, id: string): StorageBackend | null {
  return (
    storageTargetById(store, id) ??
    (id === INSTALLATION_DEFAULT_TARGET_ID ? store.installationDefault : null)
  );
}

/** One place a repository may lie: a target of the tenant, or the installation default. */
export interface SearchedTarget {
  readonly id: string;
  readonly name: string | null;
  readonly role: "primary" | "copy" | "previous" | "installation_default";
  readonly backend: StorageBackend;
}

/**
 * Every place a restic repository of the tenant may lie (docs/STORAGE.md, "Repository
 * problems"): the tenant's targets, and the installation default even when it is no target
 * of the tenant any more (a promotion of 0.4.1 dropped it without a trace). The primary first.
 */
export async function searchedTargets(store: TenantChunkStore): Promise<SearchedTarget[]> {
  const out: SearchedTarget[] = store.targets.map((target) => ({ ...target }));
  if (
    store.installationDefault &&
    !out.some((target) => target.id === INSTALLATION_DEFAULT_TARGET_ID)
  ) {
    out.push({
      id: INSTALLATION_DEFAULT_TARGET_ID,
      name: null,
      role: "installation_default",
      backend: store.installationDefault,
    });
  }
  return out;
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

/**
 * What a decoded block map takes in memory, estimated: an entry object with its hash string and
 * chunk list, and a chunk id string per reference (ids shared between blocks are counted each
 * time, so the estimate errs high). A 2 TB disk in 4 MiB blocks comes to about 200 MB.
 */
export function blockMapBytes(map: BlockMap): number {
  let refs = 0;
  for (const entry of map.entries) {
    refs += entry.chunks.length;
  }
  return 64 + map.entries.length * BLOCK_ENTRY_BYTES + refs * CHUNK_REF_BYTES;
}

const BLOCK_ENTRY_BYTES = 200;
const CHUNK_REF_BYTES = 100;

/**
 * Decoded block maps, least recently used first out, bounded by their estimated size: browsing a
 * VM restore point reads its maps again and again, but a few maps of large disks would otherwise
 * fill the API's memory. A map larger than the whole budget is kept alone: a restore reads its
 * disk's map for every few blocks, and the map is in memory for each of them anyway.
 */
export class BlockMapCache {
  private readonly maps = new Map<string, { map: BlockMap; bytes: number }>();
  private total = 0;

  constructor(private readonly maxBytes: number) {}

  get(key: string): BlockMap | undefined {
    const hit = this.maps.get(key);
    if (!hit) {
      return undefined;
    }
    // Most recently used last.
    this.maps.delete(key);
    this.maps.set(key, hit);
    return hit.map;
  }

  set(key: string, map: BlockMap, bytes = blockMapBytes(map)): void {
    this.delete(key);
    for (const [oldest] of this.maps) {
      if (this.total + bytes <= this.maxBytes) {
        break;
      }
      this.delete(oldest);
    }
    this.maps.set(key, { map, bytes });
    this.total += bytes;
  }

  /** Estimated bytes held. */
  get bytes(): number {
    return this.total;
  }

  get size(): number {
    return this.maps.size;
  }

  clear(): void {
    this.maps.clear();
    this.total = 0;
  }

  private delete(key: string): void {
    const hit = this.maps.get(key);
    if (hit) {
      this.maps.delete(key);
      this.total -= hit.bytes;
    }
  }
}

const mapCache = new BlockMapCache(config.pve.blockMapCacheBytes);

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
