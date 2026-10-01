import { apiKeys, tenants } from "@restow/db";
import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { db, providerDb } from "../db.js";
import {
  type KeyTenantDeps,
  isWriteMethod,
  resolveKeyTenant,
} from "../features/apikeys/key-tenant.js";
import { type RateDecision, SlidingWindowRateLimiter } from "../features/apikeys/rate-limit.js";
import { type KeyRead, keyReadEvent } from "../features/apikeys/read-audit.js";
import { type ApiScope, hasScope, normalizeScopes } from "../features/apikeys/scopes.js";
import {
  API_KEY_PREFIX,
  bearerToken,
  hashApiKey,
  isApiKeyAuthorization,
  isWellFormedApiKey,
} from "../features/apikeys/tokens.js";
import { audit } from "../lib/audit.js";
import { requireFeature } from "../lib/features.js";
import { clientIp } from "../lib/request.js";
import { ProblemError } from "../problem.js";
import type { TenantRole } from "./rbac.js";
import { TENANT_HEADER, type TenantEnv, requireTenant } from "./session.js";

/**
 * API-key authentication and scope enforcement (docs/ARCHITECTURE.md, "API").
 *
 * Tenant keys are `rsk_<tenant>_<random>` and act on their own tenant only;
 * provider keys `rsk_provider_...` (while `apiKeys.provider` is on) name the tenant
 * in `X-Restow-Tenant` or use the provider-only endpoints. A presented token
 * is hashed (SHA-256) and matched against `api_keys.key_hash`; the token is
 * never stored or logged. Every authenticated request counts against the
 * key's limit of 600 requests per 10 minutes, and `last_used_at` is kept
 * current to the minute.
 *
 * The lookup happens before any tenant is known, so it runs on the
 * installation role like the session lookup (packages/db/sql/rls.sql).
 */

export { API_SCOPES, type ApiScope } from "../features/apikeys/scopes.js";
export { tenantForApiKey } from "../features/apikeys/key-tenant.js";

export interface ApiKeyContext {
  keyId: string;
  /** The key's own tenant; null for a provider key (cross-tenant). */
  tenantId: string | null;
  isProvider: boolean;
  scopes: ApiScope[];
}

/** Hono `Variables` contributed by {@link requireApiKey}. */
export interface ApiKeyVariables {
  apiKey: ApiKeyContext;
}

export interface RequireApiKeyOptions {
  /** Require a provider key (SPE cross-tenant endpoints). */
  provider?: boolean;
}

/** `last_used_at` is written at most this often per key. */
export const LAST_USED_RESOLUTION_MS = 60_000;

/** Process-wide limiter for all API keys. */
export const apiKeyRateLimiter = new SlidingWindowRateLimiter();

/** Audit/actor label of an API key. */
export function apiKeyActorLabel(keyId: string): string {
  return `api-key:${keyId}`;
}

