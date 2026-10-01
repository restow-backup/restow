import { type AuditLogEntry, type Database, auditAnchor, auditLog, tenants } from "@restow/db";
import {
  type SQL,
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  isNull,
  like,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  type DbExecutor,
  type Transaction,
  pinTenantStatement,
  withTenantTx,
} from "../../../../apps/api/src/lib/tenant-context.js";
import { ProblemError } from "../../../../apps/api/src/problem.js";
import {
  type ChainEntry,
  type ChainResult,
  ChainWalker,
  pushInChainOrder,
  splitTrailingTieGroup,
} from "./chain.js";
import { type AuditCursor, type Page, decodeAuditCursor, pageOf } from "./cursor.js";
import {
  type AuditActionDto,
  type AuditEntryDto,
  type ChainReportDto,
  type VerifyResponseDto,
  overallStatus,
  toChainReportDto,
  toEntryDto,
} from "./dto.js";
import { resolveTargetLabels, targetLabelOf } from "./labels.js";
import { type ChainFilterParam, INSTALLATION_CHAIN, type ListAuditQuery } from "./schemas.js";

/**
 * Reading and verifying the audit log.
 *
 * Who sees what: provider admins read every chain — all tenants plus the
 * installation chain — on the installation pool (BYPASSRLS, like the tenant
 * list; the routes pass it for the `all` and `installation` selections); a
 * single tenant is read inside a tenant-pinned transaction. Tenant admins read
 * their own tenant's chain only, always tenant-pinned on the application pool,
 * so Row Level Security enforces the boundary a second time.
 *
 * Reading the log is not itself audited: it holds who-did-what metadata, not
 * mailbox or backup content, and an entry per look would grow the very chain
 * an operator is inspecting.
 */

/** What the requester may read. */
export type AuditScope = { kind: "provider" } | { kind: "tenant"; tenantId: string };

/** Which chains a request covers. */
export type ChainSelection =
  | { kind: "all" }
  | { kind: "installation" }
  | { kind: "tenant"; tenantId: string };

/** A chain named for reports; `tenantId: null` is the installation chain. */
export interface ChainRef {
  tenantId: string | null;
  tenantName: string | null;
}

const INSTALLATION: ChainRef = { tenantId: null, tenantName: null };

/** Upper bound of distinct actions the filter facet lists. */
export const MAX_ACTIONS = 1000;
/** Entries read per round trip while walking a chain. */
export const WALK_BATCH = 1000;

/** Resolve the requested `tenant` filter against what the requester may see. */
export function selectChains(
  scope: AuditScope,
  requested: ChainFilterParam | undefined,
): ChainSelection {
  if (scope.kind === "tenant") {
    if (requested !== undefined && requested !== scope.tenantId) {
      // Same answer as for any tenant the requester is not a member of.
      throw new ProblemError(404, "Tenant not found");
    }
    return { kind: "tenant", tenantId: scope.tenantId };
  }
  if (requested === undefined) {
    return { kind: "all" };
  }
  return requested === INSTALLATION_CHAIN
    ? { kind: "installation" }
    : { kind: "tenant", tenantId: requested };
}

/** The selection a single-entry lookup runs under. */
function entrySelection(scope: AuditScope): ChainSelection {
  return scope.kind === "tenant" ? { kind: "tenant", tenantId: scope.tenantId } : { kind: "all" };
}

/** Restrict a `tenant_id` column to the selected chains (none for `all`). */
export function chainCondition(column: AnyPgColumn, selection: ChainSelection): SQL | undefined {
  switch (selection.kind) {
    case "all":
      return undefined;
    case "installation":
      return isNull(column);
    case "tenant":
      return eq(column, selection.tenantId);
  }
}

/** Escape LIKE/ILIKE wildcards so user input matches literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Every WHERE condition of a list query, in a stable order. */
export function listConditions(
  selection: ChainSelection,
  query: Pick<ListAuditQuery, "action" | "actor" | "target" | "from" | "to">,
  cursor: AuditCursor | null,
): SQL[] {
  const conditions: (SQL | undefined)[] = [chainCondition(auditLog.tenantId, selection)];
  if (query.action) {
    // `restore` matches `restore` itself and everything below it (`restore.requested`).
    conditions.push(
      or(eq(auditLog.action, query.action), like(auditLog.action, `${escapeLike(query.action)}.%`)),
    );
  }
  if (query.actor) {
    conditions.push(
      or(
        ilike(auditLog.actor, `%${escapeLike(query.actor)}%`),
        eq(auditLog.actorUserId, query.actor),
      ),
    );
  }
  if (query.target) {
    conditions.push(ilike(auditLog.target, `%${escapeLike(query.target)}%`));
  }
  if (query.from) {
    conditions.push(gte(auditLog.createdAt, new Date(query.from)));
  }
  if (query.to) {
    conditions.push(lt(auditLog.createdAt, new Date(query.to)));
  }
  if (cursor) {
    const at = new Date(cursor.createdAt);
    conditions.push(
      or(lt(auditLog.createdAt, at), and(eq(auditLog.createdAt, at), lt(auditLog.id, cursor.id))),
    );
  }
  return conditions.filter((condition): condition is SQL => condition !== undefined);
}

