/**
 * Microsoft Graph change notifications for mail (docs/MICROSOFT.md "Change notifications"):
 * the subscriptions the archive capture keeps per archived mailbox, and the parsing and
 * checking of what Graph posts to the notification and lifecycle URLs.
 *
 *   - One subscription per mailbox on `users/{id}/messages`, change type `created`,
 *     without resource data (no encryption certificate needed): a notification names the
 *     message, the capture fetches it (../../archive/graph-capture.ts).
 *   - Ids are immutable (`Prefer: IdType="ImmutableId"` on creation, on every delta and
 *     message request of the capture): a message moved to another folder keeps its id, so
 *     a move is never captured twice.
 *   - Creation and renewal go through `$batch` (20 per request, ../client.ts), the caller
 *     paces them per tenant.
 *   - `clientState` is a random secret per subscription; only its SHA-256 is stored, and
 *     a notification whose clientState does not hash to it is ignored. The comparison is
 *     constant-time.
 *   - Lifecycle notifications (`reauthorizationRequired`, `subscriptionRemoved`, `missed`)
 *     go to their own URL.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { BatchRequest, GraphClient } from "../client.js";
import { GraphError } from "../errors.js";
import { userPath } from "./common.js";

/**
 * Lifetime asked for on creation and renewal, in minutes. Graph allows up to 10080 for
 * Outlook messages without resource data; 4230 (just under three days) is the long-standing
 * documented value and leaves room for a missed renewal.
 */
export const MAIL_SUBSCRIPTION_LIFETIME_MINUTES = 4230;

/** A subscription is renewed when less than this is left of its lifetime. */
export const SUBSCRIPTION_RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;

/** The `Prefer` value that makes Graph hand out immutable message ids. */
export const IMMUTABLE_ID_PREFER = 'IdType="ImmutableId"';

/** Graph caps `clientState` at 128 characters; 32 random bytes are 43 in base64url. */
const CLIENT_STATE_BYTES = 32;

export type LifecycleEvent = "reauthorizationRequired" | "subscriptionRemoved" | "missed";

export const LIFECYCLE_EVENTS: readonly LifecycleEvent[] = [
  "reauthorizationRequired",
  "subscriptionRemoved",
  "missed",
];

/** The resource of a mailbox's message subscription. */
export function mailSubscriptionResource(userId: string): string {
  return `${userPath(userId).slice(1)}/messages`;
}

/** A fresh clientState secret. */
export function newClientState(): string {
  return randomBytes(CLIENT_STATE_BYTES).toString("base64url");
}

/** What is stored of a clientState: its SHA-256, hex. */
export function hashClientState(clientState: string): string {
  return createHash("sha256").update(clientState, "utf8").digest("hex");
}

