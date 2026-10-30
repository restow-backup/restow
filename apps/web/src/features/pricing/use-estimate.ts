import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { estimateKey, fetchEstimate } from "./api.js";

/**
 * The monthly estimate for one tenant, or for every tenant the viewer may see when `tenantId` is
 * left out. Prices are read fresh by the server and the figures are cached there for a short
 * while, so a minute here is as current as the card needs to be; a failure is not retried (the
 * card says so and offers a retry).
 *
 * `keepPrevious`: while another tenant's estimate loads, `data` is the previous one (flagged by
 * `isPlaceholderData`), so a caller can keep its layout and show a skeleton instead of figures of
 * the wrong tenant.
 */
export function usePricingEstimate({
  tenantId,
  enabled,
  keepPrevious = false,
}: {
  tenantId?: string | null;
  enabled: boolean;
  keepPrevious?: boolean;
}) {
  return useQuery({
    queryKey: estimateKey(tenantId ?? undefined),
    queryFn: () => fetchEstimate(tenantId ?? undefined),
    enabled,
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPrevious ? keepPreviousData : undefined,
  });
}
