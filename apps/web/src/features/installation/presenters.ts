import type { InstallationSectionSpec } from "@/lib/extensions";
import { isModuleShown } from "@/lib/modules";
import type { NavLockContext } from "@/lib/navigation";

/**
 * Pure decisions of the installation page: the URL state, which sections the
 * installation offers and which of them are locked, and the wording scope.
 * No visible text lives here.
 */

/** URL state of a section: only the opaque marker of the link that led there. */
export interface InstallationSearch {
  /**
   * Opaque marker of what a link into the installation page was about (a locked
   * menu entry sets it, see `NavLock.search`); the core hands it to the section
   * unread. A short lowercase token.
   */
  requires?: string;
}

const REQUIRES_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;

/** Keep the `requires` marker if it is a plain token; drop everything else. */
export function parseInstallationSearch(search: unknown): InstallationSearch {
  const raw =
    typeof search === "object" && search !== null ? (search as Record<string, unknown>) : {};
  return typeof raw.requires === "string" && REQUIRES_PATTERN.test(raw.requires)
    ? { requires: raw.requires }
    : {};
}

/** A section as the page shows it. */
export interface SectionState {
  spec: InstallationSectionSpec;
  /** The section's lock holds it closed (an edition below the one that unlocks it). */
  locked: boolean;
  /**
   * The section belongs to modules of the installation that are all off (lib/modules.ts): it is
   * left out of the sub-navigation, and says so when it is opened by its address.
   */
  hidden: boolean;
}

/**
 * The sections in order, each marked locked or not (the same decision the menu makes for its
 * entries) and hidden or not (its module is off).
 */
export function sectionStates(
  specs: readonly InstallationSectionSpec[],
  context: NavLockContext,
): SectionState[] {
  return [...specs]
    .sort((a, b) => a.order - b.order)
    .map((spec) => ({
      spec,
      locked: spec.lock ? spec.lock.isLocked(context) : false,
      hidden: !isModuleShown(spec.modules, context.modules),
    }));
}

/** The sections the sub-navigation lists: every one that is not hidden, and the open one. */
export function listedSections<T extends { spec: { id: string }; hidden: boolean }>(
  states: readonly T[],
  activeId: string,
): T[] {
  return states.filter((state) => !state.hidden || state.spec.id === activeId);
}

/**
 * The scope the wording speaks of: an installation with one organisation says
 * "your organisation", one that manages tenants says "all tenants" (clarity
 * rule 4). Passed to the texts as the ICU argument `scope`.
 */
export type WordingScope = "organisation" | "tenants";

export function wordingScope(managesTenants: boolean): WordingScope {
  return managesTenants ? "tenants" : "organisation";
}

/** Which of the sections exist, by id, for the redirects of old addresses. */
export function hasSection(specs: readonly InstallationSectionSpec[], id: string): boolean {
  return specs.some((spec) => spec.id === id);
}
