import type { BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

/**
 * The public HTTP surface of better-auth (`/api/auth/*`) as Restow exposes it.
 *
 * The organization and admin plugins stay enabled: they carry the data model
 * (a tenant is an organization, a provider admin carries the `admin` role) and
 * Restow calls them directly on the server (`auth.api.*`). Over HTTP they would
 * also offer member, invitation, user, role, password and impersonation
 * endpoints that check only better-auth's own roles and never write the Restow
 * audit log. Those changes go through the audited Restow endpoints instead
 * (features/tenants, routes/setup), so HTTP keeps only what the web client uses.
 */

/** Organization endpoints the web client calls: the invitee's side of an invitation, the active tenant. */
const EXPOSED_ORGANIZATION_ENDPOINTS: ReadonlySet<string> = new Set([
  "/organization/get-invitation",
  "/organization/accept-invitation",
  "/organization/reject-invitation",
  "/organization/set-active",
]);

/** Whether an HTTP request may reach a better-auth endpoint (its path below `/api/auth`). */
export function isExposedAuthEndpoint(path: string): boolean {
  const namespace = path.split("/")[1] ?? "";
  if (namespace === "admin") {
    return false;
  }
  if (namespace === "organization") {
    return EXPOSED_ORGANIZATION_ENDPOINTS.has(path);
  }
  return true;
}

/**
 * `hooks.before`: an HTTP request for an endpoint {@link isExposedAuthEndpoint}
 * rejects gets a plain 404, as if the endpoint did not exist. Direct server-side
 * calls (`auth.api.*`) carry no request and pass.
 */
export const guardAuthSurface = createAuthMiddleware(async (ctx) => {
  if (ctx.request && !isExposedAuthEndpoint(ctx.path)) {
    throw new APIError("NOT_FOUND");
  }
});

type RateLimitOptions = NonNullable<BetterAuthOptions["rateLimit"]>;

/**
 * Rate limits for `/api/auth/*`, per client IP and endpoint. better-auth turns
 * them on only when NODE_ENV is `production`; Restow always does, so an
 * environment that says otherwise never leaves sign-in open to online guessing.
 * The counters live in the api process (one instance; it also runs the
 * migrations), so a restart resets them. The two-factor plugin additionally
 * caps attempts per challenge and locks the account after repeated failures,
 * and that lockout is kept in the database.
 */
export const AUTH_RATE_LIMIT = {
  enabled: true,
  storage: "memory",
  window: 10,
  max: 100,
  customRules: {
    // The emergency password path: the one endpoint where a secret is guessed.
    "/sign-in/email": { window: 60, max: 5 },
    // Starting Entra SSO is only a redirect, and many end users share one office IP.
    "/sign-in/social": { window: 60, max: 30 },
    // TOTP and backup codes.
    "/two-factor/*": { window: 60, max: 5 },
  },
} satisfies RateLimitOptions;

/**
 * Audit actions for the invitee's answer to a tenant invitation, which is made
 * through better-auth's own endpoints (the web invitation page).
 */
export const INVITATION_AUDIT_ACTIONS = {
  accepted: "tenant.member.joined",
  declined: "tenant.member.invitation_declined",
} as const;

export type InvitationAuditAction =
  (typeof INVITATION_AUDIT_ACTIONS)[keyof typeof INVITATION_AUDIT_ACTIONS];

/** An answered invitation, as read from the endpoint's response. */
export interface InvitationAnswer {
  action: InvitationAuditAction;
  invitationId: string;
  organizationId: string;
  email: string;
  /** The better-auth membership role the invitation grants. */
  memberRole: string | null;
}

const INVITATION_ANSWERS: Readonly<
  Record<string, { action: InvitationAuditAction; status: string }>
> = {
  "/organization/accept-invitation": {
    action: INVITATION_AUDIT_ACTIONS.accepted,
    status: "accepted",
  },
  "/organization/reject-invitation": {
    action: INVITATION_AUDIT_ACTIONS.declined,
    status: "rejected",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The invitation an accept or reject call answered, from what the endpoint
 * returned; null for any other endpoint and for a failed call (an error, or an
 * invitation that did not reach the answered status).
 */
export function invitationAnswer(path: string, returned: unknown): InvitationAnswer | null {
  const expected = INVITATION_ANSWERS[path];
  if (!expected || !isRecord(returned) || !isRecord(returned.invitation)) {
    return null;
  }
  const { id, organizationId, email, role, status } = returned.invitation;
  if (
    typeof id !== "string" ||
    typeof organizationId !== "string" ||
    typeof email !== "string" ||
    status !== expected.status
  ) {
    return null;
  }
  return {
    action: expected.action,
    invitationId: id,
    organizationId,
    email,
    memberRole: typeof role === "string" ? role : null,
  };
}
