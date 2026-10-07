import { type Database, account, settings, user } from "@restow/db";
import { type SupportedLanguage, createI18n } from "@restow/i18n";
import { and, eq } from "drizzle-orm";
import { config } from "../config.js";
import { createInstallationNotifier } from "../features/settings/service.js";
import { audit } from "./audit.js";
import { writeAuthLog } from "./auth-logger.js";
import { preferredLanguage } from "./language.js";
import { clientIpOf } from "./request.js";

/**
 * "Forgot your password?" by mail (better-auth `requestPasswordReset` and
 * `resetPassword`, configured in auth.ts).
 *
 * The mail replaces the password, never the second factor: only an account
 * that has a password AND an authenticator app gets a link, so whoever reads
 * the mailbox still needs the code of the app to sign in. An account without
 * an authenticator app (or a passkey-only one, or one that never chose a
 * password) gets nothing; an owner resets it under Installation › Members, or
 * the owner themselves with `restow admin recover` on the server.
 *
 * The answer to the request never says whether the address belongs to an
 * account (better-auth answers the same either way), and the mail goes out in
 * the background, so the response time does not tell either. The request is
 * rate-limited per IP (lib/auth-surface.ts) and each account gets at most one
 * mail per {@link RESET_MAIL_INTERVAL_MS}, so nobody floods an inbox.
 *
 * The link points at the public URL of the installation (the one in
 * Installation › Server, else RESTOW_PUBLIC_URL); without one, or without a
 * notification mail transport, or in the public demo, the login page explains
 * the other ways back in instead of offering the form.
 */

/** How long a link stays usable. */
export const PASSWORD_RESET_TOKEN_TTL_SECONDS = 30 * 60;

/** At most one reset mail per account in this interval. */
export const RESET_MAIL_INTERVAL_MS = 5 * 60 * 1000;

/** The web page that takes the token (apps/web routes/reset-password.tsx). */
export const PASSWORD_RESET_WEB_PATH = "/reset-password";

export const PASSWORD_AUDIT_ACTIONS = {
  reset: "account.password_reset",
  changed: "account.password_changed",
} as const;

/** better-auth's endpoint for changing one's own password (Account › Sign-in security). */
export const CHANGE_PASSWORD_PATH = "/change-password";

/** The account whose password `/change-password` changed, from what it returned; null on failure. */
export function changedPasswordUser(returned: unknown): { id: string; email: string } | null {
  if (typeof returned !== "object" || returned === null || !("user" in returned)) {
    return null;
  }
  const changed = (returned as { user: unknown }).user;
  if (typeof changed !== "object" || changed === null) {
    return null;
  }
  const { id, email } = changed as { id?: unknown; email?: unknown };
  return typeof id === "string" && typeof email === "string" ? { id, email } : null;
}

/** Whether the installation offers the reset by mail at all. */
export function passwordResetAvailable(input: {
  configured: boolean;
  demo: boolean;
  mailConfigured: boolean;
  publicUrl: string | null;
}): boolean {
  return input.configured && !input.demo && input.mailConfigured && Boolean(input.publicUrl);
}

/** Whether an account may be sent a link: password plus authenticator app, not disabled. */
export function mayResetByMail(person: {
  hasPassword: boolean;
  twoFactorEnabled: boolean | null;
  banned: boolean | null;
}): boolean {
  return person.hasPassword && person.twoFactorEnabled === true && person.banned !== true;
}

/** The installation's public URL: the one saved in the web interface, else the environment's. */
export function effectivePublicUrl(saved: string | null | undefined): string | null {
  return saved ?? config.publicUrl ?? null;
}

/** The absolute link in the mail. */
export function passwordResetUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}${PASSWORD_RESET_WEB_PATH}?token=${encodeURIComponent(token)}`;
}

/** At most one mail per account and interval; in memory (one api process). */
export class ResetMailThrottle {
  private readonly last = new Map<string, number>();

  constructor(private readonly intervalMs: number = RESET_MAIL_INTERVAL_MS) {}

  /** True (and remembered) when a mail to `userId` may go out at `now`. */
  allow(userId: string, now: number): boolean {
    const previous = this.last.get(userId);
    if (previous !== undefined && now - previous < this.intervalMs) {
      return false;
    }
    this.last.set(userId, now);
    if (this.last.size > 10_000) {
      for (const [key, at] of this.last) {
        if (now - at >= this.intervalMs) {
          this.last.delete(key);
        }
      }
    }
    return true;
  }
}

const throttle = new ResetMailThrottle();

export type ResetMailOutcome = "sent" | "skipped" | "failed";

/** The installation's public URL: the one saved in the web interface, else the environment's. */
async function publicBase(db: Database): Promise<string | null> {
  const [row] = await db.select({ publicUrl: settings.publicUrl }).from(settings).limit(1);
  return effectivePublicUrl(row?.publicUrl);
}

/**
 * Send the reset link to `userId`, when everything above allows it. Never
 * throws: the caller has already answered the request.
 */
export async function sendPasswordResetMail(
  db: Database,
  input: { userId: string; token: string; language: SupportedLanguage },
  now: number = Date.now(),
): Promise<ResetMailOutcome> {
  try {
    if (config.demo.enabled) {
      return "skipped";
    }
    const [person] = await db
      .select({
        email: user.email,
        banned: user.banned,
        twoFactorEnabled: user.twoFactorEnabled,
      })
      .from(user)
      .where(eq(user.id, input.userId))
      .limit(1);
    if (!person) {
      return "skipped";
    }
    const [credential] = await db
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.userId, input.userId), eq(account.providerId, "credential")))
      .limit(1);
    if (!mayResetByMail({ ...person, hasPassword: credential !== undefined })) {
      return "skipped";
    }
    const base = await publicBase(db);
    if (!base) {
      return "skipped";
    }
    if (!throttle.allow(input.userId, now)) {
      return "skipped";
    }
    const notifier = await createInstallationNotifier(db);
    if (!notifier) {
      return "skipped";
    }
    const i18n = createI18n({ lng: input.language });
    const minutes = Math.round(PASSWORD_RESET_TOKEN_TTL_SECONDS / 60);
    const result = await notifier.send({
      to: person.email,
      subject: String(i18n.t("auth:passwordReset.mail.subject")),
      text: String(
        i18n.t("auth:passwordReset.mail.body", {
          url: passwordResetUrl(base, input.token),
          minutes,
        }),
      ),
    });
    return result.ok ? "sent" : "failed";
  } catch (error) {
    writeAuthLog("error", "PASSWORD_RESET_MAIL_FAILED", error);
    return "failed";
  }
}

/** The language of the person asking, from their browser's request. */
export function languageOfRequest(request: Request | undefined): SupportedLanguage {
  return preferredLanguage(request?.headers.get("accept-language"));
}

/** The client IP of a better-auth request (as the audit log records it). */
export function ipOfRequest(request: Request | undefined): string | null {
  return request ? (clientIpOf((name) => request.headers.get(name) ?? undefined) ?? null) : null;
}

/** Write a password change or reset of `person` to the installation audit chain. */
export async function auditPasswordEvent(
  db: Database,
  action: (typeof PASSWORD_AUDIT_ACTIONS)[keyof typeof PASSWORD_AUDIT_ACTIONS],
  person: { id: string; email: string },
  ip: string | null,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await audit(db, {
      tenantId: null,
      actor: person.email,
      actorUserId: person.id,
      action,
      target: person.id,
      targetType: "user",
      ip,
      ...(details ? { details } : {}),
    });
  } catch (error) {
    writeAuthLog("error", "PASSWORD_AUDIT_FAILED", error);
  }
}
