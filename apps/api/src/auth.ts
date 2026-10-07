import { passkey } from "@better-auth/passkey";
import { tenants } from "@restow/db";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { admin, organization, twoFactor } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { config } from "./config.js";
import { db, providerDb } from "./db.js";
import { authPlugins } from "./extensions.js";
import { audit } from "./lib/audit.js";
import { sessionAssurancePlugin } from "./lib/auth-hooks.js";
import { authLogger, writeAuthLog } from "./lib/auth-logger.js";
import { AUTH_RATE_LIMIT, guardAuthSurface, invitationAnswer } from "./lib/auth-surface.js";
import { authenticatorReplacePlugin } from "./lib/authenticator-replace.js";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./lib/password-policy.js";
import {
  CHANGE_PASSWORD_PATH,
  PASSWORD_AUDIT_ACTIONS,
  PASSWORD_RESET_TOKEN_TTL_SECONDS,
  auditPasswordEvent,
  changedPasswordUser,
  ipOfRequest,
  languageOfRequest,
  sendPasswordResetMail,
} from "./lib/password-reset.js";
import { clientIpOf, trustedProxies } from "./lib/request.js";
import { totpIssuer } from "./lib/sign-in-options.js";

/**
 * Authentication (docs/STACK.md, "## Auth").
 *
 * Passkey-first for operators (WebAuthn, user verification required) — but only
 * offered when the domain is verifiably clean (see `passkeyReady.ts`). The
 * emergency password path exists as a fallback with a mandatory TOTP second
 * factor (two-factor plugin): an account with a password enrols an
 * authenticator before it can use Restow, and every later password sign-in asks
 * for its code. The Microsoft (Entra ID) sign-in for end users is a Business
 * module (ee/api/src/sso), registered through the extension point below; it
 * never creates an account by itself.
 *
 * Roles (see middleware/rbac.ts):
 *   - provider admin  = `user.role === "admin"` from the admin plugin, global.
 *   - tenant roles    = organization membership; a tenant IS an organization.
 *
 * better-auth owns its own tables (user, session, account, passkey, organization,
 * member, invitation, two_factor, verification, rate_limit). They are generated with the
 * better-auth CLI and migrated against the same database as the Restow schema.
 *
 * Over HTTP only the endpoints the web client uses are reachable; membership,
 * user and impersonation management run through the audited Restow endpoints
 * (lib/auth-surface.ts). Rate limits apply whatever NODE_ENV says, and their
 * counters live in Postgres (`rate_limit`), so restarting the api resets none.
 */

/**
 * The Entra identity (object id and tenant id) on the better-auth user, stored
 * in `user.entra_object_id` / `user.entra_tenant_id` (packages/db). Only the
 * server writes them (`input: false`): neither sign-up nor update-user accepts
 * them from a client, so nobody can claim someone else's identity.
 */
export const ENTRA_IDENTITY_USER_FIELDS = {
  entraObjectId: { type: "string", required: false, input: false },
  entraTenantId: { type: "string", required: false, input: false },
} as const satisfies NonNullable<NonNullable<BetterAuthOptions["user"]>["additionalFields"]>;

/** Invitations to a tenant stay open for seven days. */
const INVITATION_TTL_SECONDS = 60 * 60 * 24 * 7;

/**
 * Tenants can hold thousands of members (every protected end user who signs in
 * with Entra becomes a member), so the plugin default of 100 must not apply.
 */
const MEMBERSHIP_LIMIT = 1_000_000;

/** Derive the WebAuthn RP id (registrable host) from the public URL, if any. */
function relyingPartyId(publicUrl: string | undefined): string | undefined {
  if (!publicUrl) {
    return undefined;
  }
  try {
    return new URL(publicUrl).hostname;
  } catch {
    return undefined;
  }
}

/**
 * `hooks.after`: the invitee accepting or declining a tenant invitation is a
 * membership change made through better-auth's own endpoint, so it is written
 * to the tenant's audit log here.
 */
async function auditInvitationAnswer(input: {
  path: string;
  returned: unknown;
  request: Request;
  invitee: { id: string; email: string } | null | undefined;
}): Promise<void> {
  const { request } = input;
  const answer = invitationAnswer(input.path, input.returned);
  if (!answer) {
    return;
  }
  // Which tenant the organization belongs to is not known yet: the installation pool.
  const [tenant] = await providerDb
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.organizationId, answer.organizationId))
    .limit(1);
  if (!tenant) {
    return;
  }
  await audit(db, {
    tenantId: tenant.id,
    actor: input.invitee?.email ?? answer.email,
    actorUserId: input.invitee?.id ?? null,
    action: answer.action,
    target: answer.invitationId,
    targetType: "invitation",
    ip: clientIpOf((name) => request.headers.get(name) ?? undefined),
    details: { email: answer.email, memberRole: answer.memberRole },
  });
}