/** Whether `clientState` hashes to `storedHash`, compared in constant time. */
export function clientStateMatches(clientState: unknown, storedHash: string): boolean {
  if (typeof clientState !== "string" || clientState.length === 0 || clientState.length > 256) {
    return false;
  }
  const actual = Buffer.from(hashClientState(clientState), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The expiry to ask for from `now`. */
export function subscriptionExpiry(
  now: Date,
  minutes: number = MAIL_SUBSCRIPTION_LIFETIME_MINUTES,
): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

/** Whether a subscription expiring at `expiresAt` is due for renewal at `now`. */
export function needsRenewal(
  expiresAt: Date,
  now: Date,
  before: number = SUBSCRIPTION_RENEW_BEFORE_MS,
): boolean {
  return expiresAt.getTime() - now.getTime() < before;
}

/** When a subscription expiring at `expiresAt` should be renewed. */
export function renewalDueAt(expiresAt: Date, before: number = SUBSCRIPTION_RENEW_BEFORE_MS): Date {
  return new Date(expiresAt.getTime() - before);
}

/** What one subscription is created with. */
export interface SubscriptionSpec {
  readonly resource: string;
  readonly notificationUrl: string;
  readonly lifecycleNotificationUrl: string;
  readonly clientState: string;
  readonly expirationDateTime: Date;
  /** Default `created`. */
  readonly changeType?: string;
}

/** A subscription as Graph reports it. */
export interface GraphSubscriptionInfo {
  readonly id: string;
  readonly resource: string;
  readonly expirationDateTime: Date;
}

export type SubscriptionResult =
  | { readonly ok: true; readonly subscription: GraphSubscriptionInfo }
  | { readonly ok: false; readonly error: GraphError };

function subscriptionOf(
  body: unknown,
  fallback: { resource: string; expirationDateTime: Date },
): GraphSubscriptionInfo | null {
  const value = body as { id?: unknown; resource?: unknown; expirationDateTime?: unknown } | null;
  if (!value || typeof value.id !== "string" || value.id.length === 0) {
    return null;
  }
  const expires =
    typeof value.expirationDateTime === "string" ? new Date(value.expirationDateTime) : null;
  return {
    id: value.id,
    resource: typeof value.resource === "string" ? value.resource : fallback.resource,
    expirationDateTime:
      expires && !Number.isNaN(expires.getTime()) ? expires : fallback.expirationDateTime,
  };
}

function errorOf(
  response: { status: number; headers?: Record<string, string>; body?: unknown },
  method: string,
  url: string,
): GraphError {
  return new GraphError({
    status: response.status,
    method,
    url,
    headers: response.headers ?? {},
    payload: response.body,
  });
}

/**
 * Create subscriptions through `$batch` (chunked to 20 by the client). Graph validates the
 * notification URL of each one before it answers, so a sub-request can take a few seconds.
 * Results are in the order of `specs`.
 */
export async function createSubscriptions(
  client: GraphClient,
  specs: readonly SubscriptionSpec[],
): Promise<SubscriptionResult[]> {
  if (specs.length === 0) {
    return [];
  }
  const requests: BatchRequest[] = specs.map((spec, index) => ({
    id: String(index),
    method: "POST",
    url: "/subscriptions",
    headers: { "Content-Type": "application/json", Prefer: IMMUTABLE_ID_PREFER },
    body: {
      changeType: spec.changeType ?? "created",
      notificationUrl: spec.notificationUrl,
      lifecycleNotificationUrl: spec.lifecycleNotificationUrl,
      resource: spec.resource,
      expirationDateTime: spec.expirationDateTime.toISOString(),
      clientState: spec.clientState,
      latestSupportedTlsVersion: "v1_2",
    },
  }));
  const responses = await client.batch(requests);
  return specs.map((spec, index): SubscriptionResult => {
    const response = responses.find((r) => r.id === String(index));
    if (!response) {
      return {
        ok: false,
        error: errorOf({ status: 500, body: undefined }, "POST", "/subscriptions"),
      };
    }
    if (response.status >= 200 && response.status < 300) {
      const subscription = subscriptionOf(response.body, spec);
      if (subscription) {
        return { ok: true, subscription };
      }
    }
    return { ok: false, error: errorOf(response, "POST", "/subscriptions") };
  });
}

/** One renewal: the subscription and the new expiry. */
export interface SubscriptionRenewal {
  readonly id: string;
  readonly expirationDateTime: Date;
}

/**
 * Renew subscriptions through `$batch` (PATCH `expirationDateTime`; a renewal also
 * reauthorizes). A subscription Graph no longer knows answers 404 (`error.status`): the
 * caller creates a new one.
 */
export async function renewSubscriptions(
  client: GraphClient,
  renewals: readonly SubscriptionRenewal[],
): Promise<SubscriptionResult[]> {
  if (renewals.length === 0) {
    return [];
  }
  const requests: BatchRequest[] = renewals.map((renewal, index) => ({
    id: String(index),
    method: "PATCH",
    url: `/subscriptions/${encodeURIComponent(renewal.id)}`,
    headers: { "Content-Type": "application/json" },
    body: { expirationDateTime: renewal.expirationDateTime.toISOString() },
  }));
  const responses = await client.batch(requests);
  return renewals.map((renewal, index): SubscriptionResult => {
    const response = responses.find((r) => r.id === String(index));
    const url = `/subscriptions/${renewal.id}`;
    if (response && response.status >= 200 && response.status < 300) {
      const subscription = subscriptionOf(response.body, {
        resource: "",
        expirationDateTime: renewal.expirationDateTime,
      });
      return {
        ok: true,
        subscription: subscription ?? {
          id: renewal.id,
          resource: "",
          expirationDateTime: renewal.expirationDateTime,
        },
      };
    }
    return {
      ok: false,
      error: errorOf(response ?? { status: 500 }, "PATCH", url),
    };
  });
}

/** Answer a `reauthorizationRequired` lifecycle notification. Throws {@link GraphError}. */
export async function reauthorizeSubscription(client: GraphClient, id: string): Promise<void> {
  const url = `/subscriptions/${encodeURIComponent(id)}/reauthorize`;
  const response = await client.request({ method: "POST", url });
  if (response.status < 200 || response.status >= 300) {
    throw errorOf(response, "POST", url);
  }
}

/** Delete a subscription; one Graph does not know (404) counts as deleted. */
export async function deleteSubscription(client: GraphClient, id: string): Promise<void> {
  const url = `/subscriptions/${encodeURIComponent(id)}`;
  const response = await client.request({ method: "DELETE", url });
  if (response.status === 404 || (response.status >= 200 && response.status < 300)) {
    return;
  }
  throw errorOf(response, "DELETE", url);
}

// ---------------------------------------------------------------------------
// What Graph posts

/** One change notification (without resource data). */
export interface ChangeNotification {
  readonly subscriptionId: string;
  readonly clientState: string | null;
  readonly changeType: string;
  readonly resource: string;
  /** The message id (`resourceData.id`), immutable when the subscription asked for it. */
  readonly resourceId: string | null;
  /** The Entra tenant the notification is for. */
  readonly tenantId: string | null;
}

/** One lifecycle notification. */
export interface LifecycleNotification {
  readonly subscriptionId: string;
  readonly clientState: string | null;
  readonly lifecycleEvent: LifecycleEvent;
  readonly tenantId: string | null;
}

/** At most this many notifications are read from one post (Graph sends far fewer). */
export const MAX_NOTIFICATIONS_PER_POST = 1000;

/** The id Graph uses for subscriptions: a GUID, nothing else is looked up. */
const SUBSCRIPTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stringOrNull(value: unknown, max = 1024): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function entries(body: unknown): { items: Record<string, unknown>[]; invalid: number } {
  const value = (body as { value?: unknown } | null)?.value;
  if (!Array.isArray(value)) {
    return { items: [], invalid: body === undefined ? 0 : 1 };
  }
  const items: Record<string, unknown>[] = [];
  let invalid = Math.max(0, value.length - MAX_NOTIFICATIONS_PER_POST);
  for (const item of value.slice(0, MAX_NOTIFICATIONS_PER_POST)) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      items.push(item as Record<string, unknown>);
    } else {
      invalid++;
    }
  }
  return { items, invalid };
}

