import type { AnyRoute } from "@tanstack/react-router";

import * as archive from "@/features/archive";
import * as backupJobs from "@/features/backup-jobs";
import * as directory from "@/features/directory";
import * as endpoints from "@/features/endpoints";
import * as mailExports from "@/features/exports";
import * as history from "@/features/history";
import * as mailImports from "@/features/imports";
import * as installation from "@/features/installation";
import * as integrations from "@/features/integrations";
import * as providerTeam from "@/features/provider-team";
import * as redirects from "@/features/redirects";
import * as reports from "@/features/reports";
import * as restore from "@/features/restore";
import * as retention from "@/features/retention";
import * as schedules from "@/features/schedules";
import * as settings from "@/features/settings";
import * as soon from "@/features/soon";
import * as sources from "@/features/sources";
import * as stats from "@/features/stats";
import * as storage from "@/features/storage";
import * as tenantPage from "@/features/tenant-page";
import * as tenants from "@/features/tenants";
import * as verify from "@/features/verify";
import { extensionNavItems, extensionNavLocks, extensionRoutes } from "@/lib/extensions";
import type { NavGroupId, NavItem } from "@/lib/navigation";

// Registers the Business/Service Provider modules (lib/extensions.tsx) before
// the lists below are collected.
import "./ee";

/**
 * Feature registry. Each feature module exports `{ routes, navItems }`
 * (see `features/dashboard/index.ts` for the shape); they are spread in here.
 * `router.tsx` mounts `featureRoutes` under the app shell next to the
 * dashboard (which the shell owns) and the sidebar renders `featureNavItems`
 * grouped by section. Role gating stays with each feature's `roles`; the
 * sidebar and the pages apply it.
 */

/** Features in navigation order: the way an operator walks through Restow. */
const features = [
  backupJobs,
  history,
  verify,
  reports,
  stats,
  soon,
  restore,
  archive,
  mailExports,
  endpoints,
  tenants,
  tenantPage,
  directory,
  sources,
  schedules,
  retention,
  mailImports,
  storage,
  integrations,
  installation,
  providerTeam,
  settings,
  redirects,
] as const;

interface Placement {
  readonly group: NavGroupId;
  readonly order: number;
}

/**
 * Where each entry sits in the sidebar, by nav item id: the menu of 0.2.0
 * (maintainer decisions 2026-10-01 and 2026-10-02; plan step 2, phase 1c).
 * Features bring their own defaults; this table settles the whole menu in one
 * place so orders from different features never collide:
 *
 *   Daily                Overview, History, Recovery readiness, Alerts
 *   Mail & SaaS          Jobs, Restore explorer, Archive, Exports
 *   Servers & endpoints  Jobs, Inventory, File restore
 *   Tenants              Tenant settings, All tenants (tenant management);
 *   (Organisation)       "Settings" instead of "Tenant settings" and no
 *                        "Tenants" wording where the installation has one
 *                        organisation (lib/navigation.ts `navGroupLabelKey`)
 *   Installation         Settings (the installation page and its sections), Members
 *                        (the provider team, id `team`), Audit log, License,
 *                        Resources (soon)
 *
 * "Jobs" are the job definitions (features/backup-jobs): the two entries share
 * the address `/jobs` and differ by `?type=mail|endpoint`. Their runs are History.
 *
 * The pages of a single tenant (its connections, protection, schedules,
 * retention, storage, agents, archive settings, notifications, integrations,
 * members, audit log and master data) have no entries of their own: they are the
 * sections of the tenant page, which "Tenant settings" opens
 * (features/tenant-page). The audit log of a provider admin is in Installation
 * (across every tenant), the one of a tenant's own administrator is the section
 * Audit log of their tenant's page. Pinned entries open the list once pins
 * exist (0.2.0).
 */
const NAV_PLACEMENT: Readonly<Record<string, Placement>> = {
  dashboard: { group: "daily", order: 0 },
  history: { group: "daily", order: 10 },
  verify: { group: "daily", order: 20 },
  alerts: { group: "daily", order: 30 },
  "mail-jobs": { group: "mail", order: 10 },
  restore: { group: "mail", order: 20 },
  archive: { group: "mail", order: 30 },
  exports: { group: "mail", order: 40 },
  "endpoint-jobs": { group: "endpoints", order: 10 },
  inventory: { group: "endpoints", order: 20 },
  "file-restore": { group: "endpoints", order: 30 },
  "tenant-settings": { group: "tenants", order: 10 },
  "organisation-settings": { group: "tenants", order: 10 },
  tenants: { group: "tenants", order: 50 },
  settings: { group: "installation", order: 10 },
  team: { group: "installation", order: 20 },
  audit: { group: "installation", order: 30 },
  license: { group: "installation", order: 40 },
  resources: { group: "installation", order: 50 },
};

function placed(item: NavItem): NavItem {
  const placement = NAV_PLACEMENT[item.id];
  return placement ? { ...item, ...placement } : item;
}

/** A core entry an extension locks (`WebExtension.navLocks`) gets that lock. */
function locked(item: NavItem, locks: Readonly<Record<string, NavItem["lock"]>>): NavItem {
  const lock = item.lock ?? locks[item.id];
  return lock ? { ...item, lock } : item;
}

const navLocks = extensionNavLocks();

export const featureRoutes: AnyRoute[] = [
  ...features.flatMap((feature): AnyRoute[] => [...feature.routes]),
  ...extensionRoutes(),
];

export const featureNavItems: NavItem[] = [
  ...features.flatMap((feature): NavItem[] => [...feature.navItems]),
  ...extensionNavItems(),
].map((item) => locked(placed(item), navLocks));