/**
 * `hooks.after`: the signed-in person changed their own password
 * (`/change-password`, Account › Sign-in security). Written to the
 * installation audit chain, like the reset by mail and the recovery on the
 * command line.
 */
async function auditPasswordChange(input: {
  path: string;
  returned: unknown;
  request: Request;
  body: unknown;
}): Promise<void> {
  if (input.path !== CHANGE_PASSWORD_PATH) {
    return;
  }
  const changed = changedPasswordUser(input.returned);
  if (!changed) {
    return;
  }
  const body = input.body as { revokeOtherSessions?: unknown } | null | undefined;
  await auditPasswordEvent(
    providerDb,
    PASSWORD_AUDIT_ACTIONS.changed,
    changed,
    ipOfRequest(input.request),
    { otherSessionsEnded: body?.revokeOtherSessions === true },
  );
}

/** Every `hooks.after` of the installation: only HTTP requests are audited here. */
const afterAuthRequest = createAuthMiddleware(async (ctx) => {
  const request = ctx.request;
  if (!request) {
    return;
  }
  const returned = ctx.context.returned;
  await auditInvitationAnswer({
    path: ctx.path,
    returned,
    request,
    invitee: ctx.context.session?.user,
  });
  await auditPasswordChange({ path: ctx.path, returned, request, body: ctx.body });
});

