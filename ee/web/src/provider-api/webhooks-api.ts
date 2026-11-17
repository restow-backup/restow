import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";

/**
 * Typed client for /api/v1/provider-webhooks (ee/api/src/provider-webhooks/routes.ts): the
 * provider's own webhooks (0.6.0, Service Provider), events of the installation such as
 * `billing.period_closed`. 404 without the `provider.crossTenantApi` capability.
 */

export type ProviderWebhookEvent = "billing.period_closed";

export interface DeliveryError {
  code: string;
  httpStatus: number | null;
  detail: string | null;
}

export interface ProviderWebhookDelivery {
  id: string;
  event: string;
  eventId: string | null;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  maxAttempts: number;
  lastError: DeliveryError | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface ProviderWebhook {
  id: string;
  name: string | null;
  url: string;
  events: ProviderWebhookEvent[];
  active: boolean;
  failingSince: string | null;
  consecutiveFailures: number;
  lastFailure: DeliveryError | null;
  pending: number;
  lastDelivery: ProviderWebhookDelivery | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderWebhookList {
  items: ProviderWebhook[];
  events: ProviderWebhookEvent[];
}

const PATH = "/provider-webhooks";
const KEY = ["installation", "provider-webhooks"] as const;

export function useProviderWebhooks(enabled: boolean) {
  return useQuery({
    queryKey: KEY,
    queryFn: () => apiFetch<ProviderWebhookList>(PATH),
    enabled,
  });
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: KEY });
}

export function useCreateProviderWebhook() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { name: string | null; url: string }) =>
      apiFetch<ProviderWebhook & { secret: string }>(PATH, { method: "POST", body: input }),
    onSettled: invalidate,
  });
}

export function useSetProviderWebhookActive() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      apiFetch<ProviderWebhook>(`${PATH}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: { active },
      }),
    onSettled: invalidate,
  });
}

export function useDeleteProviderWebhook() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`${PATH}/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSettled: invalidate,
  });
}

export function useRotateProviderWebhookSecret() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<ProviderWebhook & { secret: string }>(`${PATH}/${encodeURIComponent(id)}/secret`, {
        method: "POST",
      }),
    onSettled: invalidate,
  });
}

export function useTestProviderWebhook() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<ProviderWebhookDelivery>(`${PATH}/${encodeURIComponent(id)}/test`, {
        method: "POST",
      }),
    onSettled: invalidate,
  });
}

/** How a webhook is doing: paused, failing (attempts fail in a row) or delivering. */
export function webhookState(hook: ProviderWebhook): "paused" | "failing" | "active" {
  if (!hook.active) return "paused";
  return hook.failingSince !== null || hook.consecutiveFailures > 0 ? "failing" : "active";
}
