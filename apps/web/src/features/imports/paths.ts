import type { LinkProps } from "@tanstack/react-router";

/**
 * Paths of the import pages. Feature routes are registered at runtime, so the
 * static route typing cannot know them (same approach as the sources feature).
 */
export const IMPORT_PATHS = {
  wizard: "/sources/import",
  list: "/imports",
  detail: "/imports/$importId",
} as const;

export function importTo(path: string): LinkProps["to"] {
  return path as LinkProps["to"];
}

export function importDetailTo(importId: string): LinkProps["to"] {
  return importTo(`${IMPORT_PATHS.list}/${encodeURIComponent(importId)}`);
}
