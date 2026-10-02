import type { LinkProps } from "@tanstack/react-router";

import { activeTenantPageTo } from "@/lib/tenant-paths";

/**
 * Where the integrations live: the Integrations section of the active tenant's
 * page (features/tenant-page), the page of one webhook below it. Feature
 * routes are registered at runtime, so the static route typing cannot know
 * them (same approach as the sidebar). The old addresses `/integrations...`
 * lead there (features/redirects).
 */

/**
 * The section of the installation page that holds the provider keys (the
 * Service Provider module adds it, ee/web/src/provider-api). The keys used to
 * sit on the Integrations page; this page points to the section where it
 * exists.
 */
export const PROVIDER_API_SECTION_ID = "provider-api";

/**
 * Where `/integrations?tab=provider-keys` (the address of the provider keys'
 * old place) leads: their section when the installation has one, else null (the
 * redirect then opens the tenant's own keys, without the parameter).
 */
export function providerKeysDestination(
  search: { tab?: string },
  sectionIds: readonly string[],
): string | null {
  if (search.tab !== "provider-keys") {
    return null;
  }
  return sectionIds.includes(PROVIDER_API_SECTION_ID)
    ? `/installation/${PROVIDER_API_SECTION_ID}`
    : null;
}

export function integrationsTo(): LinkProps["to"] {
  return activeTenantPageTo("integrations");
}

export function webhookDetailTo(webhookId: string): LinkProps["to"] {
  return activeTenantPageTo("integrations", "webhooks", webhookId);
}
