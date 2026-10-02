import { z } from "zod";

import { ApiError, errorMessageKey, isFeatureUnavailable } from "@/lib/api";

import {
  API_SCOPES,
  type ApiKey,
  type ApiKeyStatus,
  type ApiScope,
  type CreateApiKeyInput,
  type DeliveryError,
  type DeliveryStatus,
  WEBHOOK_EVENTS,
  WEBHOOK_TEST_EVENT,
  type Webhook,
  type WebhookEvent,
  type WebhookInput,
} from "./types";

/**
 * Pure presentation logic of the integrations pages: scope and event
 * catalogues, status mapping, form schemas and the translation of API
 * problems. Components stay thin; everything here is unit-tested.
 */

/** Who may open the integrations pages (the API requires tenant admin or provider admin). */
export const INTEGRATIONS_ROLES = ["provider_admin", "tenant_admin"] as const;

export type BadgeVariant =
  | "default"
  | "secondary"
  | "outline"
  | "warning"
  | "destructive"
  | "muted";

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

export type ScopeGroupId = "read" | "act" | "manage";

/** Scopes as the create dialog groups them: what an integration may see, do and configure. */
export const SCOPE_GROUPS: readonly { id: ScopeGroupId; scopes: readonly ApiScope[] }[] = [
  { id: "read", scopes: ["status:read", "jobs:read", "items:read", "users:read", "archive:read"] },
  { id: "act", scopes: ["restore:write", "verify:write", "users:write"] },
  { id: "manage", scopes: ["webhooks:manage"] },
];

/** Translation id of a scope: `status:read` -> `status_read` (":" separates namespaces in i18next). */
export function scopeKey(scope: ApiScope): string {
  return scope.replace(":", "_");
}

/** Scopes in the canonical order, without duplicates. */
export function sortScopes(scopes: readonly ApiScope[]): ApiScope[] {
  return API_SCOPES.filter((scope) => scopes.includes(scope));
}

/** Add or remove `item`, keeping the order given by `order`. */
export function toggleItem<T>(list: readonly T[], item: T, on: boolean, order: readonly T[]): T[] {
  const next = new Set(list);
  if (on) {
    next.add(item);
  } else {
    next.delete(item);
  }
  return order.filter((candidate) => next.has(candidate));
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export const EXPIRY_OPTIONS = ["never", "30", "90", "180", "365"] as const;
export type ExpiryOption = (typeof EXPIRY_OPTIONS)[number];

export function expiryDays(option: ExpiryOption): number | null {
  return option === "never" ? null : Number(option);
}

/** A key that is active is a state, shown as the neutral outline: green is for a passed restore check. */
export const KEY_STATUS_VARIANT: Record<ApiKeyStatus, BadgeVariant> = {
  active: "outline",
  expired: "warning",
  revoked: "muted",
};

const STATUS_ORDER: Record<ApiKeyStatus, number> = { active: 0, expired: 1, revoked: 2 };

/** Keys to list: usable ones first; revoked keys only on request. Newest first within a status. */
export function visibleKeys(keys: readonly ApiKey[], showRevoked: boolean): ApiKey[] {
  return keys
    .filter((key) => showRevoked || key.status !== "revoked")
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.createdAt.localeCompare(a.createdAt),
    );
}

const EXPIRY_WARNING_DAYS = 14;

/** An active key that stops working within two weeks. */
export function expiresSoon(key: Pick<ApiKey, "status" | "expiresAt">, now: Date): boolean {
  if (key.status !== "active" || !key.expiresAt) {
    return false;
  }
  const remaining = Date.parse(key.expiresAt) - now.getTime();
  return remaining > 0 && remaining <= EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000;
}

export interface ApiKeyFormValues {
  name: string;
  scopes: ApiScope[];
  expiry: ExpiryOption;
}

export const emptyApiKeyForm: ApiKeyFormValues = { name: "", scopes: [], expiry: "never" };

/** Validation reasons are i18n ids under `createKey.errors`. */
export const apiKeyFormSchema = z.object({
  name: z.string().trim().min(1, "nameRequired").max(100, "nameTooLong"),
  scopes: z.array(z.enum(API_SCOPES)).min(1, "scopesRequired"),
  expiry: z.enum(EXPIRY_OPTIONS),
});

