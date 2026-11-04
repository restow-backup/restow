/**
 * The storage generation of a tenant and the lock around a change of its primary
 * (docs/STORAGE.md, "Runs and storage changes").
 *
 * A restic repository must be written to by one target for the whole of a run: a run that
 * resolves the primary per request writes its first packs to the old primary and its snapshot
 * to the new one when the primary changes in the middle (the 2026-10-16 field incident). So:
 *
 *   - a run records the target its credential was issued for (`storage_target`, a target id or
 *     {@link INSTALLATION_DEFAULT_TARGET}) and the generation then;
 *   - every change of the primary (promoting a copy, "keep", the switch of a "move") and every
 *     credential issue take {@link lockTenantStorage} in their transaction, so a credential is
 *     never issued for a primary that a concurrent switch is about to retire, and a switch sees
 *     every run that already has its credential;
 *   - caches of the resolved targets compare {@link storageGeneration} with the generation they
 *     were resolved at instead of relying on their time to live only.
 *
 * The generation is a fingerprint of the tenant's `storage_targets` rows (id, role, kind,
 * addressing, credentials), so it changes with every addition, removal, role change or edit,
 * and not with a probe or a usage update.
 */
import { type SQL, sql } from "drizzle-orm";

/** `storage_target` of a run whose target is the installation default (no row of its own). */
export const INSTALLATION_DEFAULT_TARGET = "installation_default";

/** Anything that runs a statement: a transaction or a database (drizzle, node-postgres). */
export interface StorageGenerationExecutor {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

/** The key of a tenant's storage lock (`pg_advisory_xact_lock(hashtext(...))`). */
export function storageLockKey(tenantId: string): string {
  return `restow:storage-switch:${tenantId}`;
}

/** Take the tenant's storage lock until the end of the current transaction. */
export async function lockTenantStorage(
  tx: StorageGenerationExecutor,
  tenantId: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${storageLockKey(tenantId)}))`);
}

/** The SQL expression of a tenant's storage generation (for a sub-select). */
export function storageGenerationSql(tenantId: SQL | string): SQL {
  const id = typeof tenantId === "string" ? sql`${tenantId}::uuid` : tenantId;
  return sql`(select md5(coalesce(string_agg(st.id::text || ':' || st.role::text || ':' || st.kind::text || ':' || md5(st.config::text) || ':' || coalesce(st.secret_ref::text, ''), ',' order by st.id), '')) from storage_targets st where st.tenant_id = ${id})`;
}

/** The tenant's current storage generation. */
export async function storageGeneration(
  tx: StorageGenerationExecutor,
  tenantId: string,
): Promise<string> {
  const result = await tx.execute(sql`select ${storageGenerationSql(tenantId)} as generation`);
  return String(result.rows[0]?.generation ?? "");
}

/** The tenant's primary target as a run records it: the primary row's id, else the default. */
export async function currentPrimaryTarget(
  tx: StorageGenerationExecutor,
  tenantId: string,
): Promise<string> {
  const result = await tx.execute(
    sql`select id::text as id from storage_targets where tenant_id = ${tenantId}::uuid and role = 'primary' limit 1`,
  );
  const id = result.rows[0]?.id;
  return typeof id === "string" ? id : INSTALLATION_DEFAULT_TARGET;
}
