import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTenantScope } from "@/features/archive/hooks";

import { editionAllows, useEdition } from "../license/edition";

import { fetchJournalReceiver, fetchJournalSetup, journalKeys, rotateJournalAddress } from "./api";

/** The status follows the receiver and the incoming reports: look again now and then. */
const REFRESH_MS = 30_000;

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

export function useJournalSetup() {
  const { tenantId, enabled, canManage, licensed } = useJournalScope();
  return useQuery({
    queryKey: journalKeys.setup(tenantId),
    queryFn: fetchJournalSetup,
    enabled: enabled && canManage && licensed,
    refetchInterval: REFRESH_MS,
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
    refetchInterval: REFRESH_MS,
  });
}
