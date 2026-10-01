import { productName } from "@restow/i18n";
import type { MiddlewareHandler } from "hono";
import { config } from "../config.js";
import { demoRateLimitExceeded, rateLimitKeyOf } from "../lib/demo-rate-limit.js";
import { demoRateLimitFor, demoRequestAllowed } from "../lib/demo.js";
import { ProblemError } from "../problem.js";

/**
 * The demo-mode guard (deploy/demo/README.md): the one place that decides
 * whether a request may change anything while `RESTOW_DEMO=true`.
 *
 * Mounted once, globally, before every route (see app.ts) so it sees
 * `/api/auth/*` and every `/api/v1/*` feature alike: browsing, search,
 * downloads, exports and the audit log (all reads) always pass — except
 * better-auth's session list/revoke endpoints, refused outright even as a
 * GET, since every visitor shares the one demo account (security review
 * finding 2, `lib/demo.ts` `DEMO_DENIED_ROUTES`). So does the fixed set of
 * mutations the public demo offers ("Back up now", "Verify now", requesting
 * a restore as a download — never back into the mailbox, see
 * `features/restore/service.ts` — preparing a ZIP download of files from an
 * endpoint snapshot, signing in, signing out, switching tenants) and the seed
 * process's own calls, `POST /api/v1/setup` included only for those (security
 * review finding 1: it is deliberately NOT on the public allowlist below).
 * The seed token also opens `/agent/v1/*` and `/agent/restic/*` (the agent API
 * and the restic REST backend the seed's simulated machines write through):
 * those are writes like any other, so a visitor without the token is refused
 * there too, and nothing about them is on the allowlist. Every other write
 * — a new or changed source, an IMAP host, the Microsoft 365 app registration, storage
 * targets, mail transport and test mails, webhooks, API keys, extension
 * routes (the license key among them), users, members, invitations, tenants, settings, and the demo account's
 * own password, passkey or TOTP — is refused before it reaches the route.
 * Every route on that allowlist is additionally rate-limited per visitor IP
 * (security review findings 3 and M1 — better-auth's own rate limiter never
 * actually runs in demo mode, see `lib/demo.ts`); the concurrency and size
 * limits for backups, verifications and restores themselves live with each
 * feature's own service (`lib/demo-limits.ts`).
 *
 * A no-op when `RESTOW_DEMO` is unset (the default): production and
 * self-hosted installations run exactly as before (demo-guard.test.ts proves
 * it), and every decision itself lives in ./lib/demo.ts as a pure function so
 * it is tested without a server.
 */
export const DEMO_READ_ONLY_PROBLEM = "urn:restow:problem:demo-read-only";
export const DEMO_RATE_LIMITED_PROBLEM = "urn:restow:problem:demo-rate-limited";

function demoReadOnly(): ProblemError {
  return new ProblemError(403, "Demo installation is read-only", {
    type: DEMO_READ_ONLY_PROBLEM,
    detail: `This is a public demo of ${productName()}: it never changes the installation and never reaches anywhere outside this server. Browsing, search, downloads, exports, the audit log, “Back up now”, “Verify now” and restoring a snapshot as a download all work; changing sources, settings, users or credentials, or restoring back into the mailbox, does not.`,
  });
}

function demoRateLimited(): ProblemError {
  return new ProblemError(429, "Too many requests", {
    type: DEMO_RATE_LIMITED_PROBLEM,
    detail:
      "This demo limits how often one visitor can use this action. Wait a minute and try again.",
  });
}

export const demoGuard: MiddlewareHandler = async (c, next) => {
  if (!config.demo.enabled) {
    await next();
    return;
  }
  const path = new URL(c.req.url).pathname;
  const allowed = demoRequestAllowed({
    method: c.req.method,
    path,
    seedTokenHeader: c.req.header("x-restow-demo-seed-token"),
    configuredSeedToken: config.demo.seedToken,
  });
  if (!allowed) {
    throw demoReadOnly();
  }
  // Read only for this in-memory rate-limit key (lib/demo-rate-limit.ts); it
  // is never stored, unlike lib/request.ts `clientIp`, which stays null in
  // demo mode (security review findings 2 and 3). Every allowed route
  // carries its own budget (lib/demo.ts `DEMO_ALLOWED_ROUTES`), including
  // sign-in — better-auth's own limiter is inert in demo mode (finding M1).
  const budget = demoRateLimitFor(c.req.method, path);
  if (budget) {
    const key = `${rateLimitKeyOf((name) => c.req.header(name))}:${budget.key}`;
    if (demoRateLimitExceeded(key, budget.window)) {
      throw demoRateLimited();
    }
  }
  await next();
};
