import type { AnyRoute } from "@tanstack/react-router";

import * as archive from "@/features/archive";
import * as directory from "@/features/directory";
import * as endpoints from "@/features/endpoints";
import * as mailExports from "@/features/exports";
import * as mailImports from "@/features/imports";
import * as integrations from "@/features/integrations";
import * as jobs from "@/features/jobs";
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
import * as tenantSetup from "@/features/tenant-setup";
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
  jobs,
  verify,
  reports,
  stats,
  soon,
  restore,
  archive,
  mailExports,
  endpoints,
  tenants,
  tenantSetup,
  directory,
  sources,
  schedules,
  retention,
  mailImports,
  storage,
  integrations,
  settings,
  redirects,
] as const;

interface Placement {
  readonly group: NavGroupId;
  readonly order: number;
}

/**
 * Where each entry sits in the sidebar, by nav item id: the final menu of
 * 0.1.0 (maintainer decision 2026-10-01; plan step 2). Features bring their
 * own defaults; this table settles the whole menu in one place so orders from
 * different features never collide:
 *
 *   Daily                Overview, History, Recovery readiness, Alerts
 *   Mail & SaaS          Jobs (soon), Restore explorer, Archive, Exports
 *   Servers & endpoints  Jobs (soon), Inventory, File restore
 *   Tenants              All tenants (tenant management) or Setup (one tenant)
 *   Admin                Repositories, Audit log, Integrations, License, Team
 *                        (Members for tenant admins), Settings, Resources (soon)
 *
 * The setup area's pages (protection, sources, schedules, retention, imports)
 * have no entry of their own; they are tabs (features/tenant-setup). Pinned
 * entries open the list once pins exist (0.2.0).
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
  tenants: { group: "tenants", order: 10 },
  "tenant-setup": { group: "tenants", order: 20 },
  repositories: { group: "admin", order: 10 },
  audit: { group: "admin", order: 20 },
  integrations: { group: "admin", order: 30 },
  license: { group: "admin", order: 40 },
  team: { group: "admin", order: 50 },
  "tenant-members": { group: "admin", order: 60 },
  settings: { group: "admin", order: 90 },
  resources: { group: "admin", order: 100 },
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
