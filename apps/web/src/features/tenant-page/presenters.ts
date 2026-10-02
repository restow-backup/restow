import type { TenantSectionSpec } from "@/lib/extensions";
import type { NavLockContext } from "@/lib/navigation";
import { CONNECTION_TABS, type ConnectionTab, TENANT_SECTION_IDS } from "@/lib/tenant-paths";

/**
 * Pure decisions of the tenant page: which sections it offers, in which
 * order, which of them an extension locked, and what the tabs of Connections
 * read from the address. No visible text lives here.
 */

/** A section as the page shows it. */
export interface TenantSectionState {
  spec: TenantSectionSpec;
  /** The section's lock holds it closed (an edition below the one that unlocks it). */
  locked: boolean;
}

/** The sections in order, each marked locked or not; the same decision the menu makes for its entries. */
export function tenantSectionStates(
  specs: readonly TenantSectionSpec[],
  context: NavLockContext,
): TenantSectionState[] {
  return [...specs]
    .sort((a, b) => a.order - b.order)
    .map((spec) => ({ spec, locked: spec.lock ? spec.lock.isLocked(context) : false }));
}

/** Whether `id` names a section the core itself offers. */
export function isCoreSectionId(id: string): boolean {
  return (TENANT_SECTION_IDS as readonly string[]).includes(id);
}

/** The pages below a section that have an address of their own. */
export const SUB_PAGES = {
  source: "source",
  importWizard: "import-wizard",
  importDetail: "import-detail",
  backup: "backup",
  webhook: "webhook",
} as const;
export type SubPage = (typeof SUB_PAGES)[keyof typeof SUB_PAGES];

/** The tab of Connections named in the address (`?tab=`); anything else opens Microsoft 365. */
export function parseConnectionsSearch(search: Record<string, unknown>): { tab: ConnectionTab } {
  return {
    tab: (CONNECTION_TABS as readonly unknown[]).includes(search.tab)
      ? (search.tab as ConnectionTab)
      : "microsoft365",
  };
}

/** The sections that only read: their controls are filters and disclosures, never closed. */
const READING_SECTIONS: ReadonlySet<string> = new Set(["overview", "audit"]);

/** The sections that are new settings of this release: the public demo closes them before a click. */
const DEMO_CLOSED_SECTIONS: ReadonlySet<string> = new Set([
  "agents",
  "archive",
  "notifications",
  "master-data",
]);

/**
 * Whether the controls of a section are closed for a viewer who may not change
 * settings (`block`: the provider team role is too low, or the public demo).
 * A section that only reads stays open; the demo closes the settings this
 * release adds and leaves the pages whose actions the demo guard already
 * answers with its own explanation.
 */
export function isSectionClosed(sectionId: string, block: "demo" | "role" | null): boolean {
  if (block === null || READING_SECTIONS.has(sectionId)) {
    return false;
  }
  return block === "role" || DEMO_CLOSED_SECTIONS.has(sectionId);
}
