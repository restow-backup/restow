import { createOTP } from "@better-auth/utils/otp";
import { createRandomStringGenerator } from "@better-auth/utils/random";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { z } from "zod";

/**
 * Moving the authenticator app to a new phone without a gap.
 *
 * better-auth keeps one TOTP key per account and issues a new one only after
 * the active one is switched off (`/two-factor/disable`, then `/two-factor/enable`).
 * Between those two calls the account has no second factor, and a closed
 * dialog or a lost tab leaves it like that. These two endpoints replace the key
 * the other way round:
 *
 *   POST /two-factor/replace          { password }  → { totpURI, backupCodes }
 *       checks the password and keeps a new key plus new recovery codes as a
 *       pending replacement (the `verification` table, ten minutes);
 *   POST /two-factor/replace/confirm  { code }      → { status: true }
 *       checks the first code from the new phone against the pending key and
 *       only then swaps key and recovery codes in the account's `twoFactor` row.
 *
 * Until the confirmation the old phone and the old recovery codes keep working;
 * an abandoned replacement simply expires. The key and the recovery codes are
 * stored the way the two-factor plugin stores them (encrypted with the auth
 * secret), so its sign-in verification reads them unchanged. Both paths fall
 * under the `/two-factor/*` rate limit (lib/auth-surface.ts).
 */

export const AUTHENTICATOR_REPLACE_PATHS = {
  start: "/two-factor/replace",
  confirm: "/two-factor/replace/confirm",
} as const;

export const AUTHENTICATOR_REPLACE_ERROR_CODES = {
  notEnabled: "TOTP_NOT_ENABLED",
  noPassword: "INVALID_PASSWORD",
  noPending: "TOTP_REPLACEMENT_EXPIRED",
  invalidCode: "INVALID_CODE",
} as const;

/** How long a started replacement waits for its first code. */
export const REPLACEMENT_TTL_MS = 10 * 60 * 1000;

/** The same shape the two-factor plugin issues: 10 codes, "abcde-12345". */
const BACKUP_CODE_COUNT = 10;
const backupCodeCharacters = createRandomStringGenerator("a-z", "0-9", "A-Z");
const secretCharacters = createRandomStringGenerator("a-z", "0-9", "A-Z", "-_");

export function newBackupCodes(): string[] {
  return Array.from({ length: BACKUP_CODE_COUNT }, () => {
    const code = backupCodeCharacters(10);
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

export function replacementIdentifier(userId: string): string {
  return `restow-totp-replace:${userId}`;
}

interface PendingReplacement {
  secret: string;
  backupCodes: string[];
}

function parsePending(value: string): PendingReplacement | null {
  try {
    const parsed = JSON.parse(value) as Partial<PendingReplacement>;
    if (
      typeof parsed.secret === "string" &&
      Array.isArray(parsed.backupCodes) &&
      parsed.backupCodes.every((code) => typeof code === "string")
    ) {
      return { secret: parsed.secret, backupCodes: parsed.backupCodes };
    }
  } catch {
    // Treated like no pending replacement.
  }
  return null;
}

interface TwoFactorRow {
  id: string;
  userId: string;
  verified?: boolean | null;
}

/** The plugin; add it to `plugins` in auth.ts after `twoFactor`. */
export function authenticatorReplacePlugin(options: { issuer: string }) {
  return {
    id: "restow-authenticator-replace",
    endpoints: {
      startAuthenticatorReplacement: createAuthEndpoint(
        AUTHENTICATOR_REPLACE_PATHS.start,
        {
          method: "POST",
          body: z.object({ password: z.string().min(1) }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const user = ctx.context.session.user as typeof ctx.context.session.user & {
            twoFactorEnabled?: boolean | null;
          };
          if (user.twoFactorEnabled !== true) {
            throw new APIError("BAD_REQUEST", {
              code: AUTHENTICATOR_REPLACE_ERROR_CODES.notEnabled,
              message: "There is no authenticator app to replace. Set one up instead.",
            });
          }
          const accounts = await ctx.context.internalAdapter.findAccounts(user.id);
          const credential = accounts.find(
            (candidate) => candidate.providerId === "credential" && candidate.password,
          );
          const valid =
            credential?.password !== undefined &&
            credential.password !== null &&
            (await ctx.context.password.verify({
              hash: credential.password,
              password: ctx.body.password,
            }));
          if (!valid) {
            throw new APIError("BAD_REQUEST", {
              code: AUTHENTICATOR_REPLACE_ERROR_CODES.noPassword,
              message: "Invalid password",
            });
          }

          const secret = secretCharacters(32);
          const backupCodes = newBackupCodes();
          const identifier = replacementIdentifier(user.id);
          await ctx.context.internalAdapter.deleteVerificationByIdentifier(identifier);
          await ctx.context.internalAdapter.createVerificationValue({
            identifier,
            value: await symmetricEncrypt({
              key: ctx.context.secretConfig,
              data: JSON.stringify({ secret, backupCodes } satisfies PendingReplacement),
            }),
            expiresAt: new Date(Date.now() + REPLACEMENT_TTL_MS),
          });
          const totpURI = createOTP(secret, { digits: 6, period: 30 }).url(
            options.issuer,
            user.email,
          );
          return ctx.json({ totpURI, backupCodes });
        },
      ),
      confirmAuthenticatorReplacement: createAuthEndpoint(
        AUTHENTICATOR_REPLACE_PATHS.confirm,
        {
          method: "POST",
          body: z.object({ code: z.string().min(1) }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const user = ctx.context.session.user;
          const identifier = replacementIdentifier(user.id);
          const stored = await ctx.context.internalAdapter.findVerificationValue(identifier);
          const pending =
            stored && stored.expiresAt > new Date()
              ? parsePending(
                  await symmetricDecrypt({ key: ctx.context.secretConfig, data: stored.value }),
                )
              : null;
          if (!pending) {
            throw new APIError("BAD_REQUEST", {
              code: AUTHENTICATOR_REPLACE_ERROR_CODES.noPending,
              message: "The replacement expired. Start again.",
            });
          }
          const ok = await createOTP(pending.secret, { digits: 6, period: 30 }).verify(
            ctx.body.code.replace(/\s+/g, ""),
          );
          if (!ok) {
            throw new APIError("UNAUTHORIZED", {
              code: AUTHENTICATOR_REPLACE_ERROR_CODES.invalidCode,
              message: "Invalid code",
            });
          }
          const current = await ctx.context.adapter.findOne<TwoFactorRow>({
            model: "twoFactor",
            where: [{ field: "userId", value: user.id }],
          });
          if (!current) {
            throw new APIError("BAD_REQUEST", {
              code: AUTHENTICATOR_REPLACE_ERROR_CODES.notEnabled,
              message: "There is no authenticator app to replace. Set one up instead.",
            });
          }
          await ctx.context.adapter.update({
            model: "twoFactor",
            where: [{ field: "id", value: current.id }],
            update: {
              secret: await symmetricEncrypt({
                key: ctx.context.secretConfig,
                data: pending.secret,
              }),
              backupCodes: await symmetricEncrypt({
                key: ctx.context.secretConfig,
                data: JSON.stringify(pending.backupCodes),
              }),
              verified: true,
            },
          });
          await ctx.context.internalAdapter.deleteVerificationByIdentifier(identifier);
          return ctx.json({ status: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
