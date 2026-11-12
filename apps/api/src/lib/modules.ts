import type { InstallationModules } from "@restow/db";
import { z } from "zod";

/**
 * The modules of the installation (0.5.0): what it protects, by the product's own areas. The
 * setup wizard asks which of them the installation uses ("What do you want to protect with
 * Restow?"), Installation > Modules changes the answer later (features/settings/modules.ts).
 *
 *   microsoft365  Microsoft 365: mailboxes, OneDrive, SharePoint sites, groups and teams
 *                 (sources of kind `m365`)
 *   imap          IMAP mailboxes (sources of kind `imap`)
 *   archive       the mail archive (docs/ARCHIVE.md)
 *   endpoints     servers and clients with the agent, and file shares (the menu section
 *                 "Servers & clients" without Proxmox VE)
 *   pve           Proxmox VE: VMs and containers (docs/PVE.md)
 *
 * A module that is off is only hidden in the web interface: its menu entries, its cards on the
 * overview, its entries where something new is created and in the command palette. Nothing is
 * deleted, no job stops and no route of the API refuses anything because of it, so this list is
 * never an access rule. It is independent of the editions' gated features (lib/features.ts).
 *
 * The settings row stores the modules that are off (packages/db `InstallationModules`): an
 * installation from before modules existed has none stored and shows every module, and a module
 * a later release adds is on until someone switches it off.
 */
export const MODULE_IDS = ["microsoft365", "imap", "archive", "endpoints", "pve"] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

/**
 * The modules that are on, in the order of {@link MODULE_IDS}. Ids the release does not know are
 * ignored, and a stored value that would switch every module off (never written by the API)
 * reads as every module on: an installation always shows something.
 */
export function enabledModules(stored: InstallationModules | null | undefined): ModuleId[] {
  const hidden = new Set(Array.isArray(stored?.hidden) ? stored.hidden : []);
  const enabled = MODULE_IDS.filter((id) => !hidden.has(id));
  return enabled.length > 0 ? enabled : [...MODULE_IDS];
}

/** What the settings row stores for `enabled`: the modules that are off. */
export function storedModules(enabled: readonly ModuleId[]): InstallationModules {
  return { hidden: MODULE_IDS.filter((id) => !enabled.includes(id)) };
}

/** The modules a request switches on: at least one, each once, in the order of the list. */
export const enabledModulesSchema = z
  .array(z.enum(MODULE_IDS))
  .min(1, "At least one module must stay on.")
  .max(MODULE_IDS.length)
  .transform((ids) => MODULE_IDS.filter((id) => ids.includes(id)));
