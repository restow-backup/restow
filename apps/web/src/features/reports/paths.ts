import type { LinkProps } from "@tanstack/react-router";

/**
 * Path of the alerts page (feature routes are registered at runtime). It was
 * "Alerts & reports" at `/reports` before the final menu; that address leads
 * here (features/redirects).
 */
export const REPORTS_PATH = "/alerts";

export function reportsTo(): LinkProps["to"] {
  return REPORTS_PATH as LinkProps["to"];
}
