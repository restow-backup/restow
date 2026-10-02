import {
  type AuditEvent,
  type AuditPayload,
  actorLabel,
  auditPayload,
  canonicalJson,
  chainLockKey,
  computeChainHash,
  nextCreatedAt,
} from "@restow/core";
import { type AuditLogEntry, type NewAuditLogEntry, auditLog } from "@restow/db";
import { desc, eq, isNull, sql } from "drizzle-orm";
import { type DbExecutor, isTransaction, withTenantTx } from "./tenant-context.js";

/**
 * Append-only audit log with a per-tenant hash chain (docs/ARCHITECTURE.md,
 * Audit-Log). Every entry links to its predecessor:
 *
 *   chain_hash = SHA-256( prev_hash || canonical_json(fields) || created_at )
 *
 * `prev_hash` is the previous entry's `chain_hash` in the same chain (one chain
 * per tenant, plus one installation-level chain for events without a tenant),
 * or the empty string for the first entry. `created_at` is the ISO-8601 UTC
 * timestamp that is persisted with the row, so the stored row alone suffices to
 * re-verify the chain (see {@link verifyAuditChain}). Appends to one chain are
 * serialized with a transaction-scoped advisory lock so two concurrent events
 * can never claim the same predecessor.
 *
 * The hash math itself (canonical JSON, the chain hash, the lock key, the
 * strictly increasing timestamp) lives in @restow/core (audit-chain.ts) and is
 * re-exported here unchanged, so apps/worker's own, much smaller set of
 * automatic events hashes exactly the same way and never forks the chain.
 *
 * UPDATE/DELETE are forbidden by a database trigger (packages/db/sql/rls.sql).
 */

export type { AuditEvent, AuditPayload };
export { actorLabel, auditPayload, canonicalJson, chainLockKey, computeChainHash, nextCreatedAt };

/** Well-known audit actions written by the spine. Features add their own. */
export const AUDIT_ACTIONS = {
  setupCompleted: "setup.completed",
  // The setup finished but the operator's own organisation could not be created (installation chain).
  setupInternalTenantFailed: "setup.internal_tenant_failed",
  tenantCreated: "tenant.created",
  tenantUpdated: "tenant.updated",
  tenantDeleted: "tenant.deleted",
  // A tenant became the operator's own organisation, or stopped being it (tenant chain).
  tenantInternalMarked: "tenant.internal.marked",
  tenantInternalUnmarked: "tenant.internal.unmarked",
  tenantMemberAdded: "tenant.member.added",
  tenantMemberInvited: "tenant.member.invited",
  tenantKeyCreated: "tenant.key.created",
} as const;

/** The payload as it was hashed, reconstructed from a stored row. */
export function payloadFromEntry(entry: AuditLogEntry): AuditPayload {
  return {
    tenantId: entry.tenantId,
    actor: entry.actor,
    actorUserId: entry.actorUserId,
    action: entry.action,
    target: entry.target,
    targetType: entry.targetType,
    onBehalfOf: entry.onBehalfOf,
    ip: entry.ip,
    details: entry.details ?? null,
  };
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  /** Index (in the given order) of the first entry whose hash or link is wrong. */
  brokenAt: number | null;
}

/**
 * Re-verify a chain given its entries in insertion order (oldest first). Checks
 * that every `prev_hash` equals the previous `chain_hash` and that every
 * `chain_hash` recomputes from the stored fields.
 */
export function verifyAuditChain(entries: readonly AuditLogEntry[]): ChainVerification {
  let expectedPrev: string | null = null;
  for (const [index, entry] of entries.entries()) {
    const linked = (entry.prevHash ?? null) === expectedPrev;
    const recomputed = computeChainHash(entry.prevHash, payloadFromEntry(entry), entry.createdAt);
    if (!linked || recomputed !== entry.chainHash) {
      return { ok: false, checked: index + 1, brokenAt: index };
    }
    expectedPrev = entry.chainHash;
  }
  return { ok: true, checked: entries.length, brokenAt: null };
}

async function appendInTx(tx: DbExecutor, event: AuditEvent): Promise<AuditLogEntry> {
  const payload = auditPayload(event);
  const sameChain =
    payload.tenantId === null ? isNull(auditLog.tenantId) : eq(auditLog.tenantId, payload.tenantId);

  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${chainLockKey(payload.tenantId)}))`);

  const [last] = await tx
    .select({ chainHash: auditLog.chainHash, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(sameChain)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(1);

  const createdAt = nextCreatedAt(last?.createdAt ?? null, new Date());
  const prevHash = last?.chainHash ?? null;
  const row: NewAuditLogEntry = {
    ...payload,
    prevHash,
    chainHash: computeChainHash(prevHash, payload, createdAt),
    createdAt,
  };
  const [inserted] = await tx.insert(auditLog).values(row).returning();
  if (!inserted) {
    throw new Error("audit log insert returned no row");
  }
  return inserted;
}

/**
 * Append an audit entry. Tenant events are written inside a tenant-pinned
 * transaction (RLS); installation-level events (no tenant) inside a plain one.
 * When called with an open transaction, the entry joins it (savepoint), so an
 * action and its audit record commit or roll back together.
 */
export async function audit(db: DbExecutor, event: AuditEvent): Promise<AuditLogEntry> {
  if (isTransaction(db)) {
    return db.transaction((tx) => appendInTx(tx, event));
  }
  const tenantId = event.tenantId ?? null;
  if (tenantId !== null) {
    return withTenantTx(db, tenantId, (tx) => appendInTx(tx, event));
  }
  return db.transaction((tx) => appendInTx(tx, event));
}
