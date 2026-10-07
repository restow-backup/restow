import type { LinkProps } from "@tanstack/react-router";

import { activeTenantPageTo } from "@/lib/tenant-paths";

import type { SourceKind } from "./types";

/**
 * Where the sources live: the Connections section of the active tenant's page
 * (features/tenant-page), one tab per kind of connection, and the page of one
 * source below it. Feature routes are registered at runtime, so the static
 * route typing cannot know them (same approach as the sidebar). The old
 * addresses `/sources...` lead here (features/redirects).
 */

/** The tab of Connections that lists sources of `kind`. */
export function connectionTabOf(kind: SourceKind): "microsoft365" | "imap" | "imports" {
  return kind === "m365" ? "microsoft365" : kind === "imap" ? "imap" : "imports";
}

/** The Connections section; pass the search from {@link sourcesListSearch} to land on a tab. */
export function sourcesListTo(): LinkProps["to"] {
  return activeTenantPageTo("connections");
}

/** The search that opens the tab of `kind` (the default tab, Microsoft 365, needs none). */
export function sourcesListSearch(kind?: SourceKind): { tab?: string } {
  const tab = kind ? connectionTabOf(kind) : undefined;
  return tab && tab !== "microsoft365" ? { tab } : {};
}

export function sourceDetailTo(sourceId: string): LinkProps["to"] {
  return activeTenantPageTo("connections", "sources", sourceId);
}

/**
 * The Directory (Protection section, tab "Sources and rules"), where the
 * accounts of an IMAP source are listed and each gets its own password.
 */
export function directorySourcesTo(): LinkProps["to"] {
  return activeTenantPageTo("protection");
}

/** The search that opens the "Sources and rules" tab of the Directory. */
export const DIRECTORY_SOURCES_SEARCH = { tab: "sources" } as const;
