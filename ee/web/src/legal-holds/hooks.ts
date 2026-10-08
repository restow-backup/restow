import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTenantScope } from "@/features/archive/hooks";

import { editionAllows, useEdition } from "../license/edition";

import {
  type CreateLegalHoldInput,
  createLegalHold,
  fetchLegalHolds,
  legalHoldKeys,
  releaseLegalHold,
} from "./api";

/**
 * Who sees the legal hold section: the archive page's own scope (a tenant
 * administrator of the active tenant) on an edition that includes legal
 * holds (Business and up, `archive.legalHold`).
 */
export function useLegalHoldScope() {
  const scope = useTenantScope();
  const edition = useEdition();
  return {
    ...scope,
    licensed: editionAllows(edition, "business"),
  };
}

export function useLegalHolds() {
  const { tenantId, enabled, canManage, licensed } = useLegalHoldScope();
  return useQuery({
    queryKey: legalHoldKeys.list(tenantId),
    queryFn: fetchLegalHolds,
    enabled: enabled && canManage && licensed,
  });
}

function useInvalidateLegalHolds() {
  const { tenantId } = useLegalHoldScope();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: legalHoldKeys.list(tenantId) });
}

export function useCreateLegalHold() {
  const invalidate = useInvalidateLegalHolds();
  return useMutation({
    mutationFn: (input: CreateLegalHoldInput) => createLegalHold(input),
    onSettled: invalidate,
  });
}

export function useReleaseLegalHold() {
  const invalidate = useInvalidateLegalHolds();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => releaseLegalHold(id, reason),
    onSettled: invalidate,
  });
}
