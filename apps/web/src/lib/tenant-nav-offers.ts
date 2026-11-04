import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import type { NavItem, TenantNavOffer } from "@/lib/navigation";
import { useSession } from "@/lib/session";

/**
 * Menu entries that depend on the active tenant's own state, beyond roles and the
 * installation's gated features (GET /api/v1/navigation, apps/api features/navigation):
 *
 *   archive   "Archive" and the restore explorer's source "From the archive": the archive
 *             holds mail of the tenant, or the edition captures and a capture is set up
 *             (a mail job archives, the journal address was issued, a forwarding address is
 *             active, a capture stream runs; docs/ARCHIVE.md, "Eintrag „Archiv“ im Menü");
 *             for administrators only.
 *
 * Asked once per tenant; until the answer is in such an entry stays hidden, so nothing
 * appears that then vanishes (the maintainer decision on menu entries, lib/navigation.ts).
 */
export type TenantNavOffers = Readonly<Record<TenantNavOffer, boolean>>;

export function fetchTenantNavOffers(): Promise<{ offers: TenantNavOffers }> {
  return apiFetch<{ offers: TenantNavOffers }>("/navigation");
}

export const tenantNavOffersKey = (tenantId: string | null) =>
  ["tenant", tenantId, "navigation"] as const;

/**
 * The active tenant's offers; null while they load, without an active tenant, or when the
 * caller does not need them (`enabled: false`, which then asks nothing).
 */
export function useTenantNavOffers(options: { enabled?: boolean } = {}): TenantNavOffers | null {
  const { status, activeTenant } = useSession();
  const tenantId = activeTenant?.id ?? null;
  const query = useQuery({
    queryKey: tenantNavOffersKey(tenantId),
    queryFn: fetchTenantNavOffers,
    enabled: options.enabled !== false && status === "authenticated" && tenantId !== null,
    staleTime: 60_000,
  });
  return query.data?.offers ?? null;
}

/** Whether the active tenant offers an entry; an entry without `tenantOffer` always is. */
export function isTenantOffered(
  item: Pick<NavItem, "tenantOffer">,
  offers: TenantNavOffers | null,
): boolean {
  return item.tenantOffer === undefined || offers?.[item.tenantOffer] === true;
}
