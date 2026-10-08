import type { AnyRoute } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import type * as React from "react";

import type { ProviderView } from "@/features/dashboard/api";
import type { WidgetView } from "@/features/dashboard/presenters";
import type { ReadinessState } from "@/features/verify/search";
import type { NavItem, NavLock } from "@/lib/navigation";
import type { SessionTenant } from "@/lib/session";

/**
 * Extension points of the web app: the only way code outside the core
 * (the Business and Service Provider modules under `ee/web`, see
 * ee/README.md) adds pages, menu entries, locks on menu entries
 * (lib/navigation.ts `NavLock`) or page sections. The core never
 * imports `ee/`; the one designated loader (`features/ee.ts`) imports the
 * `ee/web` entry and registers it here before the router is built
 * (`features/registry.ts` imports the loader).
 *
 * A slot is a named place in a core page that renders whatever component an
 * extension registered for it, with props the page defines in
 * {@link SlotProps}; with nothing registered it renders the page's fallback,
 * or nothing. Whether the installation offers the feature is the registered
 * component's own decision (it reads what the server reports in the session,
 * `features` and `extensions`), exactly as the API gates it. The web app
 * builds and works with no extension registered at all.
 */

/**
 * Props of every slot, by slot name. Each core page that offers a slot adds
 * its entry here, next to where it renders `<ExtensionSlot>`.
 */
export interface SlotProps {
  /** Extra sections at the end of the archive page (features/archive/archive-page.tsx). */
  "archive.sections": Record<string, never>;
  /**
   * The overview under "All tenants" (features/dashboard/dashboard-page.tsx): the sum across
   * the tenants and the tenants by what needs doing, shown where the installation enables the
   * gated feature `dashboard.allTenants`. `onOpenTenant` switches into a tenant,
   * `onOpenReadiness` into a tenant and on to its Recovery readiness in a state.
   */
  "dashboard.provider": {
    view: WidgetView<ProviderView>;
    onRetry: () => void;
    retrying: boolean;
    onOpenTenant: (tenantId: string) => void;
    onTenantDetails: (tenantId: string) => void;
    onOpenReadiness: (tenantId: string, state: ReadinessState) => void;
  };
  /**
   * Recovery readiness under "All tenants" (features/verify/verify-page.tsx,
   * `?scope=all`): the tenants that have objects in a state, with their counts, built from the
   * provider view. Choosing one switches into that tenant and opens its Recovery readiness.
   */
  "verify.byTenant": {
    view: WidgetView<ProviderView>;
    onRetry: () => void;
    retrying: boolean;
    state: ReadinessState | undefined;
    onStateChange: (state: ReadinessState | undefined) => void;
    onOpenReadiness: (tenantId: string, state: ReadinessState | undefined) => void;
  };
  /**
   * The archive's settings on the tenant page (features/tenant-page, section
   * Archive): what the Business modules add next to the retention the core
   * shows (legal holds).
   */
  "tenant.archiveSettings": { readOnly: boolean };
  /**
   * The archive section of a mail job's editor (features/backup-jobs, job-editor.tsx):
   * what the Business modules show about journaling (the journal address and
   * whether reports arrive) while the job archives. The core's fallback says
   * that capture needs the Business edition.
   */
  "jobs.archiveSetup": { archive: boolean };
  /**
   * The sidebar footer row next to the running version
   * (components/layout/app-sidebar.tsx); hidden while the sidebar is collapsed.
   */
  "shell.sidebarFooter": Record<string, never>;
  /**
   * Replaces the tenants page's neutral note when no further tenant may be
   * created (features/tenants/components/installation-panel.tsx): the core
   * renders its own short note as the fallback.
   */
  "tenants.creationLocked": Record<string, never>;
  /**
   * Replaces the member dialog's neutral note under the locked choice
   * "Selected tenants" where the installation does not enable the gated
   * feature `providerTeam.tenantScope` (features/provider-team/member-dialog.tsx):
   * the core renders its own short note as the fallback.
   */
  "team.tenantScopeLocked": Record<string, never>;
  /**
   * Replaces the neutral "Reports not available" of a tenant's rules (features/reports,
   * AlertRulesPanel) where the installation does not enable `reports.timed`: an extension says
   * which edition has them and, to whom may open it, where the key goes.
   */
  "reports.scheduleLocked": Record<string, never>;
}

export type SlotName = keyof SlotProps;

/** What the installation page hands to the section component of an extension. */
export interface InstallationSectionProps {
  /**
   * The opaque `?requires=` value of the link that led to the section (a locked
   * menu entry's `NavLock.search`, for example), or null; the core passes it on
   * unread.
   */
  requires: string | null;
}

/**
 * A section of the installation page (`/installation/<id>`, features/installation)
 * an extension adds to the core's own. It appears in the page's sub-navigation
 * at `order` (the core's sections sit at 10, 20, ... in
 * features/installation/sections.ts) and renders `component` for provider
 * admins. A `lock` greys it out like a locked menu entry: the sub-navigation
 * shows a lock, and the section itself says why and leads to `lock.to`. The
 * core knows nothing about what the lock stands for.
 */
