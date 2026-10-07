import { reportKeys } from "@/features/reports/api";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { useSession } from "@/lib/session";

import {
  createApiKey,
  createProviderKey,
  createWebhook,
  deleteWebhook,
  fetchApiKeys,
  fetchDeliveries,
  fetchDelivery,
  fetchProviderKeys,
  fetchWebhook,
  fetchWebhooks,
  integrationKeys,
  redeliver,
  revokeApiKey,
  revokeProviderKey,
  rotateWebhookSecret,
  sendTestEvent,
  updateWebhook,
} from "./api";
import { hasPendingDelivery } from "./presenters";
import type {
  ApiKey,
  ApiKeyKind,
  CreateApiKeyInput,
  DeliveryStatus,
  ProviderKeys,
  Webhook,
  WebhookInput,
} from "./types";

/** How often the delivery log refreshes while a delivery is still being attempted. */
const PENDING_POLL_MS = 3_000;
/** Background refresh of lists (last used, delivery stats). */
const LIST_REFRESH_MS = 60_000;

/**
 * Who may do what here: tenant keys and webhooks need the tenant admin role
 * in the active tenant (provider admins qualify); provider keys need a
 * provider admin and no tenant.
 */
export function useIntegrationsScope() {
  const { status, activeTenant, isProviderAdmin } = useSession();
  const tenantId = activeTenant?.id ?? null;
  const canManageTenant = isProviderAdmin || activeTenant?.role === "tenant_admin";
  const authenticated = status === "authenticated";
  return {
    tenantId,
    tenantName: activeTenant?.name ?? null,
    isProviderAdmin,
    canManageTenant,
    tenantEnabled: authenticated && tenantId !== null && canManageTenant,
    providerEnabled: authenticated && isProviderAdmin,
  };
}

// --- API keys -------------------------------------------------------------------

export function useApiKeys() {
  const { tenantId, tenantEnabled } = useIntegrationsScope();
  return useQuery({
    queryKey: integrationKeys.apiKeys(tenantId),
    queryFn: fetchApiKeys,
    enabled: tenantEnabled,
    refetchInterval: LIST_REFRESH_MS,
  });
}

export function useProviderKeys() {
  const { providerEnabled } = useIntegrationsScope();
  return useQuery({
    queryKey: integrationKeys.providerKeys,
    queryFn: fetchProviderKeys,
    enabled: providerEnabled,
    refetchInterval: LIST_REFRESH_MS,
  });
}

/**
 * Create a key. The token is handed to the caller only; the list is re-read
 * instead of cached from the response, so the token never sits in the query
 * cache.
 */
export function useCreateApiKey(kind: ApiKeyKind) {
  const queryClient = useQueryClient();
  const { tenantId } = useIntegrationsScope();
  return useMutation({
    mutationFn: (input: CreateApiKeyInput) =>
      kind === "provider" ? createProviderKey(input) : createApiKey(input),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey:
          kind === "provider" ? integrationKeys.providerKeys : integrationKeys.apiKeys(tenantId),
      }),
  });
}

function replaceKey(list: readonly ApiKey[], key: ApiKey): ApiKey[] {
  return list.map((candidate) => (candidate.id === key.id ? key : candidate));
}

export function useRevokeApiKey(kind: ApiKeyKind) {
  const queryClient = useQueryClient();
  const { tenantId } = useIntegrationsScope();
  return useMutation({
    mutationFn: (id: string) => (kind === "provider" ? revokeProviderKey(id) : revokeApiKey(id)),
    onSuccess: (key) => {
      if (kind === "provider") {
        queryClient.setQueryData<ProviderKeys>(integrationKeys.providerKeys, (current) =>
          current ? { ...current, items: replaceKey(current.items, key) } : current,
        );
      } else {
        queryClient.setQueryData<ApiKey[]>(integrationKeys.apiKeys(tenantId), (current) =>
          current ? replaceKey(current, key) : current,
        );
      }
    },
  });
}

// --- Webhooks -------------------------------------------------------------------

function anyPending(webhooks: readonly Webhook[] | undefined): boolean {
  return (webhooks ?? []).some((webhook) => webhook.stats.pending > 0);
}

