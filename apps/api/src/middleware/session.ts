import {
  type Tenant,
  member,
  providerMemberTenants,
  providerMembers,
  settings,
  tenants,
} from "@restow/db";
import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { type AuthSession, type SessionUser, auth } from "../auth.js";
import { config } from "../config.js";
import { db, providerDb } from "../db.js";
import { isApiKeyAuthorization } from "../features/apikeys/tokens.js";
import { isDemoAccountEmail } from "../lib/demo.js";
import {
  OWNER_ACCESS,
  type ProviderAccess,
  decideProviderRoute,
  providerMayEnterTenant,
} from "../lib/provider-access.js";
import { sessionAssurance } from "../lib/session-assurance.js";
import { isUuid } from "../lib/tenant-context.js";
import { ProblemError } from "../problem.js";
import { type BodyPolicy, assertSameOriginRequest, originOf } from "./browser-request.js";
import { type Role, type TenantRole, decideTenantAccess, isProviderAdminRole } from "./rbac.js";

/**
 * Session and tenant-context middlewares (the spine API contract).
 *
 *   requireSession        — a valid better-auth session cookie, else 401.
 *   requireProviderAdmin  — additionally `user.role === "admin"`, else 403.
 *   requireTenant(min)    — resolves the tenant from `X-Restow-Tenant` (tenant id)
 *                           or the session's active organization, checks the
 *                           membership and exposes `tenantId`, `tenant`, `role`.
 *
 * Each middleware is self-contained (it authenticates on its own), so a route
 * uses exactly one of them. Tenant-scoped database work in the handlers then
 * goes through `withTenantTx(db, c.get("tenantId"), ...)` so Row Level Security
 * applies.
 *
 * All three first refuse state-changing requests from other sites and bodies
 * that are not JSON (./browser-request.ts), before the session is looked up,
 * so every route behind them inherits the protection.
 */

/** Header carrying the tenant id for tenant-scoped requests. */
export const TENANT_HEADER = "x-restow-tenant";

/**
 * Problem type of a request made with a password-only session: the account
 * must enrol an authenticator app (TOTP) before anything else.
 */
export const TOTP_ENROLLMENT_REQUIRED_PROBLEM = "urn:restow:problem:totp-enrollment-required";

export interface Membership {
  organizationId: string;
  /** Raw better-auth membership role (`owner`, `admin`, `member`, or a list). */
  role: string;
}

/** Variables contributed by {@link requireSession} and {@link requireProviderAdmin}. */
export interface SessionVariables {
  auth: AuthSession;
  user: SessionUser;
  isProviderAdmin: boolean;
  /**
   * What the provider admin may do and in which tenants (lib/provider-access.ts);
   * null for everyone who is not a provider admin.
   */
  providerAccess: ProviderAccess | null;
  /** Organization memberships of the user (empty for provider admins, who need none). */
  memberships: Membership[];
}

/** The tenant a request acts on, as exposed to handlers. */
export type TenantContext = Pick<Tenant, "id" | "name" | "slug" | "organizationId" | "status">;

/** Variables contributed by {@link requireTenant} (on top of the session ones). */
export interface TenantVariables extends SessionVariables {
  tenantId: string;
  tenant: TenantContext;
  /** Effective role inside the tenant; `provider_admin` for the provider. */
  role: Role;
}

export type SessionEnv = { Variables: SessionVariables };
export type TenantEnv = { Variables: TenantVariables };

/** Minimal setter shared by both context shapes (avoids Hono's invariant `set`). */
interface SessionSink {
  set(key: "auth", value: AuthSession): void;
  set(key: "user", value: SessionUser): void;
  set(key: "isProviderAdmin", value: boolean): void;
  set(key: "providerAccess", value: ProviderAccess | null): void;
  set(key: "memberships", value: Membership[]): void;
}

async function loadMemberships(userId: string): Promise<Membership[]> {
  return db
    .select({ organizationId: member.organizationId, role: member.role })
    .from(member)
    .where(eq(member.userId, userId));
}

