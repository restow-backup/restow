import { passkey, user } from "@restow/db";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { eq, like } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db.js";
import { PROVIDER_ADMIN_USER_ROLE } from "../middleware/rbac.js";
import { isConfiguredDemoAccountEmail, isDemoAccountEmail } from "./demo.js";
import {
  type SessionAssurance,
  authMethodForNewSession,
  isPathAllowed,
  isSignInPath,
  providerAdminRevocationTarget,
  sessionAssurance,
  wouldRemoveLastProviderAdmin,
} from "./session-assurance.js";

/**
 * The rules of ./session-assurance.ts as a better-auth plugin, in front of
 * every `/api/auth/*` endpoint and every `auth.api.*` call (the Restow routes
 * apply the same rules in middleware/session.ts):
 *
 *   - each new session is stamped with how it was established (`authMethod`);
 *   - a password-only session can enroll TOTP and nothing else, so a leaked
 *     password neither reaches the product nor registers a passkey;
 *   - an account with a passkey but no authenticator app cannot sign in with
 *     its password at all (enrolling TOTP on it would hand the account to
 *     whoever holds the password);
 *   - the last active provider admin cannot be demoted, banned or removed;
 *   - the one exception: the demo account (config.ts `RESTOW_DEMO_EMAIL`)
 *     while demo mode is on signs in with its password alone, no TOTP
 *     challenge or enrolment (lib/demo.ts, deploy/demo/README.md). Every
 *     other account is unaffected, demo mode or not.
 *
 * Plugin hooks run after the installation's own `hooks.before`, so the
 * closed endpoints of lib/auth-surface.ts answer 404 before anything here.
 */

/** Error codes the web client maps to messages (namespace `auth`). */
export const AUTH_ERROR_CODES = {
  totpEnrollmentRequired: "TOTP_ENROLLMENT_REQUIRED",
  signInAgain: "SIGN_IN_AGAIN",
  passkeySignInRequired: "PASSKEY_SIGN_IN_REQUIRED",
  lastProviderAdmin: "LAST_PROVIDER_ADMIN",
  demoAccountDisabled: "DEMO_ACCOUNT_DISABLED",
} as const;

function restrictedSessionError(assurance: Exclude<SessionAssurance, "full">): APIError {
  return assurance === "totp_enrollment"
    ? new APIError("FORBIDDEN", {
        code: AUTH_ERROR_CODES.totpEnrollmentRequired,
        message: "Set up an authenticator app first; a password alone only allows that.",
      })
    : new APIError("UNAUTHORIZED", {
        code: AUTH_ERROR_CODES.signInAgain,
        message: "This session is no longer valid. Sign in again.",
      });
}

/** What `databaseHooks.session.create.before` receives as its second argument. */
interface SessionCreationContext {
  path?: string;
  context?: { session?: { session?: Record<string, unknown> } | null };
}

/**
 * Record how a new session was established. A replacement session (password
 * change, TOTP disable) keeps the method of the one it replaces.
 */
export function stampAuthMethod<T extends Record<string, unknown>>(
  session: T,
  context: SessionCreationContext | null | undefined,
): T & { authMethod: string | null } {
  const own = session.authMethod;
  const current = context?.context?.session?.session?.authMethod;
  const inherited = typeof own === "string" ? own : typeof current === "string" ? current : null;
  return { ...session, authMethod: authMethodForNewSession(context?.path, inherited) };
}

async function refuseLastProviderAdminRevocation(path: string, body: unknown): Promise<void> {
  const targetId = providerAdminRevocationTarget(path, body);
  if (!targetId) {
    return;
  }
  const admins = await db
    .select({ id: user.id, role: user.role, banned: user.banned })
    .from(user)
    .where(like(user.role, `%${PROVIDER_ADMIN_USER_ROLE}%`));
  if (wouldRemoveLastProviderAdmin(targetId, admins)) {
    throw new APIError("FORBIDDEN", {
      code: AUTH_ERROR_CODES.lastProviderAdmin,
      message:
        "This is the last active provider administrator. Make another account a provider administrator first.",
    });
  }
}