export function useWebhooks() {
  const { tenantId, tenantEnabled } = useIntegrationsScope();
  return useQuery({
    queryKey: integrationKeys.webhooks(tenantId),
    queryFn: fetchWebhooks,
    enabled: tenantEnabled,
    refetchInterval: (query) => (anyPending(query.state.data) ? PENDING_POLL_MS : LIST_REFRESH_MS),
  });
}

export function useWebhook(id: string) {
  const { tenantId, tenantEnabled } = useIntegrationsScope();
  return useQuery({
    queryKey: integrationKeys.webhook(tenantId, id),
    queryFn: () => fetchWebhook(id),
    enabled: tenantEnabled,
    refetchInterval: (query) =>
      (query.state.data?.stats.pending ?? 0) > 0 ? PENDING_POLL_MS : LIST_REFRESH_MS,
  });
}

/** Re-read everything about webhooks of the active tenant (list, details, logs). */
function useInvalidateWebhooks() {
  const queryClient = useQueryClient();
  const { tenantId } = useIntegrationsScope();
  return React.useCallback(
    () => queryClient.invalidateQueries({ queryKey: integrationKeys.webhooks(tenantId) }),
    [queryClient, tenantId],
  );
}

export function useCreateWebhook() {
  const invalidate = useInvalidateWebhooks();
  return useMutation({
    mutationFn: (input: WebhookInput) => createWebhook(input),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateWebhook() {
  const invalidate = useInvalidateWebhooks();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<WebhookInput> }) =>
      updateWebhook(id, patch),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteWebhook() {
  const queryClient = useQueryClient();
  const { tenantId } = useIntegrationsScope();
  return useMutation({
    mutationFn: (id: string) => deleteWebhook(id),
    // The detail page that deleted it navigates away; its cache entry expires unobserved.
    onSuccess: (_result, id) => {
      queryClient.setQueryData<Webhook[]>(integrationKeys.webhooks(tenantId), (current) =>
        current?.filter((webhook) => webhook.id !== id),
      );
      // Rules that sent to it lost that channel on the server: the rule list must show it.
      void queryClient.invalidateQueries({ queryKey: reportKeys.all(tenantId) });
    },
  });
}

/** Rotate the secret; like key creation, the secret goes to the caller only. */
export function useRotateSecret() {
  const invalidate = useInvalidateWebhooks();
  return useMutation({
    mutationFn: (id: string) => rotateWebhookSecret(id),
    onSuccess: () => invalidate(),
  });
}

export function useSendTestEvent() {
  const invalidate = useInvalidateWebhooks();
  return useMutation({
    mutationFn: (id: string) => sendTestEvent(id),
    onSuccess: () => invalidate(),
  });
}

export function useRedeliver() {
  const invalidate = useInvalidateWebhooks();
  return useMutation({
    mutationFn: ({ id, deliveryId }: { id: string; deliveryId: string }) =>
      redeliver(id, deliveryId),
    onSuccess: () => invalidate(),
  });
}

// --- Delivery log ---------------------------------------------------------------

export function useDeliveries(id: string, status: DeliveryStatus | null) {
  const { tenantId, tenantEnabled } = useIntegrationsScope();
  const query = useInfiniteQuery({
    queryKey: integrationKeys.deliveries(tenantId, id, status),
    queryFn: ({ pageParam }) => fetchDeliveries(id, { status, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next,
    enabled: tenantEnabled,
    refetchInterval: (current) =>
      hasPendingDelivery((current.state.data?.pages ?? []).flatMap((page) => page.items))
        ? PENDING_POLL_MS
        : LIST_REFRESH_MS,
  });
  const items = React.useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.items),
    [query.data],
  );
  return { ...query, items };
}

export function useDelivery(id: string, deliveryId: string | null) {
  const { tenantId, tenantEnabled } = useIntegrationsScope();
  return useQuery({
    queryKey: integrationKeys.delivery(tenantId, id, deliveryId ?? ""),
    queryFn: () => fetchDelivery(id, deliveryId ?? ""),
    enabled: tenantEnabled && deliveryId !== null,
    refetchInterval: (query) => (query.state.data?.status === "pending" ? PENDING_POLL_MS : false),
  });
}
