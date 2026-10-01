import { timingSafeEqual } from "node:crypto";
import type { DemoConfig } from "../config.js";
import type { RateLimitWindow } from "./demo-rate-limit.js";

/**
 * Public demo mode (deploy/demo/README.md), pure decisions shared by the demo
 * guard (middleware/demo-guard.ts) and the TOTP bypass (lib/session-assurance.ts,
 * lib/auth-hooks.ts, middleware/session.ts). Nothing here reads configuration
 * or does I/O, so both call sites are exercised the same way in tests.
 *
 * Demo mode never changes behaviour unless `RESTOW_DEMO=true`
 * (config.ts): every function below answers `false`/"refuse" whenever
 * `enabled` is false, so a normal installation is provably unaffected.
 */

/** Methods that only read; the demo guard never refuses them. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export function isSafeDemoMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/**
 * The handful of mutations a public visitor may trigger: signing in and out,
 * switching between the two demo tenants, "Back up now", requesting a
 * (download-only, see routes/setup.ts and features/restore/service.ts)
 * restore, "Verify now", and preparing a ZIP download of files from a backed-up
 * machine's snapshot (the one read-only action of the endpoint pages that
 * needs a POST: the paths travel in the body, features/endpoints/routes.ts).
 * Every path is an exact match, except that a `:id` segment of a template
 * matches a UUID and nothing else (`pathMatchesTemplate`), so the check
 * below needs no general pattern matching. Everything else that could create,
 * change or delete anything is refused by default — restoring onto a machine,
 * requesting a restore test, enrolling and the agent API included.
 *
 * `POST /api/v1/setup` is deliberately NOT here (security review finding 1):
 * during the nightly reset window the installation is briefly unconfigured
 * while `web` is not yet published (deploy/demo/reset.sh starts it only
 * after the seed succeeds), but defence in depth still matters — an
 * unauthenticated `POST /setup` must never be able to claim the TOTP-exempt
 * demo account. Only the seed's own token-authenticated call reaches it now
 * (api-seed.ts passes `{ seed: true }`), and routes/setup.ts additionally
 * refuses any `firstAdmin` that does not match `RESTOW_DEMO_EMAIL`/
 * `RESTOW_DEMO_PASSWORD` while demo mode is on.
 *
 * Every route also carries its own per-visitor-IP `rateLimit` (enforced by
 * the guard, in memory only, lib/demo-rate-limit.ts), so a route cannot be
 * added to this allowlist without deciding one — security review finding M1:
 * better-auth's own rate limiter (auth.ts `rateLimit.customRules`) never
 * actually runs in demo mode, because `advanced.ipAddress.disableIpTracking`
 * (set for finding 2, so no visitor's IP is stored) also makes better-auth's
 * limiter return early and allow every request. `/sign-in/email` is the
 * route that matters most here: unlike the other five, each attempt runs a
 * scrypt hash on the api process and writes a session row, so it gets the
 * job triggers' own budget rather than the noticeably cheaper sign-out/
 * switch-tenant one.
 */
const JOB_TRIGGER_RATE_LIMIT: RateLimitWindow = { windowMs: 60_000, max: 10 };
const SIGN_IN_RATE_LIMIT: RateLimitWindow = { windowMs: 60_000, max: 30 };
const AUTH_ACTION_RATE_LIMIT: RateLimitWindow = { windowMs: 60_000, max: 60 };

