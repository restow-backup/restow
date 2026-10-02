import type { NavItem } from "@/lib/navigation";

import "./i18n";

/**
 * Integrations feature: API keys with scopes (the tenant's keys; the provider
 * keys moved to Installation, Provider API) and webhooks with signed
 * deliveries, retries and a delivery log, for RMM, PSA and ticket systems.
 * The pages are the Integrations section of the tenant page and the page of
 * one webhook below it (features/tenant-page). The old addresses
 * `/integrations...` lead there, `?tab=provider-keys` to the installation's
 * section where it exists (features/redirects).
 */

export const routes = [];

/** No menu entry: the tenant settings entry opens the tenant page. */
export const navItems: NavItem[] = [];
