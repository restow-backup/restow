/**
 * Wire types of `/api/v1/api-keys` and `/api/v1/webhooks` (apps/api
 * features/apikeys and features/webhooks). The scope list mirrors the API so
 * the forms can offer it without a round trip; the stream events derive from
 * the event catalog.
 */

import { REPORT_EVENT_STREAM, REPORT_EVENTS, type ReportEvent } from "@/features/reports/api";

export const API_SCOPES = [
  "status:read",
  "jobs:read",
  "items:read",
  "users:read",
  "archive:read",
  "restore:write",
  "verify:write",
  "users:write",
  "webhooks:manage",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export type ApiKeyKind = "tenant" | "provider";
export type ApiKeyStatus = "active" | "expired" | "revoked";

export interface ApiKey {
  id: string;
  kind: ApiKeyKind;
  tenantId: string | null;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  status: ApiKeyStatus;
  createdAt: string;
  createdBy: { id: string; name: string; email: string } | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** The creation response: the only time the token is visible. */
export interface CreatedApiKey extends ApiKey {
  token: string;
}

export interface ProviderKeys {
  items: ApiKey[];
  /** Whether this installation offers creating provider keys. */
  available: boolean;
}

export interface CreateApiKeyInput {
  name: string;
  scopes: ApiScope[];
  expiresInDays: number | null;
}

/**
 * The webhook stream's events, derived from the event catalog (each catalog event names the
 * stream event that carries it, features/reports/api.ts), in catalog order.
 */
export type WebhookEvent = NonNullable<(typeof REPORT_EVENT_STREAM)[ReportEvent]>;

export const WEBHOOK_EVENTS: readonly WebhookEvent[] = [
  ...new Set(
    REPORT_EVENTS.flatMap((event) => {
      const wire = REPORT_EVENT_STREAM[event];
      return wire ? [wire] : [];
    }),
  ),
];

/**
 * What a webhook's requests look like: the signed JSON envelope, or a chat
 * message for that service's incoming webhooks (sent without a signature).
 */
export const WEBHOOK_FORMATS = ["restow", "discord", "slack", "teams"] as const;

export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

/** Sent by "Send test event"; appears in the delivery log only. */
export const WEBHOOK_TEST_EVENT = "webhook.test";

export type DeliveryStatus = "pending" | "delivered" | "failed";

export interface LastDelivery {
  id: string;
  event: string;
  status: DeliveryStatus;
  createdAt: string;
  deliveredAt: string | null;
}

export interface WebhookStats {
  pending: number;
  failedLast24h: number;
  deliveredLast24h: number;
  lastDelivery: LastDelivery | null;
}

export interface Webhook {
  id: string;
  name: string | null;
  url: string;
  /** The stream events the webhook subscribed to. */
  events: WebhookEvent[];
  /**
   * Its column in the notification matrix: the catalog events it gets, from rules and the stream
   * alike (absent from an older server).
   */
  notifyEvents?: ReportEvent[];
  active: boolean;
  format: WebhookFormat;
  /** A signing secret is stored; only the `restow` format signs with it. */
  secretConfigured: boolean;
  createdAt: string;
  updatedAt: string;
  stats: WebhookStats;
}

/** Creation and rotation responses: the signing secret, shown this one time. */
export interface WebhookWithSecret extends Webhook {
  secret: string;
}

export interface WebhookInput {
  name: string | null;
  url: string;
  /**
   * The stream events to subscribe to. Left out on creation: the server starts the webhook with
   * its format's defaults; which events it gets is chosen in the notification matrix.
   */
  events?: WebhookEvent[];
  active: boolean;
  format: WebhookFormat;
}

export type DeliveryErrorCode =
  | "http_error"
  | "redirect"
  | "timeout"
  | "connection_failed"
  | "dns_failed"
  | "tls_failed"
  | "blocked_address"
  | "invalid_url"
  | "secret_missing"
  | "webhook_disabled"
  | "internal"
  | "unknown";

export interface DeliveryError {
  code: DeliveryErrorCode;
  httpStatus: number | null;
  detail: string | null;
}

export interface Delivery {
  id: string;
  webhookId: string;
  event: string;
  eventId: string | null;
  status: DeliveryStatus;
  attempts: number;
  maxAttempts: number;
  lastError: DeliveryError | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryDetail extends Delivery {
  payload: Record<string, unknown>;
}

export interface DeliveriesPage {
  items: Delivery[];
  next: string | null;
}
