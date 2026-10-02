import type { LinkProps } from "@tanstack/react-router";

import { activeTenantPageTo } from "@/lib/tenant-paths";

/**
 * Where the mail file imports live: the Imports tab of the Connections section
 * of the active tenant's page (features/tenant-page), the wizard and the page of
 * one import below it. Feature routes are registered at runtime, so the static
 * route typing cannot know them (same approach as the sources feature). The old
 * addresses `/sources/import` and `/imports...` lead here (features/redirects).
 */

/** The Imports tab of Connections. */
export function importsListTo(): LinkProps["to"] {
  return activeTenantPageTo("connections");
}

/** The search that opens the Imports tab. */
export const IMPORTS_TAB_SEARCH = { tab: "imports" } as const;

export function importWizardTo(): LinkProps["to"] {
  return activeTenantPageTo("connections", "imports", "new");
}

export function importDetailTo(importId: string): LinkProps["to"] {
  return activeTenantPageTo("connections", "imports", importId);
}