const betterAuthInstance = betterAuth({
  appName: config.productName,
  baseURL: config.publicUrl,
  basePath: "/api/auth",
  secret: config.betterAuthSecret,
  database: drizzleAdapter(db, { provider: "pg" }),
  // A failed query's error carries its bound parameters (session tokens,
  // verification values); this logger writes the driver error instead.
  logger: authLogger,
  // The counters go to the `rate_limit` table: a restart (or a crash forced by
  // an attacker) must not hand out a fresh set of password and TOTP attempts.
  //
  // In demo mode, better-auth's own per-endpoint rate limiting (customRules)
  // never actually runs: it keys every bucket on the request's resolved IP,
  // and `advanced.ipAddress.disableIpTracking` below (required for finding 2)
  // makes better-auth treat the IP as unresolved for every request, which its
  // limiter takes as "cannot enforce a limit" and skips entirely — for every
  // endpoint, not only sign-in (security review finding M1). The demo guard
  // (middleware/demo-guard.ts) is what actually rate-limits every write a
  // public visitor can reach, sign-in included, with its own in-memory,
  // per-IP-per-route budget (`lib/demo.ts` `DEMO_ALLOWED_ROUTES`), so
  // `AUTH_RATE_LIMIT.customRules` here is left exactly as it is for a normal
  // installation: it still protects `/sign-in/email` and the others whenever
  // demo mode is off.
  rateLimit: {
    ...AUTH_RATE_LIMIT,
    storage: "database",
  },
  // Demo mode (security review finding 2, DSGVO): every visitor shares the
  // one demo account, so a stored IP address would be visible to every other
  // visitor through the audit log and session list; disableIpTracking stops
  // better-auth's own internal IP use (rate limiting, session rows) too, not
  // just what Restow itself writes (lib/request.ts `clientIpOf`). Because it
  // makes better-auth treat every request as IP-less, a `trustedProxies`
  // entry here would never be consulted (see the rate-limit comment above),
  // so none is configured.
  //
  // Otherwise better-auth resolves the client the way lib/request.ts
  // `clientIpOf` does: the right-most `X-Forwarded-For` hop that is not one of
  // the edge's trusted proxies (RESTOW_EDGE_TRUSTED_PROXIES, lib/forwarded.ts).
  // Without the list it would refuse every multi-hop header and count all
  // such sign-ins in one shared bucket.
  advanced: config.demo.enabled
    ? {
        ipAddress: {
          disableIpTracking: true,
        },
      }
    : {
        ipAddress: {
          trustedProxies: config.trustedProxies.filter(
            (entry) => !trustedProxies().invalid.includes(entry),
          ),
        },
      },
  user: {
    additionalFields: ENTRA_IDENTITY_USER_FIELDS,
  },
  hooks: {
    before: guardAuthSurface,
    after: afterAuthRequest,
  },
  // Emergency-only local password path. The twoFactor plugin challenges an
  // account for its TOTP code once one is enrolled; enrolment is mandatory for
  // every account with a password. The server enforces it (a password-only
  // session may enrol and nothing else, see sessionAssurancePlugin), and the web
  // shell sends such an account to the authenticator setup before anything else
  // (apps/web lib/second-factor.ts).
  // No open sign-up: operator accounts are created by the setup wizard and by
  // provider admins (admin plugin `createUser`), never by an anonymous visitor.
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    requireEmailVerification: false,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    // better-auth defaults to 128 and, since 1.7.6, also refuses a longer password
    // on sign-in and the other password endpoints before it is checked. Restow
    // accepts up to MAX_PASSWORD_LENGTH (setup wizard, admin recovery), so the
    // same limit is set here: a 129-256 character password keeps working.
    maxPasswordLength: MAX_PASSWORD_LENGTH,
    // "Forgot your password?" by mail (lib/password-reset.ts): only for an
    // account with a password and an authenticator app, so the mail never
    // replaces the second factor. The mail goes out in the background: the
    // answer looks and takes the same whether the address has an account.
    resetPasswordTokenExpiresIn: PASSWORD_RESET_TOKEN_TTL_SECONDS,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user: person, token }, request) => {
      void sendPasswordResetMail(db, {
        userId: person.id,
        token,
        language: languageOfRequest(request),
      });
    },
    onPasswordReset: async ({ user: person }, request) => {
      await auditPasswordEvent(
        providerDb,
        PASSWORD_AUDIT_ACTIONS.reset,
        person,
        ipOfRequest(request),
      );
    },
  },
  plugins: [
    passkey({
      rpID: relyingPartyId(config.publicUrl),
      rpName: config.productName,
      origin: config.publicUrl ?? null,
      authenticatorSelection: {
        userVerification: "required",
        residentKey: "preferred",
        requireResidentKey: false,
      },
    }),
    organization({
      // Tenants are created only through the provider API (features/tenants),
      // never by a signed-in user from the client.
      allowUserToCreateOrganization: false,
      creatorRole: "owner",
      membershipLimit: MEMBERSHIP_LIMIT,
      invitationExpiresIn: INVITATION_TTL_SECONDS,
    }),
    // The `admin` role and `createUser` for the setup wizard. Its HTTP endpoints,
    // impersonation included, are closed (lib/auth-surface.ts): an admin acts
    // for another person only through the audited restore flow.
    admin(),
    // The issuer names this installation in the authenticator app, so an
    // operator with several Restow installations can tell their codes apart.
    twoFactor({ issuer: totpIssuer(config.publicUrl) }),
    // A new phone gets its key before the old one stops working (lib/authenticator-replace.ts).
    authenticatorReplacePlugin({ issuer: totpIssuer(config.publicUrl) }),
    // Enforces the TOTP duty on the server: records how each session was
    // established, confines a password-only session to TOTP enrolment and keeps
    // the last provider admin (lib/auth-hooks.ts, lib/session-assurance.ts).
    sessionAssurancePlugin(),
    // Plugins of the Business/Service Provider modules (extensions.ts,
    // registered by ee.ts before this module is evaluated). Typed as an empty
    // tuple so the inferred `auth.api` keeps the core plugins' endpoints.
    ...(authPlugins() as []),
  ],
});

/**
 * better-auth answers a failure inside an endpoint with a 500 and logs it
 * through `authLogger`. A failure before the endpoint runs escapes its handler
 * instead, and the rate-limit check, which reads and writes `rate_limit`, is the
 * first to meet a database outage. Such a request gets the same answer: a 500,
 * with the driver error logged and neither query text nor bound values. (None
 * of the configured plugins rejects a request that early on purpose.)
 */
async function handleAuthRequest(request: Request): Promise<Response> {
  try {
    return await betterAuthInstance.handler(request);
  } catch (error) {
    writeAuthLog("error", "INTERNAL_SERVER_ERROR", error);
    return new Response(null, { status: 500, statusText: "Internal Server Error" });
  }
}

export const auth: typeof betterAuthInstance = {
  ...betterAuthInstance,
  handler: handleAuthRequest,
  fetch: handleAuthRequest,
};

export type Auth = typeof auth;

/** The `{ session, user }` pair better-auth resolves for a request. */
export type AuthSession = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;
export type SessionUser = AuthSession["user"];