/**
 * The provider admin's role and tenant scope from the provider team
 * (packages/db schema/provider-team.ts), read on the installation pool: the
 * tenant role has no access to those tables at all. No row means an owner
 * with every tenant (the first admin, and every installation before the
 * team existed).
 */
export async function loadProviderAccess(userId: string): Promise<ProviderAccess> {
  const [row] = await providerDb
    .select({ role: providerMembers.role, allTenants: providerMembers.allTenants })
    .from(providerMembers)
    .where(eq(providerMembers.userId, userId))
    .limit(1);
  if (!row) {
    return OWNER_ACCESS;
  }
  if (row.allTenants) {
    return { role: row.role, allTenants: true, tenantIds: new Set() };
  }
  const scoped = await providerDb
    .select({ tenantId: providerMemberTenants.tenantId })
    .from(providerMemberTenants)
    .where(eq(providerMemberTenants.userId, userId));
  return {
    role: row.role,
    allTenants: false,
    tenantIds: new Set(scoped.map((entry) => entry.tenantId)),
  };
}

/** Problem type of a request a provider admin's team role or tenant scope does not cover. */
export const PROVIDER_ROLE_PROBLEM = "urn:restow:problem:provider-role-required";

/**
 * Apply the provider team's rules (lib/provider-access.ts) to the route that
 * will answer this request: the last route Hono matched, i.e. the handler,
 * never a `use("*")` middleware in front of it. Every session middleware
 * runs this, so no route behind one of them can skip it.
 */
export function assertProviderRoute(c: Context, state: SessionVariables): void {
  if (!state.isProviderAdmin || !state.providerAccess) {
    return;
  }
  const decision = decideProviderRoute(
    state.providerAccess,
    c.req.method,
    routePath(c, -1),
    c.req.param() as Record<string, string | undefined>,
  );
  if (decision.allowed) {
    return;
  }
  if (decision.reason === "scope") {
    throw new ProblemError(403, "Tenant not in your scope", {
      type: PROVIDER_ROLE_PROBLEM,
      detail: "Your provider role covers other tenants only, or not every tenant at once.",
      extensions: { reason: "scope" },
    });
  }
  throw new ProblemError(403, "Provider role required", {
    type: PROVIDER_ROLE_PROBLEM,
    detail: `This needs the ${decision.required} provider role or higher.`,
    extensions: { reason: "role", requiredProviderRole: decision.required },
  });
}

/** Resolve the better-auth session for the request, or null. */
export async function sessionFromRequest(headers: Headers): Promise<AuthSession | null> {
  return auth.api.getSession({ headers });
}

/**
 * Whether the session was opened by better-auth's admin impersonation. Restow
 * never opens one (the endpoint is closed, see lib/auth-surface.ts): such a
 * session would act under the impersonated person's name, with no trace of the
 * admin behind it. Acting for someone else goes through the restore flow, which
 * records both people and a reason.
 */
export function isImpersonationSession(state: {
  session: { impersonatedBy?: string | null };
}): boolean {
  return Boolean(state.session.impersonatedBy);
}

/** Authenticate the request and return the session state; 401/403 problems otherwise. */
export async function authenticate(headers: Headers): Promise<SessionVariables> {
  const session = await sessionFromRequest(headers);
  if (!session) {
    throw new ProblemError(401, "Unauthorized", { detail: "Sign in to use this endpoint." });
  }
  if (session.user.banned) {
    throw new ProblemError(403, "Account disabled", {
      detail: "This account has been disabled by an administrator.",
    });
  }
  if (isImpersonationSession(session)) {
    throw new ProblemError(403, "Impersonation not permitted", {
      detail:
        "Sessions that act as another account are not accepted. Sign in with your own account; restores for another person are recorded under your name.",
    });
  }
  // A password alone never reaches Restow: it only enrols an authenticator app
  // (lib/session-assurance.ts; the better-auth side is guarded the same way).
  // The one exception is the demo account while demo mode is on (lib/demo.ts).
  const assurance = sessionAssurance(
    { authMethod: session.session.authMethod },
    { twoFactorEnabled: session.user.twoFactorEnabled },
    { demoPasswordBypass: isDemoAccountEmail(session.user.email, config.demo) },
  );
  if (assurance === "totp_enrollment") {
    throw new ProblemError(403, "Authenticator app required", {
      type: TOTP_ENROLLMENT_REQUIRED_PROBLEM,
      detail: "Signing in with a password requires an authenticator app. Set one up to continue.",
    });
  }
  if (assurance === "reauthenticate") {
    throw new ProblemError(401, "Unauthorized", { detail: "Sign in again to continue." });
  }
  const isProviderAdmin = isProviderAdminRole(session.user.role);
  return {
    auth: session,
    user: session.user,
    isProviderAdmin,
    providerAccess: isProviderAdmin ? await loadProviderAccess(session.user.id) : null,
    memberships: isProviderAdmin ? [] : await loadMemberships(session.user.id),
  };
}

