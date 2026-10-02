import { type MailConfig, type NewSettings, type Settings, providers, settings } from "@restow/db";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { auth } from "../auth.js";
import { type Config, config, missingRequiredConfig } from "../config.js";
import { db, providerDb } from "../db.js";
import { signInProvider } from "../extensions.js";
import { resolveEntraApp } from "../features/sources/entra.js";
import { ensureOwnOrganisation } from "../features/tenants/internal.js";
import { AUDIT_ACTIONS, audit } from "../lib/audit.js";
import { demoSeedTokenMatches, isConfiguredDemoCredentials } from "../lib/demo.js";
import {
  DISCLAIMER_VERSION,
  type DisclaimerState,
  acceptDisclaimer,
  disclaimerRequired,
  disclaimerState,
  versionMismatch,
} from "../lib/disclaimer.js";
import { claimFirstAdmin } from "../lib/first-admin.js";
import { requestLanguage } from "../lib/language.js";
import { clientIp, observedOrigin } from "../lib/request.js";
import { upsertProviderSecret } from "../lib/secrets.js";
import {
  SETUP_TOKEN_HEADER,
  type SetupTokenSource,
  currentSetupToken,
  retireSetupToken,
  setupTokenAnnouncement,
  setupTokenMatches,
  setupTokenProblem,
} from "../lib/setup-token.js";
import type { DbExecutor } from "../lib/tenant-context.js";
import { DEMO_READ_ONLY_PROBLEM } from "../middleware/demo-guard.js";
import { requireSameOrigin } from "../middleware/session.js";
import { createNotifier } from "../notify.js";
import { type PasskeyReadyResult, computePasskeyReady } from "../passkeyReady.js";
import { ProblemError } from "../problem.js";
import {
  type MailSetup,
  type SetupRequest,
  acceptDisclaimerSchema,
  parseOrProblem,
  readJsonBody,
  setupRequestSchema,
  toStoredSmtpSecurity,
} from "../schemas.js";

/**
 * Installation setup (docs/ARCHITECTURE.md, Setup and operating modes).
 *
 * These routes are public: they run before any operator account exists. Setup
 * creates the first provider admin (admin plugin role `admin`), writes the
 * single `settings` row and the `providers` row and stores the SMTP password in
 * the encrypted secret store, all in one transaction that also sets
 * `settings.setup_completed_at`. Setups are serialized by an advisory lock.
 * The operator's own organisation, a tenant of kind `internal` named after the
 * operator and in the language the wizard's first step chose (`language`), is
 * created right after that transaction committed (a failure there leaves the
 * setup complete; the dashboard offers to create it). The mail transport is
 * optional: without one `settings.mail_transport` stays null and the operator
 * sets it up later in Settings.
 *
 * Once `setup_completed_at` is set the wizard is closed for good and `POST`
 * answers 409, whatever later happens to accounts or roles: a lost admin is
 * recovered on the server's command line (`restow admin recover`, cli/main.ts),
 * never through this public route. A failed setup leaves nothing behind, so
 * there is no half-configured state for an anonymous caller to finish.
 *
 * Who may set up: whoever holds the setup token (lib/setup-token.ts), which
 * only someone with access to the server can read. The wizard's first step
 * checks it (`POST /token`) and `POST /` requires it again, so knowing the
 * address of a fresh installation is not enough to take it over. Every
 * state-changing call is also refused from another site and with a body that
 * is not JSON (middleware/session.ts `requireSameOrigin`), like the routes
 * behind a session. In demo mode the seed process sets up with its own seed
 * token instead (lib/demo.ts); nobody else reaches these routes there.
 *
 * The operator responsibility notice (lib/disclaimer.ts) is accepted in the
 * wizard and sent with `POST /`, which refuses with 428 without it and records
 * it in the setup transaction with the new administrator as the one who
 * accepted. The wizard's calls are `GET /state` (public, read-only),
 * `POST /token` and `POST /`, so this is the whole gate.
 */

export const setup = new Hono();

// Changes only from the web app itself, and only as JSON (GET /state passes).
setup.use("*", requireSameOrigin);

/**
 * Advisory lock that serializes concurrent setup requests, keyed the same way
 * as the other installation-wide locks (`hashtext('restow.<name>')`).
 * Transaction-scoped and never persisted, so the key can change between
 * versions without leaving anything behind.
 */
const SETUP_ADVISORY_LOCK_NAME = "restow.setup";

