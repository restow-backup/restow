/**
 * Postgres implementations of the chunk store's core seams (ChunkIndex,
 * tenant keyring), for the archive journal receiver.
 *
 * These mirror apps/worker/src/handlers/framework.ts's PgChunkIndex and
 * loadTenantKeyring byte-for-byte (same tables, same dedup and refcount
 * semantics): a journal-captured item is chunked, encrypted and deduplicated
 * through the exact same tenant chunk store a backup writes to. They are
 * duplicated here rather than imported from apps/worker because apps/worker
 * is a separate application (its own Docker CMD role), not a published
 * package, and the receiver must run inside the `api` role (docs/
 * ARCHITECTURE.md). Consolidating both into one shared module (most likely
 * @restow/db, which already owns the `chunks`/`packs` schema) is a
 * worthwhile follow-up, left as a known limitation rather than risked as a
 * same-change refactor of the worker's tested code.
 */
import type { ChunkIndex, ChunkLocation, ChunkRecord, KeyProvider, PackRecord } from "@restow/core";
import { Keyring } from "@restow/core";
import { type Database, chunks, packs, tenantKeys } from "@restow/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { type DbExecutor, withTenantTx } from "../../../../apps/api/src/lib/tenant-context.js";

const INSERT_BATCH = 1000;

export type TenantTxRunner = <T>(fn: (tx: DbExecutor) => Promise<T>) => Promise<T>;

export function tenantRunner(db: Database, tenantId: string): TenantTxRunner {
  return (fn) => withTenantTx(db, tenantId, fn);
}

function countOccurrences(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** Postgres-backed {@link ChunkIndex}; see the module docstring. */
export class PgChunkIndex implements ChunkIndex {
  constructor(
    private readonly run: TenantTxRunner,
    private readonly tenantId: string,
  ) {}

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
    const rows = records.filter((record) => {
      const first = !seen.has(record.storedId);
      seen.add(record.storedId);
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
        const batch = rows.slice(i, i + INSERT_BATCH).map((record) => ({
          tenantId: this.tenantId,
          storedId: record.storedId,
          length: record.length,
          packId: pack.id,
          offsetBytes: record.offset,
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
    await this.adjustReferences(storedIds, +1);
  }

  async releaseReferences(storedIds: readonly string[]): Promise<void> {
    await this.adjustReferences(storedIds, -1);
  }

  private async adjustReferences(storedIds: readonly string[], direction: 1 | -1): Promise<void> {
    const counts = [...countOccurrences(storedIds)];
    if (counts.length === 0) {
      return;
    }
    await this.run(async (tx) => {
      for (let i = 0; i < counts.length; i += INSERT_BATCH) {
        const batch = counts.slice(i, i + INSERT_BATCH);
        const values = sql.join(
          batch.map(([id, n]) => sql`(${id}::text, ${n * direction}::int)`),
          sql`, `,
        );
        await tx.execute(sql`
          UPDATE ${chunks} AS c
          SET refcount = GREATEST(0, c.refcount + v.delta), updated_at = now()
          FROM (VALUES ${values}) AS v(stored_id, delta)
          WHERE c.tenant_id = ${this.tenantId}::uuid AND c.stored_id = v.stored_id
        `);
      }
    });
  }
}

/** Load a tenant's DEKs, unwrapped through the key provider (mirrors framework.ts). */
export async function loadTenantKeyring(options: {
  readonly db: Database;
  readonly tenantId: string;
  readonly keyProvider: KeyProvider;
}): Promise<Keyring> {
  const { db, tenantId, keyProvider } = options;
  const rows = await withTenantTx(db, tenantId, (tx) =>
    tx
      .select({ keyVersion: tenantKeys.keyVersion, encryptedDek: tenantKeys.encryptedDek })
      .from(tenantKeys)
      .where(eq(tenantKeys.tenantId, tenantId))
      .orderBy(tenantKeys.keyVersion),
  );
  if (rows.length === 0) {
    throw new Error(`tenant ${tenantId} has no data-encryption key`);
  }
  const deks = [];
  for (const row of rows) {
    deks.push(await keyProvider.unwrapDek(Buffer.from(row.encryptedDek, "base64")));
  }
  return new Keyring(tenantId, deks);
}
