import { type Context, Hono } from "hono";
import { db } from "../../db.js";
import { requestLanguage } from "../../lib/language.js";
import { clientIp } from "../../lib/request.js";
import {
  type SessionEnv,
  type SessionVariables,
  requireSameOrigin,
  requireSession,
  resolveTenantAccess,
} from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import { SlidingWindowRateLimiter } from "../apikeys/rate-limit.js";
import {
  accountUserParamSchema,
  listAccountsQuerySchema,
  provisionAccountSchema,
  setPasswordSchema,
  setPasswordTokenParamSchema,
  tenantIdParamSchema,
} from "./schemas.js";
import {
  type Actor,
  checkSetPasswordToken,
  listPendingAccounts,
  provisionAccount,
  redeemSetPasswordToken,
  reissueAccountLink,
} from "./service.js";

/**
 * Accounts for people without Microsoft sign-in.
 *
 * Tenant-scoped, nested under the tenants feature's own URL space
 * (/api/v1/tenants/:tenantId/...; this feature's `mountPath` is empty and its
 * routes spell that prefix out themselves — see meta.ts):
 *   GET  /tenants/:tenantId/accounts                   pending accounts (no working sign-in yet)
 *   POST /tenants/:tenantId/accounts                    provision (create or reuse) + issue a link
 *   POST /tenants/:tenantId/accounts/:userId/reissue     regenerate the link ("Resend" / "Copy new link")
 *
 * Public (mounted at /api/v1/accounts), rate-limited per IP:
 *   GET  /set-password/:token                      valid / expired / used / invalid, a masked email hint
 *   POST /set-password                              redeem { token, password }
 * The redeem is refused from another site (403) and with a body that is not
 * JSON (415), like every route behind a session (middleware/session.ts
 * `requireSameOrigin`): only the web app's own set-password page sends it.
 *
 * Provisioning requires tenant_admin of that tenant (or a provider admin); a
 * tenant admin can never act on another tenant's id (resolveTenantAccess
 * hides it as 404, same as every other tenant-scoped route) and, inside a
 * tenant they do reach, can never pull in an account that already belongs to
 * a different tenant or that already administers the whole installation
 * (service.ts). Demo mode refuses every one of the tenant-scoped writes and
 * the public redeem automatically (middleware/demo-guard.ts; none of them is
 * on its allowlist).
 */

export const accountsRoutes = new Hono<SessionEnv>();
export const accountsPublicRoutes = new Hono();

// Changes only from the web app itself, and only as JSON (the GET check passes).
accountsPublicRoutes.use("*", requireSameOrigin);

function actorOf(c: Context<SessionEnv>): Actor {
  const sessionUser = c.get("user");
  return {
    id: sessionUser.id,
    email: sessionUser.email,
    ip: clientIp(c),
    isProviderAdmin: c.get("isProviderAdmin"),
  };
}

/** Resolve `:tenantId` with tenant-admin access; hides a foreign tenant as 404. */
async function tenantForAccounts(c: Context<SessionEnv>) {
  const { tenantId } = parseOrProblem(tenantIdParamSchema, c.req.param());
  const state: SessionVariables = {
    auth: c.get("auth"),
    user: c.get("user"),
    isProviderAdmin: c.get("isProviderAdmin"),
    providerAccess: c.get("providerAccess"),
    memberships: c.get("memberships"),
  };
  const { tenant } = await resolveTenantAccess(state, tenantId, "tenant_admin");
  return tenant;
}

accountsRoutes.get("/tenants/:tenantId/accounts", requireSession, async (c) => {
  const tenant = await tenantForAccounts(c);
  const { limit } = parseOrProblem(listAccountsQuerySchema, c.req.query());
  return c.json({ items: await listPendingAccounts(db, tenant, { limit }) });
});

accountsRoutes.post("/tenants/:tenantId/accounts", requireSession, async (c) => {
  const tenant = await tenantForAccounts(c);
  const input = await parseJsonBody(c.req, provisionAccountSchema);
  const result = await provisionAccount(db, tenant, input, actorOf(c), requestLanguage(c));
  return c.json(result, 201);
});

accountsRoutes.post("/tenants/:tenantId/accounts/:userId/reissue", requireSession, async (c) => {
  const tenant = await tenantForAccounts(c);
  const { userId } = parseOrProblem(accountUserParamSchema, c.req.param());
  const result = await reissueAccountLink(db, tenant, userId, actorOf(c), requestLanguage(c));
  return c.json(result);
});

// --- Public: checking and redeeming a set-password link ------------------------------

/** Reading a token's status: generous, since a person may reload the page. */
const CHECK_RATE_LIMIT = new SlidingWindowRateLimiter(30, 10 * 60 * 1000);
/** Redeeming: tighter, this is the one call that guesses a secret. */
const REDEEM_RATE_LIMIT = new SlidingWindowRateLimiter(10, 10 * 60 * 1000);

function tooManyRequests(retryAfterMs: number): ProblemError {
  return new ProblemError(429, "Too many requests", {
    type: "urn:restow:problem:account-link-rate-limited",
    detail: "Too many attempts. Wait a moment and try again.",
    extensions: { retryAfterSeconds: Math.ceil(retryAfterMs / 1000) },
  });
}

function rateLimitKey(c: Context): string {
  return clientIp(c) ?? "unknown";
}

accountsPublicRoutes.get("/set-password/:token", async (c) => {
  const decision = CHECK_RATE_LIMIT.consume(rateLimitKey(c), Date.now());
  if (!decision.allowed) {
    throw tooManyRequests(decision.retryAfterMs);
  }
  const { token } = parseOrProblem(setPasswordTokenParamSchema, c.req.param());
  return c.json(await checkSetPasswordToken(db, token));
});

accountsPublicRoutes.post("/set-password", async (c) => {
  const decision = REDEEM_RATE_LIMIT.consume(rateLimitKey(c), Date.now());
  if (!decision.allowed) {
    throw tooManyRequests(decision.retryAfterMs);
  }
  const input = await parseJsonBody(c.req, setPasswordSchema);
  const result = await redeemSetPasswordToken(db, input, { ip: clientIp(c) });
  return c.json(result);
});
