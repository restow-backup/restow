import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type BrandingInput,
  deleteProviderLogo,
  deleteTenantLogo,
  fetchBrandingPreview,
  fetchProviderBranding,
  fetchTenantBranding,
  type PreviewKind,
  putProviderBranding,
  putProviderLogo,
  putTenantBranding,
  putTenantLogo,
  sendBrandingTest,
} from "./api";

/**
 * TanStack Query wiring of the branding page (0.5.0). The provider's branding is installation
 * wide; a tenant's sits under the tenant. Every write refreshes both and the previews, since a
 * tenant without an override shows the provider's.
 */

export const brandingKeys = {
  all: ["branding"] as const,
  provider: ["branding", "provider"] as const,
  tenant: (tenantId: string) => ["branding", "tenant", tenantId] as const,
  preview: (kind: PreviewKind, tenantId: string | null, lang: string) =>
    ["branding", "preview", kind, tenantId, lang] as const,
};

/** Whose branding a form edits: the provider's, or one tenant's override. */
export type BrandingScope = { kind: "provider" } | { kind: "tenant"; tenantId: string };

export function useProviderBranding() {
  return useQuery({ queryKey: brandingKeys.provider, queryFn: fetchProviderBranding });
}

export function useTenantBranding(tenantId: string) {
  return useQuery({
    queryKey: brandingKeys.tenant(tenantId),
    queryFn: () => fetchTenantBranding(tenantId),
    enabled: tenantId.length > 0,
  });
}

export function useBrandingPreview(
  kind: PreviewKind,
  tenantId: string | null,
  lang: string,
  enabled = true,
) {
  return useQuery({
    queryKey: brandingKeys.preview(kind, tenantId, lang),
    queryFn: () => fetchBrandingPreview(kind, tenantId, lang),
    enabled,
    staleTime: 30_000,
  });
}

function useInvalidateBranding() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: brandingKeys.all });
}

export function useSaveBranding(scope: BrandingScope) {
  const invalidate = useInvalidateBranding();
  return useMutation({
    mutationFn: async (input: BrandingInput | { inherit: true }): Promise<void> => {
      if (scope.kind === "provider") {
        await putProviderBranding(input as BrandingInput);
      } else {
        await putTenantBranding(scope.tenantId, input);
      }
    },
    onSuccess: () => invalidate(),
  });
}

export function useUploadLogo(scope: BrandingScope) {
  const invalidate = useInvalidateBranding();
  return useMutation({
    mutationFn: (file: Blob) =>
      scope.kind === "provider" ? putProviderLogo(file) : putTenantLogo(scope.tenantId, file),
    onSuccess: () => invalidate(),
  });
}

export function useRemoveLogo(scope: BrandingScope) {
  const invalidate = useInvalidateBranding();
  return useMutation({
    mutationFn: () =>
      scope.kind === "provider" ? deleteProviderLogo() : deleteTenantLogo(scope.tenantId),
    onSuccess: () => invalidate(),
  });
}

export function useSendBrandingTest() {
  return useMutation({ mutationFn: (tenantId: string | null) => sendBrandingTest(tenantId) });
}