/** The message id of a notification: `resourceData.id`, else the last segment of `resource`. */
function resourceIdOf(item: Record<string, unknown>): string | null {
  const data = item.resourceData as { id?: unknown } | undefined;
  const fromData = stringOrNull(data?.id);
  if (fromData) {
    return fromData;
  }
  const resource = stringOrNull(item.resource, 2048);
  // Graph writes `Messages/<id>` in newer payloads and `Messages('<id>')` in older ones.
  const match = resource ? /\/messages(?:\/|\(')([^/'()]+)'?\)?$/i.exec(resource) : null;
  if (!match?.[1]) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** Parse a change notification post; malformed entries are counted, never thrown. */
export function parseChangeNotifications(body: unknown): {
  notifications: ChangeNotification[];
  invalid: number;
} {
  const { items, invalid: malformed } = entries(body);
  let invalid = malformed;
  const notifications: ChangeNotification[] = [];
  for (const item of items) {
    const subscriptionId = stringOrNull(item.subscriptionId, 64);
    if (!subscriptionId || !SUBSCRIPTION_ID.test(subscriptionId)) {
      invalid++;
      continue;
    }
    notifications.push({
      subscriptionId: subscriptionId.toLowerCase(),
      clientState: stringOrNull(item.clientState, 256),
      changeType: stringOrNull(item.changeType, 64) ?? "",
      resource: stringOrNull(item.resource, 2048) ?? "",
      resourceId: resourceIdOf(item),
      tenantId: stringOrNull(item.tenantId, 64),
    });
  }
  return { notifications, invalid };
}

/** Parse a lifecycle notification post; malformed and unknown events are counted. */
export function parseLifecycleNotifications(body: unknown): {
  notifications: LifecycleNotification[];
  invalid: number;
} {
  const { items, invalid: malformed } = entries(body);
  let invalid = malformed;
  const notifications: LifecycleNotification[] = [];
  for (const item of items) {
    const subscriptionId = stringOrNull(item.subscriptionId, 64);
    const event = stringOrNull(item.lifecycleEvent, 64);
    if (
      !subscriptionId ||
      !SUBSCRIPTION_ID.test(subscriptionId) ||
      !event ||
      !(LIFECYCLE_EVENTS as readonly string[]).includes(event)
    ) {
      invalid++;
      continue;
    }
    notifications.push({
      subscriptionId: subscriptionId.toLowerCase(),
      clientState: stringOrNull(item.clientState, 256),
      lifecycleEvent: event as LifecycleEvent,
      tenantId: stringOrNull(item.tenantId, 64),
    });
  }
  return { notifications, invalid };
}

/** What is known of a subscription to check a notification against. */
export interface KnownSubscription {
  readonly clientStateHash: string;
}

/**
 * Split notifications into those whose clientState matches their subscription and the
 * rest (unknown subscription, wrong or missing clientState), which are ignored.
 */
export function verifyNotifications<
  N extends { subscriptionId: string; clientState: string | null },
>(
  notifications: readonly N[],
  known: ReadonlyMap<string, KnownSubscription>,
): { accepted: N[]; rejected: number } {
  const accepted: N[] = [];
  let rejected = 0;
  for (const notification of notifications) {
    const subscription = known.get(notification.subscriptionId);
    if (
      subscription &&
      clientStateMatches(notification.clientState, subscription.clientStateHash)
    ) {
      accepted.push(notification);
    } else {
      rejected++;
    }
  }
  return { accepted, rejected };
}