interface SetupStateResponse {
  configured: boolean;
  /**
   * The product name to show (`RESTOW_PRODUCT_NAME`, the branding). The web app
   * reads it before anything else renders, so its texts name the same product
   * as the mails and reports the api renders.
   */
  productName: string;
  operatingMode: "local" | "public" | null;
  publicUrl: string | null;
  passkeyReady: PasskeyReadyResult;
  mailTransport: "smtp" | "graph" | null;
  /**
   * The operator responsibility notice: the current version and whether it is
   * accepted. The wizard starts with it; a configured installation that has
   * not accepted it yet shows it to its provider admin after sign-in.
   */
  disclaimer: DisclaimerState;
  /**
   * Whether the wizard must ask for the setup token, and where the operator
   * finds it: in the api log, or in `RESTOW_SETUP_TOKEN`. Not required once
   * configured, nor in demo mode (the seed sets up with its own token).
   */
  setupToken: { required: boolean; source: SetupTokenSource | null };
  /** Sign-in with Microsoft (Entra SSO) is offered on the login page. */
  microsoftSignIn: boolean;
  /**
   * Public demo mode (RESTOW_DEMO). `email`/`password` are the demo account's
   * credentials, intentionally public: the login page prefills them and adds
   * a one-click sign-in (deploy/demo/README.md). Null when demo mode is off,
   * or when the operator left a variable unset.
   */
  demo: { enabled: boolean; email: string | null; password: string | null };
}

interface SetupResultResponse {
  ok: true;
  passkeyReady: PasskeyReadyResult;
  /** False when setup continued with the admin an unfinished earlier setup created. */
  adminCreated: boolean;
  /** The response carries a session cookie for the new admin when true. */
  signedIn: boolean;
  /**
   * The operator's own organisation, created from the name given. `created` is
   * false when it could not be created: the setup is complete all the same, and
   * the dashboard offers to create it (or to mark an existing tenant as it).
   */
  ownOrganisation: { created: boolean };
  testSend: { attempted: boolean; ok: boolean; error?: string };
}

async function loadSettings(): Promise<Settings | null> {
  const rows = await db.select().from(settings).limit(1);
  return rows[0] ?? null;
}

/** Configured = the setup transaction committed; a one-way mark, never derived from accounts. */
export function isConfigured(row: Pick<Settings, "setupCompletedAt"> | null): boolean {
  return row?.setupCompletedAt != null;
}

function alreadyConfigured(): ProblemError {
  return new ProblemError(409, "Already configured", {
    type: "urn:restow:problem:already-configured",
    detail: "The installation is already set up. Change settings from the admin UI.",
  });
}

/**
 * The setup token (lib/setup-token.ts), or in demo mode the seed's own token:
 * 403 without it. The demo guard already lets only the seed's
 * token-authenticated calls through; this checks again, in case it had a gap.
 */
function assertSetupToken(provided: string | undefined, seedToken: string | undefined): void {
  if (config.demo.enabled) {
    if (!demoSeedTokenMatches(seedToken, config.demo.seedToken)) {
      throw new ProblemError(403, "Demo installation is read-only", {
        type: DEMO_READ_ONLY_PROBLEM,
        detail: "This demo is set up by its own seed process only.",
      });
    }
    return;
  }
  if (!setupTokenMatches(provided, config.setupToken)) {
    throw setupTokenProblem();
  }
}

/**
 * The acceptance of the current notice from the setup request body: 428
 * without one (an unticked box included), 409 for another version.
 */
function requireAcceptance(body: unknown): { version: string } {
  const raw =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).disclaimer
      : undefined;
  const parsed = acceptDisclaimerSchema.safeParse(raw);
  if (!parsed.success) {
    throw disclaimerRequired();
  }
  if (parsed.data.version !== DISCLAIMER_VERSION) {
    throw versionMismatch();
  }
  return parsed.data;
}

/**
 * The notice as the public state reports it. Before the setup it is part of
 * the wizard (accepted with the setup request), so it always reads as not yet
 * accepted, whatever an earlier version stored anonymously; demo mode counts
 * as accepted. After the setup, the stored acceptance decides
 * (POST /api/v1/settings/disclaimer).
 */
function setupDisclaimerState(
  row: Pick<Settings, "disclaimerVersion"> | null,
  configured: boolean,
): DisclaimerState {
  if (!configured && !config.demo.enabled) {
    return { version: DISCLAIMER_VERSION, accepted: false };
  }
  return disclaimerState(row, config.demo);
}

