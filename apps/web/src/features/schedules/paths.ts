import type { LinkProps } from "@tanstack/react-router";

/**
 * Path of the schedules page. Feature routes are registered at runtime, so the
 * static route typing cannot know it (same approach as the other features).
 */
export const SCHEDULES_PATH = "/schedules";

export function schedulesTo(): LinkProps["to"] {
  return SCHEDULES_PATH as LinkProps["to"];
}
