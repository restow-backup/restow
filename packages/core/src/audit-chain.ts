import { createHash } from "node:crypto";

/**
 * The pure math behind the audit log's hash chain (docs/ARCHITECTURE.md,
 * Audit-Log): canonical JSON, the chain hash and the strictly increasing
 * timestamp that orders entries. Two apps append to the chain — apps/api
 * (the spine, `lib/audit.ts`, every human-facing event) and apps/worker (a
 * handful of automatic events, e.g. the first backup enqueued right after a
 * directory sync) — and both import this so they never compute a hash
 * differently and fork the chain. Storage (the transaction, the advisory
 * lock, the insert) stays each app's own: the two have different
 * tenant-pinning machinery and neither depends on the other.
 */

/** The persisted, hash-covered fields of an entry (column values, not the row id). */
export interface AuditPayload {
  tenantId: string | null;
  actor: string;
  actorUserId: string | null;
  action: string;
  target: string | null;
  targetType: string | null;
  onBehalfOf: string | null;
  ip: string | null;
  details: Record<string, unknown> | null;
}

/** A caller's event, before it is normalized into an {@link AuditPayload}. */
export interface AuditEvent {
  /** Tenant the event belongs to; omit for installation-level events. */
  tenantId?: string | null;
  /**
   * Human-readable actor label (an email, `system`, `api-key:<id>`). Defaults to
   * `user:<actorUserId>` or `system`.
   */
  actor?: string;
  /** The acting better-auth user id, when a signed-in person triggered the event. */
  actorUserId?: string | null;
  /** Dotted event name, e.g. `restore.started`. */
  action: string;
  /** What was acted on (a mailbox, snapshot id, tenant id, ...). */
  target?: string | null;
  /** The target's type, e.g. `tenant`, `snapshot`, `mailbox`. */
  targetType?: string | null;
  /** On whose behalf, when an admin acts for another user (impersonation). */
  onBehalfOf?: string | null;
  /** Client IP the action came from. */
  ip?: string | null;
  /** Structured context (counts, selection, reason). Never secrets. */
  details?: Record<string, unknown> | null;
}

const GENESIS_PREV_HASH = "";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, member]) => [key, sortKeys(member)]));
  }
  return value;
}

/**
 * Deterministic JSON: object keys sorted recursively, `undefined` members
 * dropped, arrays kept in order, dates as ISO strings. Equal values always
 * serialize identically, which is what makes the hash reproducible.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Compute an entry's chain hash from its predecessor, payload and timestamp. */
export function computeChainHash(
  prevHash: string | null,
  payload: AuditPayload,
  createdAt: Date,
): string {
  return createHash("sha256")
    .update(prevHash ?? GENESIS_PREV_HASH, "utf8")
    .update(canonicalJson(payload), "utf8")
    .update(createdAt.toISOString(), "utf8")
    .digest("hex");
}

/** Default actor label when the caller did not name one. */
export function actorLabel(event: Pick<AuditEvent, "actor" | "actorUserId">): string {
  if (event.actor && event.actor.length > 0) {
    return event.actor;
  }
  return event.actorUserId ? `user:${event.actorUserId}` : "system";
}

/** Normalize an event into the exact column values that get hashed and stored. */
export function auditPayload(event: AuditEvent): AuditPayload {
  const details =
    event.details && Object.keys(event.details).length > 0
      ? (JSON.parse(canonicalJson(event.details)) as Record<string, unknown>)
      : null;
  return {
    tenantId: event.tenantId ?? null,
    actor: actorLabel(event),
    actorUserId: event.actorUserId ?? null,
    action: event.action,
    target: event.target ?? null,
    targetType: event.targetType ?? null,
    onBehalfOf: event.onBehalfOf ?? null,
    ip: event.ip ?? null,
    details,
  };
}

/** Lock key that serializes appends to one chain within the transaction. */
export function chainLockKey(tenantId: string | null): string {
  return `restow.audit:${tenantId ?? "provider"}`;
}

/**
 * The timestamp of the next entry in a chain: now, but always at least one
 * millisecond after the chain's last entry. The predecessor is found by
 * `created_at`, so two appends within the same millisecond (or after the clock
 * stepped back) must never tie; a tie broken by the random row id could link
 * an entry to the wrong predecessor and fork the chain.
 */
export function nextCreatedAt(lastCreatedAt: Date | null, now: Date): Date {
  if (lastCreatedAt === null || now.getTime() > lastCreatedAt.getTime()) {
    return now;
  }
  return new Date(lastCreatedAt.getTime() + 1);
}
