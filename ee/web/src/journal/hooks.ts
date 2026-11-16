import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTenantScope } from "@/features/archive/hooks";
import { type TenantNavOffers, tenantNavOffersKey } from "@/lib/tenant-nav-offers";

import { editionAllows, useEdition } from "../license/edition";

import {
  fetchJournalHost,
  fetchJournalReceiver,
  fetchJournalSetup,
  type JournalSetup,
  journalKeys,
  rotateJournalAddress,
} from "./api";

/** The status follows the receiver and the incoming reports: look again now and then. */
export const JOURNAL_REFRESH_MS = 30_000;

/**
 * Who sees the journal section: the archive page's own scope (a tenant
 * administrator of the active tenant) on an edition that includes the journal
 * receiver (Business and up, `archive.journalReceiver`).
 */
export function useJournalScope() {
  const scope = useTenantScope();
  const edition = useEdition();
  return {
    ...scope,
    licensed: editionAllows(edition, "business"),
  };
}

/**
 * The tenant's journal setup. The first request issues the journal address (the API audits
 * it), so a caller that does not need journaling passes `wanted: false` and nothing is asked:
 * the job editor asks only while Exchange journaling is chosen. `refetchInterval` overrides
 * the refresh (the wait for the first report polls faster). An issued address counts as
 * journaling set up, so menu offers that do not include the archive yet are asked again.
 */
export function useJournalSetup(
  options: {
    wanted?: boolean;
    /** How often to ask again, from the setup last read; the default is every 30 seconds. */
    refetchInterval?: (setup: JournalSetup | undefined) => number;
  } = {},
) {
  const { tenantId, enabled, canManage, licensed } = useJournalScope();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: journalKeys.setup(tenantId),
    queryFn: async () => {
      const setup = await fetchJournalSetup();
      const offers = queryClient.getQueryData<{ offers: TenantNavOffers }>(
        tenantNavOffersKey(tenantId),
      );
      if (offers && !offers.offers.archive) {
        void queryClient.invalidateQueries({ queryKey: tenantNavOffersKey(tenantId) });
      }
      return setup;
    },
    enabled: (options.wanted ?? true) && enabled && canManage && licensed,
    refetchInterval: (query) => options.refetchInterval?.(query.state.data) ?? JOURNAL_REFRESH_MS,
  });
}

/**
 * The journal host for the tenant page. Not the setup: looking at the tenant page must not
 * issue the journal address, which makes the menu offer the archive (journaling set up).
 */
export function useJournalHost() {
  const { tenantId, enabled, canManage, licensed } = useJournalScope();
  return useQuery({
    queryKey: journalKeys.host(tenantId),
    queryFn: fetchJournalHost,
    enabled: enabled && canManage && licensed,
    staleTime: 5 * 60_000,
  });
}

export function useRotateJournalAddress() {
  const { tenantId } = useJournalScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: rotateJournalAddress,
    onSuccess: (setup) => {
      queryClient.setQueryData(journalKeys.setup(tenantId), setup);
    },
  });
}

/** The receiver for the installation page; its state follows the listener and the reports, so look again now and then. */
export function useJournalReceiver() {
  return useQuery({
    queryKey: journalKeys.receiver,
    queryFn: fetchJournalReceiver,
    refetchInterval: JOURNAL_REFRESH_MS,
  });
}