/**
 * Write the setup token to the log (server.ts, at start) while no setup has
 * completed: the block with the token, or where to find it when
 * RESTOW_SETUP_TOKEN provides it. Nothing in demo mode.
 */
export async function announceSetupToken(log: (line: string) => void): Promise<void> {
  if (config.demo.enabled) {
    return;
  }
  try {
    if (isConfigured(await loadSettings())) {
      return;
    }
  } catch {
    // The database did not answer: say it anyway, a token nobody needs is harmless.
  }
  const state = currentSetupToken(config.setupToken);
  if (state) {
    for (const line of setupTokenAnnouncement(state, config.productName)) {
      log(line);
    }
  }
}

/** Only non-secret mail configuration is persisted; the password goes to the secret store. */
function toMailConfig(mail: MailSetup): MailConfig {
  if (mail.transport === "smtp") {
    return {
      transport: "smtp",
      host: mail.smtp.host,
      port: mail.smtp.port,
      security: toStoredSmtpSecurity(mail.smtp.security),
      from: mail.smtp.from,
      username: mail.smtp.username,
    };
  }
  return { transport: "graph", sender: mail.graph.sender };
}

/** A notifier configured from the submitted wizard values, not the environment. */
async function notifierFromSetup(mail: MailSetup) {
  const derived: Config =
    mail.transport === "smtp"
      ? {
          ...config,
          mailTransport: "smtp",
          smtp: {
            host: mail.smtp.host,
            port: mail.smtp.port,
            secure: toStoredSmtpSecurity(mail.smtp.security) === "implicit",
            security: toStoredSmtpSecurity(mail.smtp.security),
            username: mail.smtp.username,
            password: mail.smtp.password,
            from: mail.smtp.from,
          },
        }
      : {
          ...config,
          mailTransport: "graph",
          graphMailSender: mail.graph.sender,
          graphMailTenantId: mail.graph.tenantId ?? config.graphMailTenantId,
        };
  // Graph sendMail authenticates as the backup app registration.
  const resolution = mail.transport === "graph" ? await resolveEntraApp() : null;
  return createNotifier(
    derived,
    resolution?.status === "ready" ? resolution.app.credentials : null,
  );
}

/** The single operator row; created on first setup, name updated on re-runs. */
async function ensureProvider(tx: DbExecutor, name: string): Promise<void> {
  const [existing] = await tx.select({ id: providers.id }).from(providers).limit(1);
  if (existing) {
    await tx.update(providers).set({ name }).where(eq(providers.id, existing.id));
    return;
  }
  await tx.insert(providers).values({ name });
}

/**
 * What may be logged and audited about a failure: a problem's type and detail,
 * else the error's name and database code. Never its message, which for a
 * failed query carries the statement and its bound values.
 */
function failureReason(error: unknown): string {
  if (error instanceof ProblemError) {
    return error.detail ? `${error.type}: ${error.detail}` : error.type;
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? `${error.name} (${code})` : error.name;
  }
  return "unknown error";
}

/**
 * The step after the setup transaction committed: the operator's own
 * organisation, a tenant of kind `internal` named like the operator. The
 * installation is complete without it, so a failure here is logged and written
 * to the installation audit log, never turned into a failed setup: the
 * dashboard offers to create it afterwards. Running it again changes nothing
 * (features/tenants/internal.ts `ensureOwnOrganisation`).
 */
async function createOwnOrganisation(input: {
  name: string;
  language: SetupRequest["language"];
  admin: { userId: string; email: string };
  ip: string | null;
}): Promise<{ created: boolean }> {
  try {
    await ensureOwnOrganisation(
      db,
      providerDb,
      {
        name: input.name,
        alertEmail: input.admin.email,
        ...(input.language ? { language: input.language } : {}),
      },
      { id: input.admin.userId, email: input.admin.email, ip: input.ip, isProviderAdmin: true },
    );
    return { created: true };
  } catch (error) {
    const reason = failureReason(error);
    console.error(
      JSON.stringify({
        level: "error",
        component: "setup",
        message: "the own organisation could not be created after the setup",
        reason,
      }),
    );
    try {
      await audit(providerDb, {
        actor: input.admin.email,
        actorUserId: input.admin.userId,
        action: AUDIT_ACTIONS.setupInternalTenantFailed,
        target: input.admin.userId,
        targetType: "installation",
        ip: input.ip,
        details: { name: input.name, reason },
      });
    } catch (auditError) {
      console.error(
        JSON.stringify({
          level: "error",
          component: "setup",
          message: "the failure to create the own organisation could not be audited",
          reason: failureReason(auditError),
        }),
      );
    }
    return { created: false };
  }
}

