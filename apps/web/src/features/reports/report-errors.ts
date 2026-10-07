import type { TFunction } from "i18next";

import { ApiError, NetworkError, errorMessageKey, isFeatureUnavailable } from "@/lib/api";

/** Codes the server gives a refused rule (apps/api features/reports `reportRuleProblem`). */
export const RULE_PROBLEM_CODES = [
  "events_required",
  "sections_required",
  "channel_required",
  "webhook_not_found",
  "installation_event",
  "recipients_managed",
  "cadence_missing",
  "cadence_ambiguous",
  "interval_not_integer",
  "interval_out_of_range",
  "cron_invalid",
  "cron_never_matches",
  "cron_too_frequent",
  "timezone_unknown",
  "overdue_event_required",
] as const;
export type RuleProblemCode = (typeof RULE_PROBLEM_CODES)[number];

function ruleProblemCode(error: ApiError): RuleProblemCode | null {
  const code = (error.problem as { code?: unknown } | null)?.code;
  return typeof code === "string" && (RULE_PROBLEM_CODES as readonly string[]).includes(code)
    ? (code as RuleProblemCode)
    : null;
}

/**
 * A readable message for a failed reports request, in the reader's language: time-triggered
 * reports not being available here, the rule problem the server named (by its code, never the
 * server's English text), a rule that is gone, or what the common mapping says (the network,
 * the public demo, a missing right, a conflict).
 */
export function reportErrorMessage(error: unknown, t: TFunction): string {
  if (error instanceof NetworkError) {
    return t("errors.network");
  }
  if (isFeatureUnavailable(error)) {
    return t("errors.featureUnavailable");
  }
  if (error instanceof ApiError) {
    if (error.problem?.type === "urn:restow:problem:invalid-report-rule") {
      const code = ruleProblemCode(error);
      return t("errors.invalid", {
        detail: code ? t(`errors.codes.${code}`) : t("errors.codes.unknown"),
      });
    }
    if (error.status === 404) {
      return t("errors.notFound");
    }
  }
  return t(`common:${errorMessageKey(error)}`);
}
