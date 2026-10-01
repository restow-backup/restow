import type { LinkProps } from "@tanstack/react-router";

import type { FailureStep } from "./api";

/**
 * Where a step's target lives in the UI. Feature routes are registered at
 * runtime, so the static route typing cannot know them (same approach as the
 * other features' path helpers); the conversion happens here, once.
 */

export interface StepLink {
  to: LinkProps["to"];
  /** Search parameters of the destination, when it has any. */
  search?: Record<string, string>;
}

export interface StepContext {
  /** The source the failure concerns; resolves `source` targets. */
  sourceId?: string | null;
}

/** The link for a step, or null when it points nowhere in the app. */
export function stepLink(step: FailureStep, context: StepContext = {}): StepLink | null {
  switch (step.target) {
    case "settings_microsoft":
      return { to: "/settings" as LinkProps["to"], search: { section: "microsoft365" } };
    case "sources":
      return { to: "/sources" as LinkProps["to"] };
    case "source":
      return {
        to: (context.sourceId
          ? `/sources/${encodeURIComponent(context.sourceId)}`
          : "/sources") as LinkProps["to"],
      };
    case "directory":
      return { to: "/protected-objects" as LinkProps["to"] };
    case "storage":
      return { to: "/repositories" as LinkProps["to"] };
    case "verify":
      return { to: "/verify" as LinkProps["to"] };
    case "jobs":
      return { to: "/backup" as LinkProps["to"] };
    default:
      return null;
  }
}
