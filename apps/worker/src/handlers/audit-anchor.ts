/**
 * Daily audit anchors (docs/ARCHITECTURE.md, Audit-Log).
 *
 * Once a UTC day is over, every audit chain — the installation chain and one
 * per tenant — gets an `audit_anchor` row for that day: the `chain_hash` of
 * the day's last entry and the number of entries created that day. The chain
 * verification (GET /api/v1/audit/verify) compares the chain against these
 * seals, which is what exposes a chain that was cut off at the end or
 * recomputed wholesale: both still pass the per-entry link and hash checks.
 * Anchors are append-only like the log itself (packages/db/sql/rls.sql), and
 * each one is also written to the worker log, a copy outside the database.
 *
 * This is installation housekeeping, not tenant work: it has no `jobs` row
 * and is not a member of the tenant job queues. {@link registerAuditAnchor}
 * wires it into pg-boss as its own cron queue. A run is idempotent and
 * catches up on every day since the chain's last anchor, so a worker that was
 * down for a week seals that week on its next run. Days without entries get
 * no anchor; the running day is never sealed.
 */
import {
  type Database,
  type NewAuditAnchor,
  auditAnchor,
  auditLog,
  safeErrorMessage,
  tenants,
} from "@restow/db";
import { type SQL, and, asc, count, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type PgBoss from "pg-boss";

/** pg-boss queue of the anchor run. */
export const AUDIT_ANCHOR_QUEUE = "audit-anchor";

/** Ten past midnight UTC: the previous day is complete by then. */
export const AUDIT_ANCHOR_CRON = "10 0 * * *";

const DAY_MS = 24 * 60 * 60 * 1000;

/** pg-boss settings: one run at a time, retried with backoff when the database hiccups. */
const QUEUE_OPTIONS: PgBoss.Queue = {
  name: AUDIT_ANCHOR_QUEUE,
  policy: "stately",
  retryLimit: 5,
  retryDelay: 600,
  retryBackoff: true,
  expireInHours: 2,
  retentionDays: 30,
};

/** The logging the run needs (the worker's structured logger satisfies it). */
export interface AnchorLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface AuditAnchorDeps {
  readonly db: Database;
  readonly logger: AnchorLogger;
  /** Clock of the run; defaults to the system clock. */
  readonly now?: () => Date;
}

export interface AuditAnchorRunSummary {
  /** Chains looked at: the installation chain plus one per tenant. */
  readonly chains: number;
  readonly anchorsWritten: number;
  /** Chains whose anchors could not be written; the retry picks them up. */
  readonly failedChains: number;
}

/** A run that could not seal every chain; pg-boss retries the whole (idempotent) run. */
export class AuditAnchorRunError extends Error {
  readonly summary: AuditAnchorRunSummary;

  constructor(summary: AuditAnchorRunSummary) {
    super(`audit anchors missing for ${summary.failedChains} of ${summary.chains} chains`);
    this.name = "AuditAnchorRunError";
    this.summary = summary;
  }
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Midnight UTC starting the day that contains `at`. */
export function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** Midnight UTC starting the day after `day` (`YYYY-MM-DD`). */
export function dayAfter(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS);
}

/**
 * The chain head among the entries sharing a day's last timestamp: the one
 * no other entry of the run links to. Nearly always the run is one entry.
 * Should the run be forked, the newest id wins — the entry the audit helper
 * links the next append to — and the verification reports the fork.
 */
export function chainHeadOf(
  run: readonly { prevHash: string | null; chainHash: string }[],
): string | null {
  const linkedTo = new Set(run.map((entry) => entry.prevHash));
  const heads = run.filter((entry) => !linkedTo.has(entry.chainHash));
  return (heads[heads.length - 1] ?? run[run.length - 1])?.chainHash ?? null;
}

/** Advisory lock serializing anchor writes per chain (NULL tenants never conflict on the unique index). */
export function anchorLockKey(tenantId: string | null): string {
  return `restow.audit-anchor:${tenantId ?? "provider"}`;
}

/**
 * Run `fn` in a transaction that sees the chain: tenant chains pinned for
 * Row Level Security, the installation chain on the provider role.
 */
function inChainTx<T>(
  db: Database,
  tenantId: string | null,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    if (tenantId !== null) {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    }
    return fn(tx);
  });
}

