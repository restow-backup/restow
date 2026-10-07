import type { LinkProps } from "@tanstack/react-router";

/**
 * Path of the alerts page (feature routes are registered at runtime). It was
 * "Alerts & reports" at `/reports` before the final menu; that address leads
 * here (features/redirects).
 */
export const REPORTS_PATH = "/alerts";

/** Every notification the bell ever showed, a page at a time, with filters. */
export const NOTIFICATIONS_PATH = "/notifications";

export function reportsTo(): LinkProps["to"] {
  return REPORTS_PATH as LinkProps["to"];
}
