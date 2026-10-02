import type { LinkProps } from "@tanstack/react-router";

/**
 * Paths of the run pages. Feature routes are registered at runtime, so the
 * static route typing cannot know them (same approach as the sidebar).
 *
 * History lists every run (backup, restore, restore check, maintenance); it
 * was called "Jobs" at `/jobs` before 0.1.0. That address now belongs to the
 * job definitions of 0.2.0 and leads here until then; a run's old address
 * `/jobs/<id>` leads to `/history/<id>` (features/redirects). The public API
 * keeps its names (`/api/v1/jobs`, the webhook `job.failed`). The per-object
 * backup page ("Back up now") is below Protection on the tenant page.
 */
export const HISTORY_PATH = "/history";

export function historyTo(): LinkProps["to"] {
  return HISTORY_PATH as LinkProps["to"];
}

export function jobDetailTo(jobId: string): LinkProps["to"] {
  return `${HISTORY_PATH}/${encodeURIComponent(jobId)}` as LinkProps["to"];
}
