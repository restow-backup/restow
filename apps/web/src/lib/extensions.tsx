import type { AnyRoute } from "@tanstack/react-router";
import type * as React from "react";

import type { ProviderView } from "@/features/dashboard/api";
import type { WidgetView } from "@/features/dashboard/presenters";
import type { NavItem, NavLock } from "@/lib/navigation";

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
   * The provider tab of the dashboard (features/dashboard/dashboard-page.tsx):
   * the cross-tenant view, shown where the installation enables the gated
   * feature `dashboard.allTenants`.
   */
  "dashboard.provider": {
    view: WidgetView<ProviderView>;
    onRetry: () => void;
    retrying: boolean;
    onOpenTenant: (tenantId: string) => void;
    onTenantDetails: (tenantId: string) => void;
  };
  /**
   * Below the core facts of Settings, About (features/settings/sections/about-section.tsx),
   * shown to provider admins. `requires` is the opaque `?requires=` value of
   * the link that led there (a locked menu entry's `NavLock.search`, for
   * example), or null; the core passes it on unread.
   */
  "settings.about": { requires: string | null };
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
}

export type SlotName = keyof SlotProps;

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