/** Why a stored key cannot be used, or null when it can. */
export function keyUnusableReason(
  key: { revokedAt: Date | null; expiresAt: Date | null },
  now: Date,
): "revoked" | "expired" | null {
  if (key.revokedAt !== null) {
    return "revoked";
  }
  if (key.expiresAt !== null && key.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  return null;
}

/** Whether `last_used_at` is stale enough to be written again. */
export function shouldTouchLastUsed(lastUsedAt: Date | null, now: Date): boolean {
  return lastUsedAt === null || now.getTime() - lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS;
}

const INVALID_KEY_DETAIL: Record<"unknown" | "revoked" | "expired", string> = {
  unknown: "The API key is not valid.",
  revoked: "The API key has been revoked.",
  expired: "The API key has expired.",
};

function invalidKey(reason: keyof typeof INVALID_KEY_DETAIL): ProblemError {
  return new ProblemError(401, "Invalid API key", {
    type: "urn:restow:problem:invalid-api-key",
    detail: INVALID_KEY_DETAIL[reason],
  });
}

function touchLastUsed(keyId: string, now: Date): void {
  // Bookkeeping must never fail or slow down the request it describes. The key
  // may be a provider key (no tenant), so it is written on the installation pool.
  void providerDb
    .update(apiKeys)
    .set({ lastUsedAt: now })
    .where(eq(apiKeys.id, keyId))
    .catch(() => undefined);
}

/**
 * Resolve a presented token to its key context; throws 401/403 problems for
 * unknown, revoked or expired keys and for keys of a suspended tenant.
 */
export async function authenticateApiKey(
  token: string,
  now: Date = new Date(),
): Promise<ApiKeyContext> {
  if (!isWellFormedApiKey(token)) {
    throw invalidKey("unknown");
  }
  // Before the key is known there is no tenant to pin: the installation pool.
  const [row] = await providerDb
    .select({
      id: apiKeys.id,
      tenantId: apiKeys.tenantId,
      scopes: apiKeys.scopes,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      lastUsedAt: apiKeys.lastUsedAt,
      tenantStatus: tenants.status,
    })
    .from(apiKeys)
    .leftJoin(tenants, eq(tenants.id, apiKeys.tenantId))
    .where(eq(apiKeys.keyHash, hashApiKey(token)))
    .limit(1);
  if (!row) {
    throw invalidKey("unknown");
  }
  const unusable = keyUnusableReason(row, now);
  if (unusable) {
    throw invalidKey(unusable);
  }
  if (row.tenantId !== null && row.tenantStatus !== "active") {
    throw new ProblemError(403, "Tenant suspended", {
      detail: "The tenant of this API key is currently suspended.",
    });
  }
  if (shouldTouchLastUsed(row.lastUsedAt, now)) {
    touchLastUsed(row.id, now);
  }
  return {
    keyId: row.id,
    tenantId: row.tenantId,
    isProvider: row.tenantId === null,
    scopes: normalizeScopes(row.scopes),
  };
}

/** Rate-limit headers (IETF RateLimit fields, seconds). */
export function rateLimitHeaders(decision: RateDecision): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(decision.limit),
    "RateLimit-Remaining": String(decision.remaining),
    "RateLimit-Reset": String(Math.ceil(decision.resetMs / 1000)),
  };
  if (!decision.allowed) {
    headers["Retry-After"] = String(Math.ceil(decision.retryAfterMs / 1000));
  }
  return headers;
}

/** Count the request against the key's limit; sets the headers, throws 429 when exhausted. */
function enforceRateLimit(c: Context, key: ApiKeyContext, now: Date): void {
  const decision = apiKeyRateLimiter.consume(key.keyId, now.getTime());
  for (const [name, value] of Object.entries(rateLimitHeaders(decision))) {
    c.header(name, value);
  }
  if (!decision.allowed) {
    throw new ProblemError(429, "Too Many Requests", {
      type: "urn:restow:problem:rate-limited",
      detail: `This API key is limited to ${decision.limit} requests per 10 minutes.`,
      extensions: { retryAfterSeconds: Math.ceil(decision.retryAfterMs / 1000) },
    });
  }
}

function requireScope(key: ApiKeyContext, scope: ApiScope): void {
  if (!hasScope(key.scopes, scope)) {
    throw new ProblemError(403, "Insufficient scope", {
      detail: `Requires scope '${scope}'.`,
      extensions: { requiredScope: scope },
    });
  }
}

/** Authenticate the bearer token of a request: problem responses for every failure. */
async function authenticateRequest(c: Context, scope: ApiScope): Promise<ApiKeyContext> {
  const token = bearerToken(c.req.header("authorization"));
  if (!token) {
    throw new ProblemError(401, "Missing API key", {
      detail: "Provide 'Authorization: Bearer rsk_...'.",
    });
  }
  if (!token.startsWith(API_KEY_PREFIX)) {
    throw invalidKey("unknown");
  }
  const now = new Date();
  const key = await authenticateApiKey(token, now);
  enforceRateLimit(c, key, now);
  requireScope(key, scope);
  return key;
}

/**
 * Middleware factory: authenticate the API key, count it against its rate
 * limit, optionally require a provider key, and require `scope`. On success
 * the {@link ApiKeyContext} is available as `c.get("apiKey")`.
 */