export interface DemoAllowedRoute {
  method: string;
  /** An exact path, or a template whose `:id` segments each match one UUID. */
  path: string;
  rateLimit: RateLimitWindow;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `path` is `template`: the same segments, where a template segment
 * `:id` stands for exactly one UUID. Nothing else is a parameter, so a visitor
 * cannot widen an allowlisted route by choosing a clever segment.
 */
export function pathMatchesTemplate(template: string, path: string): boolean {
  const wanted = template.split("/");
  const actual = path.split("/");
  if (wanted.length !== actual.length) {
    return false;
  }
  return wanted.every((segment, index) =>
    segment === ":id" ? UUID.test(actual[index] ?? "") : segment === actual[index],
  );
}

export const DEMO_ALLOWED_ROUTES: ReadonlyArray<DemoAllowedRoute> = [
  { method: "POST", path: "/api/v1/jobs/backup", rateLimit: JOB_TRIGGER_RATE_LIMIT },
  { method: "POST", path: "/api/v1/restore", rateLimit: JOB_TRIGGER_RATE_LIMIT },
  { method: "POST", path: "/api/v1/verify", rateLimit: JOB_TRIGGER_RATE_LIMIT },
  { method: "POST", path: "/api/auth/sign-in/email", rateLimit: SIGN_IN_RATE_LIMIT },
  { method: "POST", path: "/api/auth/sign-out", rateLimit: AUTH_ACTION_RATE_LIMIT },
  {
    method: "POST",
    path: "/api/auth/organization/set-active",
    rateLimit: AUTH_ACTION_RATE_LIMIT,
  },
  // Step one of the ZIP download of files from an endpoint snapshot: it checks the
  // chosen paths and stores the selection; the download itself is a GET. Reading
  // backed-up files is what the demo is for; the server work per call is bounded by
  // the restic gate (features/endpoints/restic-gate.ts) and this budget.
  {
    method: "POST",
    path: "/api/v1/endpoints/:id/downloads",
    rateLimit: JOB_TRIGGER_RATE_LIMIT,
  },
];

function allowedRouteFor(method: string, path: string): DemoAllowedRoute | undefined {
  const upper = method.toUpperCase();
  return DEMO_ALLOWED_ROUTES.find(
    (route) => route.method === upper && pathMatchesTemplate(route.path, path),
  );
}

export function isDemoAllowedRoute(method: string, path: string): boolean {
  return allowedRouteFor(method, path) !== undefined;
}

/**
 * The per-visitor-IP budget for `method`/`path`, or `undefined` when the
 * route carries none (every write outside the allowlist above is refused
 * before the guard would ever reach this check, see middleware/demo-guard.ts).
 */
export function demoRateLimitWindowFor(method: string, path: string): RateLimitWindow | undefined {
  return allowedRouteFor(method, path)?.rateLimit;
}

/**
 * The budget of `method`/`path` together with the name it is counted under:
 * the route's own path (for a template, the template, not the concrete URL), so
 * a visitor cannot get a fresh budget by changing the id in the address.
 */
export function demoRateLimitFor(
  method: string,
  path: string,
): { key: string; window: RateLimitWindow } | undefined {
  const route = allowedRouteFor(method, path);
  return route ? { key: route.path, window: route.rateLimit } : undefined;
}

/**
 * Reads that must stay refused even in demo mode, because the shared demo
 * account makes them a cross-visitor privacy problem (security review
 * finding 2, DSGVO): better-auth's session listing and revocation endpoints
 * return every signed-in visitor's IP address, user agent and session token,
 * since every visitor shares the one demo account. Checked before the "every
 * read passes" rule, for any method (a visitor only ever GETs `list-sessions`
 * and POSTs the revoke endpoints, but this refuses both regardless).
 */
export const DEMO_DENIED_ROUTES: ReadonlySet<string> = new Set([
  "/api/auth/list-sessions",
  "/api/auth/revoke-session",
  "/api/auth/revoke-sessions",
  "/api/auth/revoke-other-sessions",
]);

export function isDemoDeniedRoute(path: string): boolean {
  return DEMO_DENIED_ROUTES.has(path);
}

/**
 * Constant-time comparison of the seed token header against the configured
 * one, so the deploy/demo seed process's bootstrap calls (creating the demo
 * tenants, sources and schedules) pass the same guard a visitor's request
 * does, without adding those routes to the public allowlist above. The token
 * is a shared secret between the seed process and the api container on the
 * demo's internal network (deploy/demo/README.md); a public visitor never
 * sees or can reach it.
 */
export function demoSeedTokenMatches(
  provided: string | undefined,
  configured: string | undefined,
): boolean {
  if (!configured || !provided || provided.length !== configured.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(provided), Buffer.from(configured));
}

export interface DemoRequestInput {
  method: string;
  /** The request path, without the query string. */
  path: string;
  /** The `X-Restow-Demo-Seed-Token` header, if any. */
  seedTokenHeader: string | undefined;
  configuredSeedToken: string | undefined;
}

/**
 * Whether a demo-mode request may proceed. `DEMO_DENIED_ROUTES` is checked
 * first and wins over everything else, including a valid seed token — the
 * seed has no reason to ever call them either. Otherwise reads pass; a write
 * needs either to be one of the fixed public actions or to carry the seed
 * process's own token. Called only when demo mode is enabled — callers
 * short-circuit otherwise (middleware/demo-guard.ts).
 */
export function demoRequestAllowed(input: DemoRequestInput): boolean {
  if (isDemoDeniedRoute(input.path)) {
    return false;
  }
  if (isSafeDemoMethod(input.method)) {
    return true;
  }
  if (demoSeedTokenMatches(input.seedTokenHeader, input.configuredSeedToken)) {
    return true;
  }
  return isDemoAllowedRoute(input.method, input.path);
}

/**
 * Whether `email` is the demo account: the one account the installation
 * exempts from TOTP enrolment while `demo.enabled` is true. Every other
 * account, including every other password account, is unaffected.
 */
export function isDemoAccountEmail(
  email: string | null | undefined,
  demo: Pick<DemoConfig, "enabled" | "email">,
): boolean {
  if (!demo.enabled || !demo.email || !email) {
    return false;
  }
  return email.trim().toLowerCase() === demo.email.trim().toLowerCase();
}

/**
 * Whether `email` matches the *configured* demo account email, regardless of
 * whether demo mode is currently on. Used only to refuse that one account a
 * password sign-in while demo mode is off (security review finding 5): a
 * leftover `RESTOW_DEMO_EMAIL` from a previous demo phase must never quietly
 * keep working as a TOTP-free account once `RESTOW_DEMO` is unset (the
 * server also refuses to start in that configuration, see config.ts
 * `demoConfigConflict` and server.ts).
 */
export function isConfiguredDemoAccountEmail(
  email: string | null | undefined,
  demoEmail: string | undefined,
): boolean {
  if (!demoEmail || !email) {
    return false;
  }
  return email.trim().toLowerCase() === demoEmail.trim().toLowerCase();
}

/**
 * Whether `email`/`password` are exactly the configured demo credentials.
 * Setup in demo mode refuses to create any other admin (security review
 * finding 1): even a caller that somehow holds the seed token cannot use it
 * to install an arbitrary account.
 */
export function isConfiguredDemoCredentials(
  input: { email: string; password: string },
  demo: Pick<DemoConfig, "email" | "password">,
): boolean {
  if (!demo.email || !demo.password) {
    return false;
  }
  return (
    input.email.trim().toLowerCase() === demo.email.trim().toLowerCase() &&
    input.password === demo.password
  );
}

// --- Restoring another visitor's text into a shared, public mailbox (finding 6) ---

/** Fixed values every demo restore uses; a visitor's own input is never stored or shown. */
export const DEMO_RESTORE_REASON = "Public demo restore";
export const DEMO_RESTORE_FOLDER_NAME = "Restored (Demo)";
export const DEMO_RESTORE_ARCHIVE_NAME = "demo-restore";

export interface RestoreInputForDemo {
  reason?: string;
  options?: { restoreFolderName?: string; archiveName?: string };
}

/**
 * Replace whatever a visitor typed into `reason`, `restoreFolderName` and
 * `archiveName` with fixed, server-chosen text. Every demo visitor shares
 * one mailbox and one audit log, so these free-text fields are otherwise a
 * way to publish arbitrary text to every other visitor (a restored folder
 * name is visible in the mailbox, `reason` is visible in the audit log).
 * Only fields the request actually set are replaced; fields left out stay
 * out, so the request's shape (and its own validation) is unaffected.
 */
export function sanitizeRestoreInputForDemo<T extends RestoreInputForDemo>(input: T): T {
  return {
    ...input,
    ...(input.reason !== undefined ? { reason: DEMO_RESTORE_REASON } : {}),
    ...(input.options
      ? {
          options: {
            ...input.options,
            ...(input.options.restoreFolderName !== undefined
              ? { restoreFolderName: DEMO_RESTORE_FOLDER_NAME }
              : {}),
            ...(input.options.archiveName !== undefined
              ? { archiveName: DEMO_RESTORE_ARCHIVE_NAME }
              : {}),
          },
        }
      : {}),
  };
}