/** Seal every complete, unsealed day of one chain before `before` (a UTC midnight). */
export async function anchorChain(
  db: Database,
  tenantId: string | null,
  before: Date,
): Promise<NewAuditAnchor[]> {
  const entriesOfChain: SQL =
    tenantId === null ? isNull(auditLog.tenantId) : eq(auditLog.tenantId, tenantId);
  const anchorsOfChain: SQL =
    tenantId === null ? isNull(auditAnchor.tenantId) : eq(auditAnchor.tenantId, tenantId);

  return inChainTx(db, tenantId, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${anchorLockKey(tenantId)}))`);

    const [latest] = await tx
      .select({ date: auditAnchor.anchorDate })
      .from(auditAnchor)
      .where(anchorsOfChain)
      .orderBy(desc(auditAnchor.anchorDate))
      .limit(1);
    const since = latest ? dayAfter(latest.date) : null;

    const day = sql<string>`to_char(${auditLog.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
    const days = await tx
      .select({
        day,
        entries: count(),
        // Full database precision, so the run of the last timestamp is found exactly.
        lastAt: sql<string>`max(${auditLog.createdAt})::text`,
      })
      .from(auditLog)
      .where(
        and(
          entriesOfChain,
          since ? gte(auditLog.createdAt, since) : undefined,
          lt(auditLog.createdAt, before),
        ),
      )
      .groupBy(day)
      .orderBy(day);

    const anchors: NewAuditAnchor[] = [];
    for (const { day: anchorDate, entries, lastAt } of days) {
      const run = await tx
        .select({ prevHash: auditLog.prevHash, chainHash: auditLog.chainHash })
        .from(auditLog)
        .where(and(entriesOfChain, sql`${auditLog.createdAt} = ${lastAt}::timestamptz`))
        .orderBy(asc(auditLog.id));
      const lastHash = chainHeadOf(run);
      if (lastHash !== null) {
        anchors.push({ tenantId, anchorDate, lastHash, count: entries });
      }
    }
    if (anchors.length > 0) {
      await tx.insert(auditAnchor).values(anchors);
    }
    return anchors;
  });
}

/** Seal the finished days of every chain. Throws after trying all chains if any failed. */
export async function writeAuditAnchors(deps: AuditAnchorDeps): Promise<AuditAnchorRunSummary> {
  const before = startOfUtcDay((deps.now ?? (() => new Date()))());
  const tenantRows = await deps.db
    .select({ id: tenants.id })
    .from(tenants)
    .orderBy(asc(tenants.createdAt), asc(tenants.id));
  const chains: (string | null)[] = [null, ...tenantRows.map((row) => row.id)];

  let anchorsWritten = 0;
  let failedChains = 0;
  for (const tenantId of chains) {
    try {
      const written = await anchorChain(deps.db, tenantId, before);
      anchorsWritten += written.length;
      for (const anchor of written) {
        // Hashes are not secrets; the log line is the anchor's copy outside the database.
        deps.logger.info("audit chain anchored", {
          tenantId,
          anchorDate: anchor.anchorDate,
          lastHash: anchor.lastHash,
          count: anchor.count,
        });
      }
    } catch (error) {
      failedChains += 1;
      deps.logger.error("audit chain anchoring failed", {
        tenantId,
        errorMessage: safeErrorMessage(error),
      });
    }
  }

  const summary: AuditAnchorRunSummary = { chains: chains.length, anchorsWritten, failedChains };
  if (failedChains > 0) {
    throw new AuditAnchorRunError(summary);
  }
  deps.logger.info("audit anchor run finished", { ...summary, sealedBefore: before.toISOString() });
  return summary;
}

/** The anchor run as the worker's housekeeping handler. */
export const auditAnchorHandler = {
  queue: AUDIT_ANCHOR_QUEUE,
  cron: AUDIT_ANCHOR_CRON,
  run: writeAuditAnchors,
} as const;

/**
 * Wire the anchor run into pg-boss: its queue, the nightly UTC schedule, a
 * worker, and one immediate run so days missed while the worker was down are
 * sealed now rather than tomorrow night. Safe on every start and on several
 * workers at once (the schedule is an upsert, the queue runs one job at a
 * time, the per-chain lock and "since the last anchor" make runs idempotent).
 */
export async function registerAuditAnchor(boss: PgBoss, deps: AuditAnchorDeps): Promise<void> {
  await boss.createQueue(AUDIT_ANCHOR_QUEUE, QUEUE_OPTIONS);
  await boss.updateQueue(AUDIT_ANCHOR_QUEUE, QUEUE_OPTIONS);
  await boss.schedule(AUDIT_ANCHOR_QUEUE, AUDIT_ANCHOR_CRON, {}, { tz: "UTC" });
  await boss.work(AUDIT_ANCHOR_QUEUE, { batchSize: 1 }, async () => {
    await auditAnchorHandler.run(deps);
  });
  await boss.send(AUDIT_ANCHOR_QUEUE, {});
}
