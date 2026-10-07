import type { StatusTone } from "@/components/kit/status-badge";
import { providerMay } from "@/lib/provider-role";
import type { SessionContextValue } from "@/lib/session";

import type {
  FailedItemLocation,
  RunOutcome,
  WarningDetail,
  WarningRef,
  WarningState,
  WarningSummary,
} from "./api";

/**
 * Pure rules of the warnings pages: tones, who may acknowledge, why a control is closed, and
 * how a failed item reads. The server decides what can be acknowledged; these only mirror it so
 * the page explains a closed button instead of letting a request fail.
 */

export const WARNINGS_ROLES = ["provider_admin", "tenant_admin"] as const;

export function stateTone(state: WarningState): StatusTone {
  switch (state) {
    case "open":
      return "warning";
    case "failed":
      return "destructive";
    case "acknowledged":
      return "muted";
    default:
      return "neutral";
  }
}

export function outcomeTone(outcome: RunOutcome): StatusTone {
  switch (outcome) {
    case "partial":
      return "warning";
    case "failed":
      return "destructive";
    case "running":
      return "info";
    case "queued":
    case "cancelled":
      return "muted";
    default:
      return "neutral";
  }
}

type AccessSession = Pick<
  SessionContextValue,
  "role" | "isProviderAdmin" | "providerRole" | "providerAllTenants"
>;

/**
 * Whether the viewer may acknowledge and revoke: a tenant's administrator, or a provider admin
 * whose team role reaches technician (apps/api lib/provider-access.ts, `operate`).
 */
export function mayAcknowledge(session: AccessSession): boolean {
  if (session.isProviderAdmin) {
    return providerMay(session, "technician");
  }
  return session.role === "tenant_admin";
}

/** The translation key (under `warnings:reasons`) of why acknowledging is closed; null when open. */
export function acknowledgeBlock(
  detail: Pick<WarningDetail, "acknowledge" | "state">,
  allowed: boolean,
): "notAllowed" | "failed" | "noWarning" | null {
  if (!allowed) {
    return "notAllowed";
  }
  if (detail.acknowledge.allowed) {
    return null;
  }
  return detail.acknowledge.refusal === "failed" ? "failed" : "noWarning";
}

/** What a bulk acknowledgement sends: the selected rows that have an open warning. */
export function acknowledgeableRefs(
  items: readonly WarningSummary[],
  selected: ReadonlySet<string>,
): WarningRef[] {
  return items
    .filter((item) => item.state === "open" && selected.has(refKey(item.target)))
    .map((item) => ({ kind: item.target.kind, id: item.target.id }));
}

export function refKey(ref: WarningRef): string {
  return `${ref.kind}:${ref.id}`;
}

/** How a failed item is named in a list: the subject or file name, never empty. */
export function itemTitle(location: FailedItemLocation, fallback: string): string {
  const name = location.name.trim();
  return name.length > 0 ? name : fallback;
}

/** The folder of a failed item with the area of a mailbox in front, e.g. `Inbox/Projects`. */
export function itemFolder(location: FailedItemLocation): string | null {
  return location.folder && location.folder.length > 0 ? location.folder : null;
}

/** A warning's acknowledgement counts (it is there and nothing superseded it). */
export function acknowledgementApplies(summary: Pick<WarningSummary, "acknowledgement">): boolean {
  return summary.acknowledgement !== null && !summary.acknowledgement.superseded;
}