/** Sign the new admin in and return the cookies to forward; null when it fails. */
async function signInCookies(
  requestHeaders: Headers,
  email: string,
  password: string,
): Promise<string[] | null> {
  try {
    const result = await auth.api.signInEmail({
      body: { email, password },
      headers: requestHeaders,
      returnHeaders: true,
    });
    const cookies = result.headers.getSetCookie();
    return cookies.length > 0 ? cookies : null;
  } catch {
    return null;
  }
}

// GET /api/v1/setup/state — current mode, public URL, passkey-ready gate and the
// sign-in methods the login page offers.
setup.get("/state", async (c) => {
  const row = await loadSettings();
  const passkeyReady = computePasskeyReady(
    { operatingMode: row?.operatingMode ?? null, publicUrl: row?.publicUrl ?? null },
    { observedOrigin: observedOrigin(c), allowLocalhost: config.nodeEnv !== "production" },
  );
  const configured = isConfigured(row);
  const tokenRequired = !configured && !config.demo.enabled;
  const body: SetupStateResponse = {
    configured,
    productName: config.productName,
    operatingMode: row?.operatingMode ?? null,
    publicUrl: row?.publicUrl ?? null,
    passkeyReady,
    mailTransport: row?.mailTransport ?? null,
    disclaimer: setupDisclaimerState(row, configured),
    setupToken: tokenRequired
      ? { required: true, source: currentSetupToken(config.setupToken)?.source ?? null }
      : { required: false, source: null },
    microsoftSignIn:
      (await signInProvider("microsoft")?.available({
        operatingMode: row?.operatingMode ?? null,
        publicUrl: row?.publicUrl ?? null,
      })) ?? false,
    // The credentials are public only while demo mode is actually on
    // (security review finding 5): a leftover RESTOW_DEMO_EMAIL/PASSWORD in
    // a real installation's environment must never be echoed to a visitor.
    demo: config.demo.enabled
      ? { enabled: true, email: config.demo.email ?? null, password: config.demo.password ?? null }
      : { enabled: false, email: null, password: null },
  };
  return c.json(body);
});

// POST /api/v1/setup/token — the wizard's first step: is this the setup token?
// 204 when it is, 403 when not; it changes nothing. `POST /` checks it again.
setup.post("/token", async (c) => {
  if (isConfigured(await loadSettings())) {
    throw alreadyConfigured();
  }
  assertSetupToken(c.req.header(SETUP_TOKEN_HEADER), c.req.header("x-restow-demo-seed-token"));
  return c.body(null, 204);
});

