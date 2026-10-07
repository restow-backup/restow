import type { Database } from "@restow/db";
import { toCsv } from "../../../../apps/api/src/features/stats/csv.js";
import type { AuditEntryDto } from "./dto.js";
import type { ListAuditQuery } from "./schemas.js";
import { type ChainSelection, listAuditEntries } from "./service.js";

/**
 * The audit log as a file for an auditor: the entries matching the viewer's filters, as CSV for
 * a spreadsheet or as JSON with every hashed field, oldest first, so the chain can be checked
 * outside the product (chain_hash = SHA-256(prev_hash || canonical_json(fields) || created_at),
 * docs/ARCHITECTURE.md). Entries are read a page at a time, up to {@link MAX_EXPORT_ENTRIES}.
 */

/** More entries than this are not exported at once; narrow the period instead. */
export const MAX_EXPORT_ENTRIES = 50_000;
const PAGE = 200;

export const AUDIT_CSV_COLUMNS = [
  "createdAt",
  "tenantId",
  "tenantName",
  "actor",
  "actorUserId",
  "onBehalfOf",
  "action",
  "target",
  "targetType",
  "targetLabel",
  "ip",
  "details",
  "prevHash",
  "chainHash",
  "hashValid",
] as const;

export interface AuditExport {
  entries: AuditEntryDto[];
  /** More entries matched than were exported. */
  truncated: boolean;
}

/** Every entry the filters match, oldest first. */
export async function collectAuditExport(
  db: Database,
  selection: ChainSelection,
  query: Omit<ListAuditQuery, "limit" | "cursor">,
  redact: (entry: AuditEntryDto) => AuditEntryDto,
): Promise<AuditExport> {
  const entries: AuditEntryDto[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await listAuditEntries(db, selection, { ...query, limit: PAGE, cursor });
    entries.push(...page.items.map(redact));
    if (!page.next || entries.length >= MAX_EXPORT_ENTRIES) {
      const truncated = page.next !== null && entries.length >= MAX_EXPORT_ENTRIES;
      return { entries: entries.slice(0, MAX_EXPORT_ENTRIES).reverse(), truncated };
    }
    cursor = page.next;
  }
}

export function auditCsv(entries: readonly AuditEntryDto[]): string {
  return toCsv(
    AUDIT_CSV_COLUMNS,
    entries.map((entry) => [
      entry.createdAt,
      entry.tenantId,
      entry.tenantName,
      entry.actor,
      entry.actorUserId,
      entry.onBehalfOf,
      entry.action,
      entry.target,
      entry.targetType,
      entry.targetLabel,
      entry.ip,
      entry.details ? JSON.stringify(entry.details) : null,
      entry.prevHash,
      entry.chainHash,
      entry.hashValid,
    ]),
  );
}

export function auditJson(exported: AuditExport, filters: Record<string, unknown>, at: Date) {
  return {
    exportedAt: at.toISOString(),
    filters,
    truncated: exported.truncated,
    hash: "chain_hash = SHA-256(prev_hash || canonical_json(fields) || created_at), per tenant chain",
    entries: exported.entries,
  };
}
