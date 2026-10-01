/**
 * Audit log appends written directly by the worker.
 *
 * The worker runs jobs, not admin requests, so almost every audit entry is
 * still written by apps/api (`lib/audit.ts`) around the request that caused
 * it. The one exception today: the system enqueueing an object's first
 * backup right after a directory sync finds it newly protected
 * (handlers/directory.ts) has no request to hang an entry off, so the worker
 * appends it itself, here, inside the same tenant-pinned transaction as the
 * enqueue.
 *
 * The chain hash math (canonical JSON, the chain hash, the lock key, the
 * strictly increasing timestamp) is @restow/core's audit-chain.ts, shared
 * unchanged with apps/api, so the two never compute a hash differently and
 * fork the chain. Only the storage step below — the advisory lock, the
 * predecessor lookup, the insert — is worker-local, because it runs over the
 * worker's own `TenantTx` rather than apps/api's transaction type.
 */
import {
  type AuditEvent,
  auditPayload,
  chainLockKey,
  computeChainHash,
  nextCreatedAt,
} from "@restow/core";
import { type AuditLogEntry, type NewAuditLogEntry, auditLog } from "@restow/db";
import { desc, eq, isNull, sql } from "drizzle-orm";
import type { TenantTx } from "./progress.js";

/** Append one audit entry inside the caller's tenant-pinned transaction. */
export async function appendAuditEntry(tx: TenantTx, event: AuditEvent): Promise<AuditLogEntry> {
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
