import type { LinkProps } from "@tanstack/react-router";
import { Gauge, type LucideIcon } from "lucide-react";

/**
 * Paths of the recovery readiness pages. Feature routes are registered at
 * runtime, so the static route typing cannot know them (same approach as the
 * sidebar and the other features).
 */
export const VERIFY_PATH = "/verify";

/** The icon of Recovery readiness (a passed restore check itself is ShieldCheck). */
export const VERIFY_ICON: LucideIcon = Gauge;

export function verifyOverviewTo(): LinkProps["to"] {
  return VERIFY_PATH as LinkProps["to"];
}

export function verifyReportTo(reportId: string): LinkProps["to"] {
  return `${VERIFY_PATH}/reports/${encodeURIComponent(reportId)}` as LinkProps["to"];
}