function applySession(c: SessionSink, state: SessionVariables): void {
  c.set("auth", state.auth);
  c.set("user", state.user);
  c.set("isProviderAdmin", state.isProviderAdmin);
  c.set("providerAccess", state.providerAccess);
  c.set("memberships", state.memberships);
}

/**
 * The public origins the installation is configured for: the environment's
 * and the one the setup wizard stored. Behind a proxy that rewrites the host
 * (the Vite dev server), these are how the browser's origin is recognized.
 */
async function configuredPublicOrigins(): Promise<string[]> {
  const [row] = await db.select({ publicUrl: settings.publicUrl }).from(settings).limit(1);
  return [config.publicUrl, row?.publicUrl]
    .map(originOf)
    .filter((origin): origin is string => origin !== null);
}

/**
 * Refuse cross-site changes and non-JSON bodies (./browser-request.ts). Exported
 * for public routes that must count a refusal themselves (agent enrollment).
 */
export async function guardBrowserRequest(c: Context, policy: BodyPolicy = {}): Promise<void> {
  await assertSameOriginRequest(
    {
      method: c.req.method,
      header: (name) => c.req.header(name),
      url: c.req.url,
      publicOrigins: configuredPublicOrigins,
    },
    policy,
  );
}

/**
 * The cross-site and content-type protection of the session middlewares on
 * its own, for public routes that change state without a session (the setup
 * wizard, routes/setup.ts; set-password links, features/accounts/routes.ts):
 * a state-changing request from another site is refused with 403, a body that
 * is not JSON with 415. middleware/public-routes.test.ts lists every public
 * route that changes state and checks that it is guarded.
 */
export const requireSameOrigin: MiddlewareHandler = async (c, next) => {
  await guardBrowserRequest(c);
  await next();
};

/** Require a signed-in user. Exposes `auth`, `user`, `isProviderAdmin`, `memberships`. */
export const requireSession: MiddlewareHandler<SessionEnv> = async (c, next) => {
  await guardBrowserRequest(c);
  const state = await authenticate(c.req.raw.headers);
  assertProviderRoute(c, state);
  applySession(c, state);
  await next();
};

/**
 * Refuse Restow API keys on routes of the web UI: an integration learns that
 * the endpoint is not part of the API (403) instead of being asked to sign in.
 */
export const refuseApiKeys: MiddlewareHandler = async (c, next) => {
  if (isApiKeyAuthorization(c.req.header("authorization"))) {
    throw new ProblemError(403, "Not available to API keys", {
      type: "urn:restow:problem:session-required",
      detail: "This endpoint belongs to the web UI and needs a signed-in provider admin.",
    });
  }
  await next();
};

/** Require a provider admin (global). */
export const requireProviderAdmin: MiddlewareHandler<SessionEnv> = async (c, next) => {
  await guardBrowserRequest(c);
  const state = await authenticate(c.req.raw.headers);
  if (!state.isProviderAdmin) {
    throw new ProblemError(403, "Provider admin required", {
      detail: "Only provider administrators may use this endpoint.",
    });
  }
  assertProviderRoute(c, state);
  applySession(c, state);
  await next();
};

/** Where the tenant of a request was named. */
type TenantSelector = { by: "id"; value: string } | { by: "organization"; value: string };

