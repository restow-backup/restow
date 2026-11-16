/**
 * The modules of the installation (0.5.0): what it protects, by the product's own areas. The
 * setup wizard asks which of them the installation uses, Installation > Modules changes the
 * answer later, and `/api/v1/me` carries the ones that are on (apps/api lib/modules.ts has the
 * same list).
 *
 *   microsoft365  Microsoft 365: mailboxes, OneDrive, SharePoint, groups and teams
 *   imap          IMAP mailboxes
 *   archive       the mail archive
 *   endpoints     servers and clients with the agent, and file shares
 *   pve           Proxmox VE: VMs and containers
 *
 * A module that is off is hidden, nothing more: its menu entries, its cards on the overview, its
 * entries where something new is created and in the command palette. Its pages stay reachable by
 * their address and say that the module is hidden (components/layout/module-hidden-hint.tsx);
 * the API refuses nothing because of it. Whatever belongs to a module names it in a `modules`
 * field (menu entries, sections, widgets); what names several is shown while one of them is on,
 * and what names none belongs to every installation. Editions (gated features and the locks of
 * extensions) are decided separately and are not touched by modules.
 */
export const MODULE_IDS = ["microsoft365", "imap", "archive", "endpoints", "pve"] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

/** Something that belongs to modules; without the field it belongs to every installation. */
export interface ModuleScoped {
  /** The modules it belongs to: shown while at least one of them is on. */
  readonly modules?: readonly ModuleId[];
}

/**
 * The enabled modules of `/api/v1/me`, read defensively: unknown ids are dropped, and a server
 * from before the field existed (or one that names none) has every module on.
 */
export function readModules(me: unknown): ModuleId[] {
  const raw = typeof me === "object" && me !== null ? (me as { modules?: unknown }).modules : null;
  if (!Array.isArray(raw)) {
    return [...MODULE_IDS];
  }
  const enabled = MODULE_IDS.filter((id) => raw.includes(id));
  return enabled.length > 0 ? enabled : [...MODULE_IDS];
}

/**
 * Whether something that belongs to `modules` is shown: it names no module, or one of its modules
 * is on. `enabled` null (the profile is not there yet, a test double from before modules) hides
 * nothing.
 */
export function isModuleShown(
  modules: readonly ModuleId[] | undefined,
  enabled: readonly ModuleId[] | null | undefined,
): boolean {
  if (!modules || modules.length === 0 || !enabled) {
    return true;
  }
  return modules.some((id) => enabled.includes(id));
}

/** The entries of `items` whose modules are shown ({@link isModuleShown}), in their order. */
export function withShownModules<T extends ModuleScoped>(
  items: readonly T[],
  enabled: readonly ModuleId[] | null | undefined,
): T[] {
  return items.filter((item) => isModuleShown(item.modules, enabled));
}

/** The modules of `modules` that are off: what a hidden page names in its hint. */
export function hiddenModulesOf(
  modules: readonly ModuleId[] | undefined,
  enabled: readonly ModuleId[] | null | undefined,
): ModuleId[] {
  return isModuleShown(modules, enabled) ? [] : [...(modules ?? [])];
}

/** i18n key (namespace common) of a module's name. */
export function moduleTitleKey(id: ModuleId): string {
  return `modules.items.${id}.title`;
}

/** i18n key (namespace common) of the one sentence on what a module covers. */
export function moduleDescriptionKey(id: ModuleId): string {
  return `modules.items.${id}.description`;
}
