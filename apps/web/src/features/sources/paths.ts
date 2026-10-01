import type { LinkProps } from "@tanstack/react-router";

/**
 * Paths of the sources pages. Feature routes are registered at runtime, so
 * the static route typing cannot know them (same approach as the sidebar).
 */
export const SOURCES_PATH = "/sources";

export function sourcesListTo(): LinkProps["to"] {
  return SOURCES_PATH as LinkProps["to"];
}

export function sourceDetailTo(sourceId: string): LinkProps["to"] {
  return `${SOURCES_PATH}/${encodeURIComponent(sourceId)}` as LinkProps["to"];
}