export function requireApiKey(
  scope: ApiScope,
  options: RequireApiKeyOptions = {},
): MiddlewareHandler<{ Variables: ApiKeyVariables }> {
  return async (c, next) => {
    const key = await authenticateRequest(c, scope);
    if (options.provider && !key.isProvider) {
      throw new ProblemError(403, "Provider key required", {
        detail: "This endpoint is only available with a provider key.",
      });
    }
    c.set("apiKey", key);
    await next();
  };
}

// ---------------------------------------------------------------------------
// Session or API key: one surface for the UI and for integrations
// ---------------------------------------------------------------------------

/** Who performs an action, for the audit log: a signed-in person or an integration key. */
export interface IntegrationActor {
  /** better-auth user id; null for an API key. */
  userId: string | null;
  /** Audit label: the user's email or `api-key:<id>`. */
  label: string;
  ip: string | null;
}

export interface TenantAccessVariables {
  tenantId: string;
  actor: IntegrationActor;
  /** The key when an integration called; null for a signed-in user. */
  apiKey: ApiKeyContext | null;
}

export type TenantAccessEnv = { Variables: TenantAccessVariables };

const keyTenantDeps: KeyTenantDeps = { db, requireFeature };

/** Methods whose successful answer is a read of the tenant's data. */
const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * Record a key's read in the tenant's audit log once the route has answered
 * it successfully (features/apikeys/read-audit.ts decides whether and under
 * which action). Every read of user or backup data is recorded, so a read
 * that cannot be recorded is not served: its answer is discarded (an event
 * stream is cancelled) and the request fails.
 */
async function recordKeyRead(
  c: Context,
  read: Omit<KeyRead, "method" | "stream" | "query">,
): Promise<void> {
  if (!READ_METHODS.has(c.req.method) || !c.res.ok) {
    return;
  }
  const event = keyReadEvent({
    ...read,
    method: c.req.method,
    stream: (c.res.headers.get("content-type") ?? "").startsWith("text/event-stream"),
    query: c.req.query(),
  });
  if (!event) {
    return;
  }
  try {
    await audit(db, event);
  } catch (error) {
    await c.res.body?.cancel().catch(() => undefined);
    throw error;
  }
}

/**
 * Require either a session with at least `minimumRole` in the tenant (the web
 * UI) or an API key with `scope` (RMM/PSA integrations). A key passes the
 * same tenant rules as on the integration API (features/apikeys/key-tenant.ts):
 * provider keys only while `apiKeys.provider` is on, and no changes to a
 * tenant that is not active. Its successful reads are recorded in the audit
 * log like the integration API's (features/apikeys/read-audit.ts); a
 * session's go through the session gate, including its cross-site checks.
 * Handlers see `tenantId`, an `actor` for the audit log and, for
 * integrations, `apiKey`.
 */
export function requireTenantOrApiKey(
  scope: ApiScope,
  minimumRole: TenantRole = "tenant_admin",
): MiddlewareHandler<TenantAccessEnv> {
  const sessionGate = requireTenant(minimumRole);
  return async (c, next) => {
    const ip = clientIp(c);
    if (isApiKeyAuthorization(c.req.header("authorization"))) {
      const key = await authenticateRequest(c, scope);
      const tenant = await resolveKeyTenant(
        keyTenantDeps,
        key,
        c.req.header(TENANT_HEADER),
        isWriteMethod(c.req.method),
      );
      const label = apiKeyActorLabel(key.keyId);
      c.set("tenantId", tenant.id);
      c.set("apiKey", key);
      c.set("actor", { userId: null, label, ip });
      // The route this gate guards, as matched now (before the handlers after it run).
      const route = routePath(c);
      const itemId = c.req.param("id");
      await next();
      await recordKeyRead(c, {
        scope,
        tenantId: tenant.id,
        actor: { keyId: key.keyId, label, ip },
        route,
        itemId,
      });
      return;
    }
    const session = c as unknown as Context<TenantEnv>;
    await sessionGate(session, async () => {
      const user = session.get("user");
      c.set("tenantId", session.get("tenantId"));
      c.set("apiKey", null);
      c.set("actor", { userId: user.id, label: user.email, ip });
      await next();
    });
  };
}
