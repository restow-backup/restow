import { apiFetch, unwrapList } from "@/lib/api";

import type {
  ApiKey,
  CreateApiKeyInput,
  CreatedApiKey,
  DeliveriesPage,
  Delivery,
  DeliveryDetail,
  DeliveryStatus,
  ProviderKeys,
  Webhook,
  WebhookInput,
  WebhookWithSecret,
} from "./types";

/**
 * Typed calls against `/api/v1/api-keys` and `/api/v1/webhooks`. Tenant keys
 * and webhooks are scoped by the active tenant (X-Restow-Tenant via
 * `apiFetch`); provider keys belong to the installation and send no tenant.
 */

/** Query keys, scoped by tenant so a tenant switch never shows another tenant's data. */
export const integrationKeys = {
  apiKeys: (tenantId: string | null) => ["tenant", tenantId, "integrations", "api-keys"] as const,
  providerKeys: ["integrations", "provider-keys"] as const,
  webhooks: (tenantId: string | null) => ["tenant", tenantId, "integrations", "webhooks"] as const,
  webhook: (tenantId: string | null, id: string) =>
    ["tenant", tenantId, "integrations", "webhooks", id] as const,
  deliveries: (tenantId: string | null, id: string, status: DeliveryStatus | null) =>
    ["tenant", tenantId, "integrations", "webhooks", id, "deliveries", status] as const,
  delivery: (tenantId: string | null, id: string, deliveryId: string) =>
    ["tenant", tenantId, "integrations", "webhooks", id, "delivery", deliveryId] as const,
};

const KEYS = "/api-keys";
const HOOKS = "/webhooks";

const hookPath = (id: string, suffix = "") => `${HOOKS}/${encodeURIComponent(id)}${suffix}`;

// --- API keys -------------------------------------------------------------------

export async function fetchApiKeys(): Promise<ApiKey[]> {
  return unwrapList<ApiKey>(await apiFetch<unknown>(KEYS));
}

export function createApiKey(input: CreateApiKeyInput): Promise<CreatedApiKey> {
  return apiFetch<CreatedApiKey>(KEYS, { method: "POST", body: input });
}

export function revokeApiKey(id: string): Promise<ApiKey> {
  return apiFetch<ApiKey>(`${KEYS}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function fetchProviderKeys(): Promise<ProviderKeys> {
  return apiFetch<ProviderKeys>(`${KEYS}/provider`, { tenantId: null });
}

export function createProviderKey(input: CreateApiKeyInput): Promise<CreatedApiKey> {
  return apiFetch<CreatedApiKey>(`${KEYS}/provider`, {
    method: "POST",
    body: input,
    tenantId: null,
  });
}

export function revokeProviderKey(id: string): Promise<ApiKey> {
  return apiFetch<ApiKey>(`${KEYS}/provider/${encodeURIComponent(id)}`, {
    method: "DELETE",
    tenantId: null,
  });
}

// --- Webhooks -------------------------------------------------------------------

export async function fetchWebhooks(): Promise<Webhook[]> {
  return unwrapList<Webhook>(await apiFetch<unknown>(HOOKS));
}

export function fetchWebhook(id: string): Promise<Webhook> {
  return apiFetch<Webhook>(hookPath(id));
}

export function createWebhook(input: WebhookInput): Promise<WebhookWithSecret> {
  return apiFetch<WebhookWithSecret>(HOOKS, { method: "POST", body: input });
}

export function updateWebhook(id: string, patch: Partial<WebhookInput>): Promise<Webhook> {
  return apiFetch<Webhook>(hookPath(id), { method: "PATCH", body: patch });
}

export function deleteWebhook(id: string): Promise<void> {
  return apiFetch<void>(hookPath(id), { method: "DELETE" });
}

export function rotateWebhookSecret(id: string): Promise<WebhookWithSecret> {
  return apiFetch<WebhookWithSecret>(hookPath(id, "/secret"), { method: "POST" });
}

export function sendTestEvent(id: string): Promise<Delivery> {
  return apiFetch<Delivery>(hookPath(id, "/test"), { method: "POST" });
}

export function fetchDeliveries(
  id: string,
  options: { status: DeliveryStatus | null; cursor: string | null; limit?: number },
): Promise<DeliveriesPage> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 25) });
  if (options.status) {
    params.set("status", options.status);
  }
  if (options.cursor) {
    params.set("cursor", options.cursor);
  }
  return apiFetch<DeliveriesPage>(`${hookPath(id, "/deliveries")}?${params.toString()}`);
}

export function fetchDelivery(id: string, deliveryId: string): Promise<DeliveryDetail> {
  return apiFetch<DeliveryDetail>(hookPath(id, `/deliveries/${encodeURIComponent(deliveryId)}`));
}

export function redeliver(id: string, deliveryId: string): Promise<Delivery> {
  return apiFetch<Delivery>(
    hookPath(id, `/deliveries/${encodeURIComponent(deliveryId)}/redeliver`),
    { method: "POST" },
  );
}
