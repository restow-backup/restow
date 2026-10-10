import type { LinkProps } from "@tanstack/react-router";

import { activeTenantPageTo } from "@/lib/tenant-paths";

import type { FailureStep } from "./api";

/**
 * Where a step's target lives in the UI: the pages of the active tenant are
 * sections of its tenant page (features/tenant-page). Feature routes are
 * registered at runtime, so the static route typing cannot know them (same
 * approach as the other features' path helpers); the conversion happens here,
 * once.
 */

export interface StepLink {
  to: LinkProps["to"];
  /** Search parameters of the destination, when it has any. */
  search?: Record<string, string>;
}

export interface StepContext {
  /** The source the failure concerns; resolves `source` targets. */
  sourceId?: string | null;
  /** The file share the failure concerns; resolves `file_share` targets. */
  fileShareId?: string | null;
}

/** The link for a step, or null when it points nowhere in the app. */
export function stepLink(step: FailureStep, context: StepContext = {}): StepLink | null {
  switch (step.target) {
    case "settings_microsoft":
      return { to: "/installation/microsoft-app" as LinkProps["to"] };
    case "sources":
      return { to: activeTenantPageTo("connections") };
    case "source":
      return {
        to: context.sourceId
          ? activeTenantPageTo("connections", "sources", context.sourceId)
          : activeTenantPageTo("connections"),
      };
    case "directory":
      return { to: activeTenantPageTo("protection") };
    case "storage":
      return { to: activeTenantPageTo("storage") };
    case "verify":
      return { to: "/verify" as LinkProps["to"] };
    case "jobs":
      return { to: activeTenantPageTo("protection", "backup") };
    case "file_share":
      // The share's settings, where the account, the version, restores and the budget are.
      return context.fileShareId
        ? {
            to: `/file-shares/${encodeURIComponent(context.fileShareId)}` as LinkProps["to"],
            search: { tab: "settings" },
          }
        : { to: "/file-shares" as LinkProps["to"] };
    case "file_share_runners":
      return { to: "/installation/mounts" as LinkProps["to"] };
    default:
      return null;
  }
}