/** Before every endpoint: the session gate, then the last-admin guard. */
const guardSessionAssurance = createAuthMiddleware(async (ctx) => {
  if (!isSignInPath(ctx.path)) {
    const current = await getSessionFromCtx(ctx);
    if (current) {
      const assurance = sessionAssurance(
        { authMethod: current.session.authMethod },
        { twoFactorEnabled: current.user.twoFactorEnabled },
        { demoPasswordBypass: isDemoAccountEmail(current.user.email, config.demo) },
      );
      if (assurance === "reauthenticate") {
        // Discard it, so `/get-session` answers "signed out" and the client
        // lands on the sign-in page instead of looping.
        await ctx.context.internalAdapter.deleteSession(current.session.token);
        ctx.context.session = null;
      }
      if (assurance !== "full" && !isPathAllowed(assurance, ctx.path)) {
        throw restrictedSessionError(assurance);
      }
    }
  }
  await refuseLastProviderAdminRevocation(ctx.path, ctx.body);
});

async function hasPasskey(userId: string): Promise<boolean> {
  const [registered] = await db
    .select({ id: passkey.id })
    .from(passkey)
    .where(eq(passkey.userId, userId))
    .limit(1);
  return registered !== undefined;
}

/** After a password sign-in: refuse it for an account whose second factor is a passkey only. */
const refusePasswordForPasskeyAccount = createAuthMiddleware(async (ctx) => {
  // No new session means the TOTP challenge is pending or the sign-in failed.
  const created = ctx.context.newSession;
  if (!created || created.user.twoFactorEnabled === true || !(await hasPasskey(created.user.id))) {
    return;
  }
  await ctx.context.internalAdapter.deleteSession(created.session.token);
  ctx.context.setNewSession(null);
  deleteSessionCookie(ctx);
  throw new APIError("FORBIDDEN", {
    code: AUTH_ERROR_CODES.passkeySignInRequired,
    message:
      "This account signs in with its passkey. The password path needs an authenticator app, which this account has not set up.",
  });
});

/**
 * After a password sign-in: refuse it for the *configured* demo account
 * while demo mode is off (security review finding 5). server.ts already
 * refuses to start in that configuration (config.ts `demoConfigConflict`);
 * this is the second, independent line of defence in case the process was
 * already running when the environment changed underneath it.
 */
const refuseDemoAccountWhenDisabled = createAuthMiddleware(async (ctx) => {
  const created = ctx.context.newSession;
  if (
    config.demo.enabled ||
    !created ||
    !isConfiguredDemoAccountEmail(created.user.email, config.demo.email)
  ) {
    return;
  }
  await ctx.context.internalAdapter.deleteSession(created.session.token);
  ctx.context.setNewSession(null);
  deleteSessionCookie(ctx);
  throw new APIError("FORBIDDEN", {
    code: AUTH_ERROR_CODES.demoAccountDisabled,
    message: "This account only signs in while public demo mode is on.",
  });
});

/** The plugin; add it to `plugins` in auth.ts. */
export function sessionAssurancePlugin() {
  return {
    id: "restow-session-assurance",
    schema: {
      session: {
        fields: {
          authMethod: { type: "string", required: false, input: false },
        },
      },
    },
    init() {
      return {
        options: {
          databaseHooks: {
            session: {
              create: {
                before: async (session: Record<string, unknown>, context: unknown) => ({
                  data: stampAuthMethod(session, context as SessionCreationContext | null),
                }),
              },
            },
          },
        },
      };
    },
    hooks: {
      before: [{ matcher: () => true, handler: guardSessionAssurance }],
      after: [
        {
          matcher: (context: { path?: string }) => context.path === "/sign-in/email",
          handler: refusePasswordForPasskeyAccount,
        },
        {
          matcher: (context: { path?: string }) => context.path === "/sign-in/email",
          handler: refuseDemoAccountWhenDisabled,
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