/** Run `fn` where the selection may be read: tenant-pinned for one tenant. */
function readIn<T>(
  db: Database,
  selection: ChainSelection,
  fn: (executor: DbExecutor) => Promise<T>,
): Promise<T> {
  return selection.kind === "tenant" ? withTenantTx(db, selection.tenantId, fn) : fn(db);
}

function parseCursor(value: string | undefined): AuditCursor | null {
  if (value === undefined) {
    return null;
  }
  const cursor = decodeAuditCursor(value);
  if (!cursor) {
    throw new ProblemError(422, "Invalid cursor", {
      detail: "The cursor is not one this endpoint issued. Start again from the first page.",
    });
  }
  return cursor;
}

/** Audit entries matching the filters, newest first. */
export async function listAuditEntries(
  db: Database,
  selection: ChainSelection,
  query: ListAuditQuery,
): Promise<Page<AuditEntryDto>> {
  const cursor = parseCursor(query.cursor);
  const { rows, labels } = await readIn(db, selection, async (executor) => {
    const found = await executor
      .select({ entry: auditLog, tenantName: tenants.name })
      .from(auditLog)
      .leftJoin(tenants, eq(tenants.id, auditLog.tenantId))
      .where(and(...listConditions(selection, query, cursor)))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(query.limit + 1);
    return {
      rows: found,
      labels: await resolveTargetLabels(
        executor,
        found.map((row) => row.entry),
      ),
    };
  });
  const page = pageOf(rows, query.limit, (row) => row.entry);
  return {
    items: page.rows.map((row) =>
      toEntryDto(row.entry, row.tenantName, targetLabelOf(row.entry, labels)),
    ),
    next: page.next,
  };
}

/** One entry, if the requester may see it. */
export async function getAuditEntry(
  db: Database,
  scope: AuditScope,
  entryId: string,
): Promise<AuditEntryDto> {
  const selection = entrySelection(scope);
  const { row, labels } = await readIn(db, selection, async (executor) => {
    const [found] = await executor
      .select({ entry: auditLog, tenantName: tenants.name })
      .from(auditLog)
      .leftJoin(tenants, eq(tenants.id, auditLog.tenantId))
      .where(and(eq(auditLog.id, entryId), chainCondition(auditLog.tenantId, selection)))
      .limit(1);
    return {
      row: found,
      labels: found
        ? await resolveTargetLabels(executor, [found.entry])
        : new Map<string, string>(),
    };
  });
  if (!row) {
    throw new ProblemError(404, "Audit entry not found");
  }
  return toEntryDto(row.entry, row.tenantName, targetLabelOf(row.entry, labels));
}

/** The actions recorded in the selected chains, with how often (the filter facet). */
export async function listAuditActions(
  db: Database,
  selection: ChainSelection,
): Promise<AuditActionDto[]> {
  return readIn(db, selection, (executor) =>
    executor
      .select({ action: auditLog.action, count: count() })
      .from(auditLog)
      .where(chainCondition(auditLog.tenantId, selection))
      .groupBy(auditLog.action)
      .orderBy(asc(auditLog.action))
      .limit(MAX_ACTIONS),
  );
}

// ---------------------------------------------------------------------------
// Chain verification
// ---------------------------------------------------------------------------

/** The chains a verification covers, installation chain first. */
async function chainsOf(db: Database, selection: ChainSelection): Promise<ChainRef[]> {
  switch (selection.kind) {
    case "installation":
      return [INSTALLATION];
    case "tenant": {
      const [tenant] = await withTenantTx(db, selection.tenantId, (tx) =>
        tx
          .select({ id: tenants.id, name: tenants.name })
          .from(tenants)
          .where(eq(tenants.id, selection.tenantId))
          .limit(1),
      );
      if (!tenant) {
        throw new ProblemError(404, "Tenant not found");
      }
      return [{ tenantId: tenant.id, tenantName: tenant.name }];
    }
    case "all": {
      const rows = await db
        .select({ id: tenants.id, name: tenants.name })
        .from(tenants)
        .orderBy(asc(tenants.name));
      return [INSTALLATION, ...rows.map((row) => ({ tenantId: row.id, tenantName: row.name }))];
    }
  }
}