export interface InstallationSectionSpec {
  /** URL segment: lowercase letters, digits and dashes. Unique across core and extensions. */
  readonly id: string;
  /** i18n key with namespace of the sub-navigation label (and the page title). */
  readonly labelKey: string;
  /** i18n key with namespace of the one-line description under the title; gets `{ scope }`. */
  readonly descriptionKey?: string;
  readonly icon: LucideIcon;
  /** Position in the sub-navigation; lower first. */
  readonly order: number;
  readonly component: React.ComponentType<InstallationSectionProps>;
  readonly lock?: NavLock;
  /**
   * The section of the old settings page (`/settings?section=<name>`, before
   * 0.2.0) whose address now leads here; for content an extension took out of
   * a core section. The core's own mapping applies where no section claims it.
   */
  readonly legacySettingsSection?: string;
}

/** What the tenant page hands to the component of a section. */
export interface TenantSectionProps {
  /** The tenant the page is about; it is the active tenant while the section renders. */
  tenant: SessionTenant;
  /**
   * The viewer may look but not change: the provider team role is too low for
   * settings, or the public demo is closed to changes. The page already closes
   * the section's controls; the flag is for what that cannot reach (a link that
   * would change something, a sentence saying so).
   */
  readOnly: boolean;
  /**
   * The page below the section the address names (a source below Connections,
   * the per-object backup below Protection); null on the section's own page.
   */
  sub: string | null;
}

/**
 * A section of the tenant page (`/tenants/<id>/<section>`, features/tenant-page)
 * an extension adds to the core's own. It appears in the page's sub-navigation
 * at `order` (the core's sections sit at 10, 20, ... in
 * features/tenant-page/sections.tsx) and renders `component` for the admins of
 * the tenant. A `lock` greys it out like a locked menu entry: the
 * sub-navigation shows a lock, and the section itself says why and leads to
 * `lock.to`. The core knows nothing about what the lock stands for.
 */
export interface TenantSectionSpec {
  /** URL segment: lowercase letters, digits and dashes. Unique across core and extensions. */
  readonly id: string;
  /** i18n key with namespace of the sub-navigation label (and the page title). */
  readonly labelKey: string;
  /** i18n key with namespace of the one-line description under the title; gets `{ tenant }`. */
  readonly descriptionKey?: string;
  readonly icon: LucideIcon;
  /** Position in the sub-navigation; lower first. */
  readonly order: number;
  readonly component: React.ComponentType<TenantSectionProps>;
  readonly lock?: NavLock;
}

type SlotComponents = { [K in SlotName]?: React.ComponentType<SlotProps[K]> };

export interface WebExtension {
  readonly name: string;
  /** Pages under the app shell (their parent is `appLayoutRoute`). */
  readonly routes?: readonly AnyRoute[];
  /** Sidebar entries; placed and locked like the core's (lib/navigation.ts). */
  readonly navItems?: readonly NavItem[];
  /**
   * Locks on core menu entries, by nav item id (lib/navigation.ts `NavLock`):
   * applied by features/registry.ts to the core's own entries, which carry no
   * lock themselves. The first extension to lock an id wins.
   */
  readonly navLocks?: Readonly<Record<string, NavLock>>;
  /** Sections of the installation page (see {@link InstallationSectionSpec}). */
  readonly installationSections?: readonly InstallationSectionSpec[];
  /** Sections of the tenant page (see {@link TenantSectionSpec}). */
  readonly tenantSections?: readonly TenantSectionSpec[];
  readonly slots?: SlotComponents;
}

const webExtensions: WebExtension[] = [];

export function registerWebExtension(extension: WebExtension): void {
  if (webExtensions.some((existing) => existing.name === extension.name)) {
    throw new Error(`web extension ${extension.name} is already registered`);
  }
  webExtensions.push(extension);
}

export function extensionRoutes(): AnyRoute[] {
  return webExtensions.flatMap((extension) => [...(extension.routes ?? [])]);
}

export function extensionNavItems(): NavItem[] {
  return webExtensions.flatMap((extension) => [...(extension.navItems ?? [])]);
}

/** Every registered lock on a core menu entry, by nav item id. */
export function extensionNavLocks(): Readonly<Record<string, NavLock>> {
  const locks: Record<string, NavLock> = {};
  for (const extension of webExtensions) {
    for (const [id, lock] of Object.entries(extension.navLocks ?? {})) {
      locks[id] ??= lock;
    }
  }
  return locks;
}

/** Every section the extensions add to the installation page, in registration order. */
export function extensionInstallationSections(): InstallationSectionSpec[] {
  return webExtensions.flatMap((extension) => [...(extension.installationSections ?? [])]);
}

/** Every section the extensions add to the tenant page, in registration order. */
export function extensionTenantSections(): TenantSectionSpec[] {
  return webExtensions.flatMap((extension) => [...(extension.tenantSections ?? [])]);
}

/** The component registered for `name`, or null when no extension fills it. */
export function slotComponent<K extends SlotName>(
  name: K,
): React.ComponentType<SlotProps[K]> | null {
  for (const extension of webExtensions) {
    const component = extension.slots?.[name];
    if (component) {
      return component as React.ComponentType<SlotProps[K]>;
    }
  }
  return null;
}

/** Renders the component registered for a slot, or `fallback` (default: nothing). */
export function ExtensionSlot<K extends SlotName>({
  name,
  props,
  fallback = null,
}: {
  name: K;
  props: SlotProps[K];
  /** What the page shows in the slot's place while no extension fills it. */
  fallback?: React.ReactNode;
}): React.ReactNode {
  const Component = slotComponent(name) as React.ComponentType<object> | null;
  return Component ? <Component {...(props as object)} /> : fallback;
}

/** Test support: forget every registration (the registry is module-wide). */
export function resetWebExtensionsForTesting(): void {
  webExtensions.length = 0;
}
