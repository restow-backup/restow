import type { TFunction } from "i18next";

import { ApiError, NetworkError, isFeatureUnavailable } from "@/lib/api";

/**
 * A readable message for a failed reports request: time-triggered reports
 * not being available here, the field the server refused, or a generic line.
 */
export function reportErrorMessage(error: unknown, t: TFunction): string {
  if (error instanceof NetworkError) {
    return t("errors.network");
  }
  if (isFeatureUnavailable(error)) {
    return t("errors.featureUnavailable");
  }
  if (error instanceof ApiError) {
    const type = error.problem?.type;
    if (type === "urn:restow:problem:invalid-report-rule" && error.problem?.detail) {
      return t("errors.invalid", { detail: error.problem.detail });
    }
    if (error.status === 404) {
      return t("errors.notFound");
    }
  }
  return t("errors.generic");
}