/**
 * Read one chain in a single read-only snapshot, so entries appended during
 * the walk neither shift it nor race the anchors it compares against.
 */
function inChainSnapshot<T>(
  db: Database,
  tenantId: string | null,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(
    async (tx) => {
      if (tenantId !== null) {
        await tx.execute(pinTenantStatement(tenantId));
      }
      return fn(tx);
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

interface WalkRow {
  entry: AuditLogEntry;
  /** `created_at` in full database precision, for the keyset. */
  at: string;
}

/**
 * Walk one chain from its first entry, in batches. Keyset on
 * `(created_at, id)` with the exact database timestamp; the trailing entries
 * of a full batch that share a timestamp wait for the next batch, so every
 * run of equal timestamps is put in link order as a whole.
 */
export async function walkChain(
  executor: DbExecutor,
  tenantId: string | null,
  batchSize: number = WALK_BATCH,
): Promise<ChainResult> {
  const anchors = await executor
    .select({
      date: auditAnchor.anchorDate,
      lastHash: auditAnchor.lastHash,
      count: auditAnchor.count,
    })
    .from(auditAnchor)
    .where(tenantId === null ? isNull(auditAnchor.tenantId) : eq(auditAnchor.tenantId, tenantId))
    .orderBy(asc(auditAnchor.anchorDate));
  const walker = new ChainWalker(anchors);
  const sameChain = tenantId === null ? isNull(auditLog.tenantId) : eq(auditLog.tenantId, tenantId);

  let after: { at: string; id: string } | null = null;
  let pending: ChainEntry[] = [];
  for (;;) {
    const rows: WalkRow[] = await executor
      .select({ entry: auditLog, at: sql<string>`${auditLog.createdAt}::text` })
      .from(auditLog)
      .where(
        and(
          sameChain,
          after
            ? sql`(${auditLog.createdAt}, ${auditLog.id}) > (${after.at}::timestamptz, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(auditLog.createdAt), asc(auditLog.id))
      .limit(batchSize);

    const last = rows[rows.length - 1];
    const batch = [...pending, ...rows.map((row) => row.entry)];
    if (last === undefined || rows.length < batchSize) {
      pushInChainOrder(walker, batch);
      return walker.finish();
    }
    const { settled, trailing } = splitTrailingTieGroup(batch);
    if (!pushInChainOrder(walker, settled)) {
      return walker.finish();
    }
    pending = trailing;
    after = { at: last.at, id: last.entry.id };
  }
}

/** Identical verifications in flight share one walk (double clicks, several tabs). */
const inFlight = new Map<string, Promise<VerifyResponseDto>>();

function selectionKey(selection: ChainSelection): string {
  return selection.kind === "tenant" ? `tenant:${selection.tenantId}` : selection.kind;
}

async function runVerification(
  db: Database,
  selection: ChainSelection,
  now: () => Date,
): Promise<VerifyResponseDto> {
  const started = now();
  const chains = await chainsOf(db, selection);
  const reports: ChainReportDto[] = [];
  // One chain after the other: a verification is a background-grade read and
  // must not take every pooled connection at once.
  for (const chain of chains) {
    const result = await inChainSnapshot(db, chain.tenantId, (tx) => walkChain(tx, chain.tenantId));
    reports.push(toChainReportDto(chain, result));
  }
  const finished = now();
  return {
    status: overallStatus(reports.map((report) => report.status)),
    verifiedAt: finished.toISOString(),
    durationMs: Math.max(0, finished.getTime() - started.getTime()),
    chains: reports,
  };
}

/** Verify every selected chain end to end, including its daily anchors. */
export function verifyAuditChains(
  db: Database,
  selection: ChainSelection,
  now: () => Date = () => new Date(),
): Promise<VerifyResponseDto> {
  const key = selectionKey(selection);
  const running = inFlight.get(key);
  if (running) {
    return running;
  }
  const verification = runVerification(db, selection, now).finally(() => inFlight.delete(key));
  inFlight.set(key, verification);
  return verification;
}
