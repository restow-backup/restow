import { formatBytes, formatInteger, formatPercent } from "@/lib/format";
import { providerMay } from "@/lib/provider-role";
import type { SessionContextValue } from "@/lib/session";

import type { Suspicion, SuspicionFinding } from "./api";

type AccessSession = Pick<
  SessionContextValue,
  "role" | "isProviderAdmin" | "providerRole" | "providerAllTenants"
>;

/** Whether the viewer reads the judgements: a tenant's administrator or any provider admin. */
export function mayReadSuspicions(session: AccessSession): boolean {
  return session.isProviderAdmin || session.role === "tenant_admin";
}

/**
 * Whether the viewer may call a finding a false alarm (and take it back): a tenant's
 * administrator, or a provider admin whose team role reaches technician.
 */
export function mayMarkFalseAlarm(session: AccessSession): boolean {
  if (session.isProviderAdmin) {
    return providerMay(session, "technician");
  }
  return session.role === "tenant_admin";
}

/**
 * Whether the viewer may release a retention hold: a tenant's administrator, or a provider admin
 * whose team role reaches administrator (the API also asks for a recent sign-in).
 */
export function mayReleaseHold(session: AccessSession): boolean {
  if (session.isProviderAdmin) {
    return providerMay(session, "administrator");
  }
  return session.role === "tenant_admin";
}

/** A restore point as the hint needs it. */
export interface PointRef {
  id: string;
  time: string;
}

/**
 * When the newest restore point is suspicious: since when (the oldest suspicious one in a row
 * from the newest) and the newest restore point that is not, which a restore should start from.
 * Null when the newest restore point is not suspicious. Restore points without a judgement (made
 * before the detection existed, or not judged yet) count as without findings.
 */
export function lastCleanOf<P extends PointRef>(
  points: readonly P[],
  judgements: ReadonlyMap<string, Suspicion>,
): { since: P; clean: P | null } | null {
  const newestFirst = [...points].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  let since: P | null = null;
  for (const point of newestFirst) {
    if (!judgements.get(point.id)?.active) {
      return since ? { since, clean: point } : null;
    }
    since = point;
  }
  return since ? { since, clean: null } : null;
}

/** The judgements by restore point id. */
export function judgementsById(list: readonly Suspicion[] | undefined): Map<string, Suspicion> {
  return new Map((list ?? []).map((judgement) => [judgement.restorePointId, judgement]));
}

/** The translation key and values of one finding, its numbers formatted for `language`. */
export function findingMessage(
  finding: SuspicionFinding,
  language: string,
): { key: string; values: Record<string, string> } {
  const known = [
    "change_rate_items",
    "change_rate_bytes",
    "mass_deletions",
    "mass_renames",
    "known_extensions",
    "ransom_notes",
    "high_entropy",
    "incompressible_data",
    "dedup_collapse",
  ];
  // Compression and deduplication findings carry ratios (0 to about 1), shown as percent.
  const ratio = finding.code === "incompressible_data" || finding.code === "dedup_collapse";
  const amount = (value: number | undefined) =>
    finding.code === "change_rate_bytes"
      ? formatBytes(value ?? 0, language)
      : ratio
        ? formatPercent(value ?? 0, language, 1)
        : formatInteger(value ?? 0, language);
  return {
    key: known.includes(finding.code) ? `findings.${finding.code}` : "findings.unknown",
    values: {
      value: amount(finding.value),
      baseline: amount(finding.baseline),
      threshold: amount(finding.threshold),
      share: formatPercent(finding.share ?? 0, language, 1),
      ...(ratio ? { bytes: formatBytes(finding.bytes ?? 0, language) } : {}),
      examples: (finding.examples ?? []).slice(0, 3).join(", "),
    },
  };
}
