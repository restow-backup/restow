import type { AuditLogEntry } from "@restow/db";
import { TENANT_PRICING_AUDIT_ACTIONS } from "../../../../apps/api/src/features/settings/tenant-pricing.js";
import {
  type AnchorRecord,
  type ChainBreak,
  type ChainResult,
  type ChainStatus,
  entryHashMatches,
} from "./chain.js";

/**
 * Response shapes of the audit endpoints. Times are ISO-8601 UTC strings;
 * `tenantId: null` always means the installation chain.
 */

export interface AuditEntryDto {
  id: string;
  tenantId: string | null;
  tenantName: string | null;
  actor: string;
  actorUserId: string | null;
  action: string;
  target: string | null;
  targetType: string | null;
  /**
   * What the target is called today (a tenant, source or object name),
   * resolved when the entry is read; null when it has no name or no longer
   * exists. Not part of the hashed entry.
   */
  targetLabel: string | null;
  onBehalfOf: string | null;
  ip: string | null;
  details: Record<string, unknown> | null;
  prevHash: string | null;
  chainHash: string;
  /**
   * The entry's own hash still recomputes from its stored fields. Whether the
   * chain around it is intact is what `GET /audit/verify` answers.
   */
  hashValid: boolean;
  createdAt: string;
}

export interface AuditActionDto {
  action: string;
  count: number;
}

export type ChainBreakDto =
  | (Omit<Extract<ChainBreak, { reason: "hash_mismatch" }>, "createdAt"> & { createdAt: string })
  | (Omit<Extract<ChainBreak, { reason: "link_mismatch" }>, "createdAt"> & { createdAt: string })
  | Extract<ChainBreak, { reason: "anchor_mismatch" }>;

export interface ChainReportDto {
  /** null: the installation chain. */
  tenantId: string | null;
  tenantName: string | null;
  status: ChainStatus;
  verifiedEntries: number;
  head: { hash: string; createdAt: string } | null;
  anchors: { total: number; verified: number; latest: AnchorRecord | null };
  firstBreak: ChainBreakDto | null;
}

export interface VerifyResponseDto {
  /** `broken` if any chain is broken, `empty` if no chain has entries yet. */
  status: ChainStatus;
  verifiedAt: string;
  durationMs: number;
  chains: ChainReportDto[];
}

export function toEntryDto(
  entry: AuditLogEntry,
  tenantName: string | null,
  targetLabel: string | null = null,
): AuditEntryDto {
  return {
    id: entry.id,
    tenantId: entry.tenantId,
    tenantName,
    actor: entry.actor,
    actorUserId: entry.actorUserId,
    action: entry.action,
    target: entry.target,
    targetType: entry.targetType,
    targetLabel,
    onBehalfOf: entry.onBehalfOf,
    ip: entry.ip,
    details: entry.details ?? null,
    prevHash: entry.prevHash,
    chainHash: entry.chainHash,
    hashValid: entryHashMatches(entry),
    createdAt: entry.createdAt.toISOString(),
  };
}

/**
 * Demo mode never writes an entry's `ip` in the first place (`clientIpOf`
 * returns null while `RESTOW_DEMO=true`, apps/api lib/request.ts), but every
 * demo visitor reads the *same* tenant's audit chain through the shared demo
 * account, so this redacts it again on the way out too (security review
 * finding 2, DSGVO): a stray value from before demo mode was turned on, or
 * from any path that does not go through `clientIpOf`, still never reaches
 * another visitor.
 */
export function redactAuditEntryForDemo(entry: AuditEntryDto): AuditEntryDto {
  return entry.ip === null ? entry : { ...entry, ip: null };
}

const PRICE_KEYS: ReadonlySet<string> = new Set(["mailboxPrice", "storagePrice"]);

/** The value without any `mailboxPrice` / `storagePrice` key, however deep. */
function withoutPrices(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutPrices);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !PRICE_KEYS.has(key))
        .map(([key, inner]) => [key, withoutPrices(inner)]),
    );
  }
  return value;
}

/**
 * The provider's prices never reach a reader outside the provider (a tenant admin reads their
 * own tenant's chain, and the change of a tenant's own price is written there): the details of
 * a price change are dropped, and any other entry loses its price figures. `hashValid` was
 * computed from the stored entry before this and stays what it was.
 */
export function redactPricesForTenant(entry: AuditEntryDto): AuditEntryDto {
  if (entry.details === null) {
    return entry;
  }
  if (entry.action === TENANT_PRICING_AUDIT_ACTIONS.updated) {
    return { ...entry, details: null };
  }
  return { ...entry, details: withoutPrices(entry.details) as Record<string, unknown> };
}

export function toBreakDto(value: ChainBreak): ChainBreakDto {
  if (value.reason === "anchor_mismatch") {
    return value;
  }
  return { ...value, createdAt: value.createdAt.toISOString() };
}

export function toChainReportDto(
  chain: { tenantId: string | null; tenantName: string | null },
  result: ChainResult,
): ChainReportDto {
  return {
    tenantId: chain.tenantId,
    tenantName: chain.tenantName,
    status: result.status,
    verifiedEntries: result.verifiedEntries,
    head: result.head
      ? { hash: result.head.hash, createdAt: result.head.createdAt.toISOString() }
      : null,
    anchors: {
      total: result.anchorsTotal,
      verified: result.anchorsVerified,
      latest: result.latestAnchor,
    },
    firstBreak: result.firstBreak ? toBreakDto(result.firstBreak) : null,
  };
}

/** One status over several chains: any break wins, then any entries. */
export function overallStatus(statuses: readonly ChainStatus[]): ChainStatus {
  if (statuses.includes("broken")) {
    return "broken";
  }
  return statuses.includes("intact") ? "intact" : "empty";
}