export function toCreateApiKeyInput(values: ApiKeyFormValues): CreateApiKeyInput {
  return {
    name: values.name.trim(),
    scopes: sortScopes(values.scopes),
    expiresInDays: expiryDays(values.expiry),
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Events a webhook can receive: the subscribable ones, the test event, and
 * the two sent by a rule under Alerts that names the webhook
 * (not subscribable here; the rule decides).
 */
const RULE_EVENTS = ["report.alert", "report.summary"] as const;
const KNOWN_EVENTS: ReadonlySet<string> = new Set([
  ...WEBHOOK_EVENTS,
  WEBHOOK_TEST_EVENT,
  ...RULE_EVENTS,
]);

/** Translation id of an event (`job.failed` -> `job_failed`); unknown events share one entry. */
export function eventKey(event: string): string {
  return KNOWN_EVENTS.has(event) ? event.replace(".", "_") : "unknown";
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** Plain http: the payload travels unencrypted (still signed). */
export function isInsecureUrl(url: string): boolean {
  return url.trim().toLowerCase().startsWith("http://");
}

/** Host and path for compact display; the full URL stays on the detail page. */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
}

export type WebhookHealth = "paused" | "failing" | "retrying" | "healthy" | "idle";

/** What the last delivery says about a webhook. */
export function webhookHealth(webhook: Pick<Webhook, "active" | "stats">): WebhookHealth {
  if (!webhook.active) {
    return "paused";
  }
  switch (webhook.stats.lastDelivery?.status) {
    case "failed":
      return "failing";
    case "pending":
      return "retrying";
    case "delivered":
      return "healthy";
    default:
      return "idle";
  }
}

export const HEALTH_VARIANT: Record<WebhookHealth, BadgeVariant> = {
  paused: "muted",
  failing: "destructive",
  retrying: "warning",
  healthy: "outline",
  idle: "outline",
};

export const DELIVERY_STATUS_VARIANT: Record<DeliveryStatus, BadgeVariant> = {
  pending: "warning",
  delivered: "outline",
  failed: "destructive",
};

/** The translation of a delivery failure (`deliveries.errors.<code>`, with the HTTP status). */
export function deliveryErrorKey(error: DeliveryError): string {
  return `deliveries.errors.${error.code}`;
}

/** Whether any listed delivery is still being attempted (the log then refreshes itself). */
export function hasPendingDelivery(deliveries: readonly { status: DeliveryStatus }[]): boolean {
  return deliveries.some((delivery) => delivery.status === "pending");
}

export type WebhookUrlIssue = "url" | "scheme" | "credentials";

/** Mirrors the API: an absolute http(s) URL without embedded credentials. */
export function webhookUrlIssue(value: string): WebhookUrlIssue | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "url";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "scheme";
  }
  if (url.username || url.password) {
    return "credentials";
  }
  return url.hostname ? null : "url";
}

export interface WebhookFormValues {
  name: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
}

/** Validation reasons are i18n ids under `webhookForm.errors`. */
export const webhookFormSchema = z.object({
  name: z.string().trim().max(100, "nameTooLong"),
  url: z
    .string()
    .trim()
    .min(1, "urlRequired")
    .max(2048, "urlTooLong")
    .superRefine((value, ctx) => {
      const issue = webhookUrlIssue(value);
      if (issue) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
      }
    }),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, "eventsRequired"),
  active: z.boolean(),
});

export function webhookFormFrom(webhook?: Webhook): WebhookFormValues {
  if (!webhook) {
    return { name: "", url: "", events: ["job.failed"], active: true };
  }
  return {
    name: webhook.name ?? "",
    url: webhook.url,
    events: [...webhook.events],
    active: webhook.active,
  };
}

export function toWebhookInput(values: WebhookFormValues): WebhookInput {
  const name = values.name.trim();
  return {
    name: name.length > 0 ? name : null,
    url: values.url.trim(),
    events: WEBHOOK_EVENTS.filter((event) => values.events.includes(event)),
    active: values.active,
  };
}

/** Only what changed, so an unchanged save sends nothing and audits nothing. */
export function webhookPatch(values: WebhookFormValues, webhook: Webhook): Partial<WebhookInput> {
  const next = toWebhookInput(values);
  const patch: Partial<WebhookInput> = {};
  if (next.name !== webhook.name) {
    patch.name = next.name;
  }
  if (next.url !== webhook.url) {
    patch.url = next.url;
  }
  const sameEvents =
    next.events.length === webhook.events.length &&
    next.events.every((event) => webhook.events.includes(event));
  if (!sameEvents) {
    patch.events = next.events;
  }
  if (next.active !== webhook.active) {
    patch.active = next.active;
  }
  return patch;
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

const PROBLEM_KEYS: Record<string, string> = {
  "urn:restow:problem:api-key-limit": "integrations:problems.keyLimit",
  "urn:restow:problem:webhook-limit": "integrations:problems.webhookLimit",
  "urn:restow:problem:webhook-paused": "integrations:problems.webhookPaused",
  "urn:restow:problem:delivery-pending": "integrations:problems.deliveryPending",
  "urn:restow:problem:master-key-missing": "integrations:problems.masterKeyMissing",
};

/** The translation key (with namespace) that explains a failed request. */
export function integrationErrorKey(error: unknown): string {
  if (isFeatureUnavailable(error)) {
    return "integrations:problems.featureUnavailable";
  }
  if (error instanceof ApiError && error.problem) {
    const key = PROBLEM_KEYS[error.problem.type];
    if (key) {
      return key;
    }
  }
  return `common:${errorMessageKey(error)}`;
}

// ---------------------------------------------------------------------------
// Search params
// ---------------------------------------------------------------------------

export type IntegrationsTab = "api-keys" | "webhooks";

export interface IntegrationsSearch {
  /**
   * Omitted for the default tab (API keys). `provider-keys` is the address the
   * provider keys' old place answers to: the keys moved to Installation, Provider
   * API, and the route leads there (index.ts); the page itself never shows it.
   */
  tab?: "webhooks" | "provider-keys";
}

export function parseIntegrationsSearch(search: Record<string, unknown>): IntegrationsSearch {
  if (search.tab === "webhooks") {
    return { tab: "webhooks" };
  }
  return search.tab === "provider-keys" ? { tab: "provider-keys" } : {};
}

export const DELIVERY_FILTERS = ["all", "pending", "delivered", "failed"] as const;
export type DeliveryFilter = (typeof DELIVERY_FILTERS)[number];

export function deliveryStatusOf(filter: DeliveryFilter): DeliveryStatus | null {
  return filter === "all" ? null : filter;
}

/** Stable, readable JSON for the payload viewer. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