/** Pick the tenant selector from the header, else the session's active organization. */
export function tenantSelector(
  header: string | undefined,
  activeOrganizationId: string | null | undefined,
): TenantSelector | null {
  const fromHeader = header?.trim();
  if (fromHeader) {
    if (!isUuid(fromHeader)) {
      throw new ProblemError(400, "Invalid tenant id", {
        detail: `The ${TENANT_HEADER} header must carry a tenant id (UUID).`,
      });
    }
    return { by: "id", value: fromHeader };
  }
  return activeOrganizationId ? { by: "organization", value: activeOrganizationId } : null;
}

/**
 * The tenant a request names. No tenant is pinned yet at this point, so the
 * lookup runs on the installation pool; access is decided right after it.
 */
async function loadTenant(selector: TenantSelector): Promise<TenantContext | null> {
  const [row] = await providerDb
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      organizationId: tenants.organizationId,
      status: tenants.status,
    })
    .from(tenants)
    .where(
      selector.by === "id"
        ? eq(tenants.id, selector.value)
        : eq(tenants.organizationId, selector.value),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Resolve the tenant a request acts on and the requester's effective role in
 * it; throws the matching problem when access is denied.
 */
export async function resolveTenantAccess(
  state: SessionVariables,
  header: string | undefined,
  minimumRole: TenantRole,
): Promise<{ tenant: TenantContext; role: Role }> {
  const selector = tenantSelector(header, state.auth.session.activeOrganizationId);
  if (!selector) {
    throw new ProblemError(400, "Tenant context required", {
      detail: `Send the ${TENANT_HEADER} header or select an active tenant.`,
    });
  }
  const tenant = await loadTenant(selector);
  if (!tenant) {
    throw new ProblemError(404, "Tenant not found");
  }
  // A provider admin limited to some tenants learns nothing about the others.
  if (
    state.isProviderAdmin &&
    state.providerAccess &&
    !providerMayEnterTenant(state.providerAccess, tenant.id)
  ) {
    throw new ProblemError(404, "Tenant not found");
  }

  const membership = tenant.organizationId
    ? (state.memberships.find((m) => m.organizationId === tenant.organizationId) ?? null)
    : null;
  const decision = decideTenantAccess({
    isProviderAdmin: state.isProviderAdmin,
    membershipRole: membership?.role ?? null,
    minimumRole,
  });
  if (!decision.allowed) {
    // A non-member learns nothing about the tenant's existence.
    if (decision.reason === "not_a_member") {
      throw new ProblemError(404, "Tenant not found");
    }
    throw new ProblemError(403, "Insufficient role", {
      detail: `This endpoint requires the ${minimumRole} role.`,
      extensions: { requiredRole: minimumRole, role: decision.role },
    });
  }
  assertTenantAdmits(tenant, decision.role);
  return { tenant, role: decision.role };
}

/**
 * The tenant-state gate: a tenant that is not active is closed to its own
 * people, administrators included, so a suspension stops restores, settings
 * and member management alike. Only the provider still acts on it (to look
 * into it, or to resume it). Every route that admits a tenant's members to a
 * tenant applies this after the role check.
 */
export function assertTenantAdmits(tenant: Pick<TenantContext, "status">, role: Role): void {
  if (tenant.status !== "active" && role !== "provider_admin") {
    throw new ProblemError(403, "Tenant suspended", {
      detail: "This tenant is currently suspended.",
    });
  }
}

/**
 * Require a tenant context with at least `minimumRole`. Provider admins may enter
 * any tenant; everyone else needs a membership in the tenant's organization.
 * Authenticates on its own, so it is used instead of (not after) requireSession.
 */
export function requireTenant(
  minimumRole: TenantRole = "tenant_user",
  bodyPolicy: BodyPolicy = {},
): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    await guardBrowserRequest(c, bodyPolicy);
    const state = await authenticate(c.req.raw.headers);
    assertProviderRoute(c, state);
    const { tenant, role } = await resolveTenantAccess(
      state,
      c.req.header(TENANT_HEADER),
      minimumRole,
    );
    applySession(c, state);
    c.set("tenantId", tenant.id);
    c.set("tenant", tenant);
    c.set("role", role);
    await next();
  };
}
