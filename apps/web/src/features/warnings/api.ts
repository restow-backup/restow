import type { Failure } from "@/features/failures/api";
import { apiFetch } from "@/lib/api";

/**
 * Contract of `/api/v1/warnings` (apps/api/src/features/warnings/dto.ts), kept in sync by hand.
 * A warning is a backup that went through but left items behind; an acknowledged one no longer
 * counts until a new cause appears or a backup fails outright (packages/core
 * failures/warnings.ts).
 */

/** `share`: a file share whose backup ended with warnings (docs/FILESHARES.md 13). */
export type WarningTargetKind = "object" | "machine" | "share";
export type WarningState = "none" | "failed" | "open" | "acknowledged";
export type WarningSubjectKind =
  | "mailbox"
  | "onedrive"
  | "imap"
  | "server"
  | "client"
  | "file_share";
export type RunOutcome = "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";

export interface WarningTarget {
  kind: WarningTargetKind;
  id: string;
  subjectKind: WarningSubjectKind;
  name: string;
  detail: string | null;
}

export interface WarningAcknowledgement {
  acknowledgedAt: string;
  acknowledgedBy: string;
  note: string | null;
  causes: string[];
  runId: string | null;
  /** It no longer counts: a new cause appeared, or a backup failed outright since. */
  superseded: boolean;
}

export interface CauseCount {
  code: string;
  count: number;
}

export interface WarningSummary {
  target: WarningTarget;
  state: WarningState;
  latestRun: {
    id: string;
    outcome: "succeeded" | "partial" | "failed";
    finishedAt: string;
    failedItems: number;
  } | null;
  causes: CauseCount[];
  newCauses: string[];
  acknowledgement: WarningAcknowledgement | null;
}

export interface WarningList {
  items: WarningSummary[];
  /** `failedGuests`: VMs and containers whose newest backup failed (absent from an older server). */
  counts: { open: number; acknowledged: number; failed: number; failedGuests?: number };
  truncated: boolean;
}

export interface FailedItemLocation {
  area: "mail" | "calendar" | "contacts" | null;
  folder: string | null;
  name: string;
  itemId: string | null;
}

export interface FailedItem {
  ref: string;
  location: FailedItemLocation;
  itemDate: string | null;
  failedAt: string | null;
  attempts: number;
  message: string;
  failure: Failure | null;
}

export interface WarningRun {
  id: string;
  outcome: RunOutcome;
  startedAt: string | null;
  finishedAt: string | null;
  failedItems: number;
  failure: Failure | null;
}

export interface WarningDetail extends WarningSummary {
  runs: WarningRun[];
  focusRunId: string | null;
  items: FailedItem[];
  itemCount: number;
  groups: { failure: Failure; count: number }[];
  acknowledge: { allowed: boolean; refusal: "no_warning" | "failed" | null };
  docsUrl: string;
}

export interface AcknowledgeResult {
  acknowledged: WarningSummary[];
  skipped: { kind: WarningTargetKind; id: string; reason: "no_warning" | "failed" | "not_found" }[];
}

export interface WarningRef {
  kind: WarningTargetKind;
  id: string;
}

export const warningKeys = {
  all: (tenantId: string | null) => ["tenant", tenantId, "warnings"] as const,
  list: (tenantId: string | null, state: "open" | "acknowledged") =>
    ["tenant", tenantId, "warnings", "list", state] as const,
  detail: (tenantId: string | null, ref: WarningRef) =>
    ["tenant", tenantId, "warnings", "detail", ref.kind, ref.id] as const,
};

const base = "/warnings";

export function fetchWarnings(state: "open" | "acknowledged"): Promise<WarningList> {
  return apiFetch<WarningList>(`${base}?state=${state}`);
}

export function fetchWarning(ref: WarningRef): Promise<WarningDetail> {
  return apiFetch<WarningDetail>(
    `${base}/${encodeURIComponent(ref.kind)}/${encodeURIComponent(ref.id)}`,
  );
}

export function acknowledgeWarnings(
  targets: readonly WarningRef[],
  note: string | null,
): Promise<AcknowledgeResult> {
  return apiFetch<AcknowledgeResult>(`${base}/acknowledge`, {
    method: "POST",
    body: { targets, note },
  });
}

export function revokeAcknowledgement(ref: WarningRef): Promise<void> {
  return apiFetch<void>(
    `${base}/${encodeURIComponent(ref.kind)}/${encodeURIComponent(ref.id)}/acknowledgement`,
    { method: "DELETE" },
  );
}