// POST /api/v1/setup — first-run installation; 409 once configured, 403 without
// the setup token, 428 until the operator responsibility notice is accepted.
setup.post("/", async (c) => {
  const existing = await loadSettings();
  if (isConfigured(existing)) {
    throw alreadyConfigured();
  }
  // Before anything else, server side: the wizard's UI order is no protection
  // against a client that skips its first steps.
  assertSetupToken(c.req.header(SETUP_TOKEN_HEADER), c.req.header("x-restow-demo-seed-token"));
  const body = await readJsonBody(c.req);
  const acceptance = config.demo.enabled ? null : requireAcceptance(body);
  // Checked before anything is written: without the master key the SMTP
  // password cannot be sealed, without the auth secret no session can be signed.
  const missing = missingRequiredConfig(config);
  if (missing.length > 0) {
    throw new ProblemError(503, "Server configuration incomplete", {
      type: "urn:restow:problem:configuration-incomplete",
      detail: `Set ${missing.join(", ")} in the server environment and restart before running the setup.`,
      extensions: { missing },
    });
  }
  const input = parseOrProblem(setupRequestSchema, body);
  // Demo mode (security review finding 1): setup is not on the demo guard's
  // public allowlist, so only the seed's token-authenticated call ever
  // reaches this route in normal operation — but that call must still be
  // unable to install anything other than the one documented demo account,
  // in case the token ever leaked or the guard had a gap of its own.
  if (config.demo.enabled && !isConfiguredDemoCredentials(input.firstAdmin, config.demo)) {
    throw new ProblemError(403, "Demo installation is read-only", {
      type: DEMO_READ_ONLY_PROBLEM,
      detail:
        "This demo installs only its own documented admin account; the email and password must " +
        "match RESTOW_DEMO_EMAIL/RESTOW_DEMO_PASSWORD.",
    });
  }
  if (input.operatingMode === "public" && !input.publicUrl) {
    throw new ProblemError(422, "Validation failed", {
      detail: "publicUrl is required in public operating mode.",
      extensions: { issues: [{ path: ["publicUrl"], message: "Required in public mode" }] },
    });
  }
  const publicUrl = input.publicUrl ? new URL(input.publicUrl).origin : null;

  const passkeyReady = computePasskeyReady(
    { operatingMode: input.operatingMode, publicUrl },
    { observedOrigin: observedOrigin(c), allowLocalhost: config.nodeEnv !== "production" },
  );

  const values: NewSettings = {
    singleton: true,
    operatingMode: input.operatingMode,
    publicUrl,
    passkeyReady: passkeyReady.ready,
    // Null while the operator skips the mail step: nothing sends mail until Settings has a transport.
    mailTransport: input.mail?.transport ?? null,
    mailConfig: input.mail ? toMailConfig(input.mail) : null,
    setupCompletedAt: new Date(),
  };

  // Everything in one transaction on the installation pool (the provider secret
  // and the installation audit chain carry no tenant, which Row Level Security
  // hides from the application role): the admin, the settings with their
  // completion mark, the provider row, the SMTP password and the audit entry.
  const ip = clientIp(c);
  const adminEmail = input.firstAdmin.email.trim().toLowerCase();
  const admin = await providerDb.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${SETUP_ADVISORY_LOCK_NAME}))`);
    const [current] = await tx
      .select({ setupCompletedAt: settings.setupCompletedAt })
      .from(settings)
      .limit(1);
    if (isConfigured(current ?? null)) {
      throw alreadyConfigured();
    }
    const claimed = await claimFirstAdmin(tx, input.firstAdmin);
    // The acceptance of the notice, by the administrator this setup creates
    // (security review L3): recorded before the completion, in the same chain.
    if (acceptance) {
      await acceptDisclaimer(tx, {
        version: acceptance.version,
        actor: { id: claimed.userId, email: adminEmail },
        ip,
        via: "setup",
        evenIfStored: true,
      });
    }
    await tx
      .insert(settings)
      .values(values)
      .onConflictDoUpdate({
        target: settings.singleton,
        set: {
          operatingMode: values.operatingMode,
          publicUrl: values.publicUrl,
          passkeyReady: values.passkeyReady,
          mailTransport: values.mailTransport,
          mailConfig: values.mailConfig,
          setupCompletedAt: values.setupCompletedAt,
        },
      });
    await ensureProvider(tx, input.providerName);
    if (input.mail?.transport === "smtp" && input.mail.smtp.password) {
      await upsertProviderSecret(tx, "smtp_password", input.mail.smtp.password);
    }
    await audit(tx, {
      actor: adminEmail,
      actorUserId: claimed.userId,
      action: AUDIT_ACTIONS.setupCompleted,
      target: claimed.userId,
      targetType: "user",
      ip,
      details: {
        operatingMode: input.operatingMode,
        publicUrl,
        mailTransport: input.mail?.transport ?? null,
        passkeyReady: passkeyReady.ready,
        adminCreated: claimed.created,
      },
    });
    return claimed;
  });
  // The setup is done: the token has served its purpose.
  retireSetupToken();

  // The operator's own organisation, now that the installation and its first admin exist.
  const ownOrganisation = await createOwnOrganisation({
    name: input.providerName,
    language: input.language,
    admin: { userId: admin.userId, email: adminEmail },
    ip,
  });

  const cookies = await signInCookies(
    c.req.raw.headers,
    input.firstAdmin.email.toLowerCase(),
    input.firstAdmin.password,
  );
  for (const cookie of cookies ?? []) {
    c.header("set-cookie", cookie, { append: true });
  }

  const result: SetupResultResponse = {
    ok: true,
    passkeyReady,
    adminCreated: admin.created,
    signedIn: cookies !== null,
    ownOrganisation,
    testSend: { attempted: false, ok: false },
  };

  // The schema refuses a test message without a transport; the check keeps the types honest.
  if (input.sendTest && input.mail) {
    const sent = await (await notifierFromSetup(input.mail)).sendTest(
      input.firstAdmin.email,
      input.language ?? requestLanguage(c),
    );
    result.testSend = { attempted: true, ok: sent.ok, error: sent.error };
  }

  return c.json(result, 201);
});
