import { type AppCredentials, parseSourceAppSecret } from "@restow/core";
import { type Settings, settings } from "@restow/db";
import type { SupportedLanguage } from "@restow/i18n";
import { eq } from "drizzle-orm";
import { type Config, config } from "../../config.js";
import { audit } from "../../lib/audit.js";
import { DISCLAIMER_VERSION } from "../../lib/disclaimer.js";
import {
  type SecretRef,
  deleteSecret,
  findProviderSecret,
  readSecret,
  upsertProviderSecret,
} from "../../lib/secrets.js";
import type { DbExecutor } from "../../lib/tenant-context.js";
import { parseServiceAccountKey } from "../../notify-google.js";
import { type Notifier, createNotifier, notifierForTransport } from "../../notify.js";
import { type PasskeyReadyResult, computePasskeyReady } from "../../passkeyReady.js";
import { ProblemError } from "../../problem.js";
import { toStoredSmtpSecurity } from "../../schemas.js";
import { resolveEntraApp } from "../sources/entra.js";
import {
  type CurrentSettings,
  type EnvironmentView,
  type MailEnvironment,
  type MailSecretActions,
  type SecretAction,
  type SettingsView,
  type StoredMailConfig,
  decideGoogleKey,
  decideGraphApp,
  decideSmtpPassword,
  environmentView,
  graphAppOf,
  planSettingsUpdate,
  readStoredMailConfig,
  toSettingsView,
  validationProblem,
} from "./logic.js";
import {
  type MailTestResult,
  type ResolvedMailTransport,
  runMailTest,
  transportSpec,
} from "./mail.js";
import { type ReachabilityProbe, probePublicUrl } from "./reachability.js";
import type { MailInput, MailTestInput, UpdateSettingsInput } from "./schemas.js";

/**
 * Installation settings (docs/ARCHITECTURE.md, setup and operating modes): the
 * single `settings` row the setup wizard wrote, changed later by provider
 * admins. The mail credentials (SMTP password, the own Microsoft 365 app's
 * secret or certificate, the Google service account key) live only in the
 * encrypted secret store and are never returned. Every
 * change and every test send is written to the audit log; secrets never are.
 */

export const SETTINGS_AUDIT_ACTIONS = {
  updated: "settings.updated",
  mailTested: "settings.mail.tested",
  mailRemoved: "settings.mail.removed",
  mailNotNeeded: "settings.mail.not_needed",
} as const;

/** The installation-level secret kinds of the mail transports. */
const MAIL_SECRET_KINDS = {
  smtpPassword: "smtp_password",
  graphApp: "mail_graph_app",
  googleKey: "mail_google_key",
} as const satisfies Record<keyof MailSecretActions, string>;

type MailSecretRefs = Record<keyof MailSecretActions, SecretRef | null>;

export interface Actor {
  id: string;
  email: string;
  ip: string | null;
}

export interface RequestContext {
  /** The origin the admin's browser is on (see origin.ts). */
  observedOrigin: string | null;
}

function setupIncomplete(): ProblemError {
  return new ProblemError(409, "Setup not completed", {
    type: "urn:restow:problem:setup-incomplete",
    detail: "Finish the setup wizard before changing installation settings.",
  });
}

function mailNotConfigured(): ProblemError {
  return new ProblemError(409, "Mail transport not configured", {
    type: "urn:restow:problem:mail-not-configured",
    detail: "Configure a mail transport first, or send the draft configuration to test.",
  });
}

/** The app registration Graph sendMail authenticates as (the backup app's), or null. */
async function graphMailApp(): Promise<AppCredentials | null> {
  const resolution = await resolveEntraApp();
  return resolution.status === "ready" ? resolution.app.credentials : null;
}

export async function mailEnvironment(): Promise<MailEnvironment> {
  return {
    graphTenantIdDefault: config.graphMailTenantId ?? null,
    graphAppConfigured: (await graphMailApp()) !== null,
  };
}

function passkeyReadyFor(
  state: Pick<Settings, "operatingMode" | "publicUrl">,
  context: RequestContext,
): PasskeyReadyResult {
  return computePasskeyReady(state, {
    observedOrigin: context.observedOrigin,
    allowLocalhost: config.nodeEnv !== "production",
  });
}

async function loadRow(
  executor: DbExecutor,
  options: { forUpdate?: boolean } = {},
): Promise<Settings | null> {
  const query = executor.select().from(settings).limit(1);
  const rows = options.forUpdate ? await query.for("update") : await query;
  return rows[0] ?? null;
}

async function findMailSecrets(executor: DbExecutor): Promise<MailSecretRefs> {
  return {
    smtpPassword: await findProviderSecret(executor, MAIL_SECRET_KINDS.smtpPassword),
    graphApp: await findProviderSecret(executor, MAIL_SECRET_KINDS.graphApp),
    googleKey: await findProviderSecret(executor, MAIL_SECRET_KINDS.googleKey),
  };
}

function storedFlags(refs: MailSecretRefs) {
  return {
    smtpPasswordStored: refs.smtpPassword !== null,
    graphAppStored: refs.graphApp !== null,
    googleKeyStored: refs.googleKey !== null,
  };
}

function currentSettings(row: Settings, refs: MailSecretRefs): CurrentSettings {
  if (!row.operatingMode) {
    throw setupIncomplete();
  }
  return {
    operatingMode: row.operatingMode,
    publicUrl: row.publicUrl,
    mail: readStoredMailConfig(row.mailTransport, row.mailConfig),
    ...storedFlags(refs),
  };
}

async function applySecrets(
  tx: DbExecutor,
  actions: MailSecretActions,
  existing: MailSecretRefs,
): Promise<void> {
  for (const kind of Object.keys(MAIL_SECRET_KINDS) as (keyof MailSecretActions)[]) {
    const action: SecretAction = actions[kind];
    const ref = existing[kind];
    if (action.action === "set") {
      await upsertProviderSecret(tx, MAIL_SECRET_KINDS[kind], action.plaintext);
    } else if (action.action === "delete" && ref) {
      await deleteSecret(tx, ref);
    }
  }
}

// --- Read -------------------------------------------------------------------------------

export async function getSettings(db: DbExecutor, context: RequestContext): Promise<SettingsView> {
  const row = await loadRow(db);
  const refs = await findMailSecrets(db);
  const state = { operatingMode: row?.operatingMode ?? null, publicUrl: row?.publicUrl ?? null };
  return toSettingsView({
    ...state,
    mail: readStoredMailConfig(row?.mailTransport ?? null, row?.mailConfig),
    ...storedFlags(refs),
    updatedAt: row?.updatedAt ?? null,
    passkeyReady: passkeyReadyFor(state, context),
    environmentPublicUrl: config.publicUrl ?? null,
    mailEnvironment: await mailEnvironment(),
    disclaimerVersion: row?.disclaimerVersion ?? null,
    disclaimerAcceptedAt: row?.disclaimerAcceptedAt ?? null,
    currentDisclaimerVersion: DISCLAIMER_VERSION,
  });
}

// --- Update -------------------------------------------------------------------------------

/**
 * Apply a PATCH: the row is locked, the plan computed against what is stored,
 * then settings, secret and audit entry commit together. A PATCH that changes
 * nothing writes nothing.
 */
export async function updateSettings(
  db: DbExecutor,
  patch: UpdateSettingsInput,
  actor: Actor,
  context: RequestContext,
): Promise<SettingsView> {
  const environment = await mailEnvironment();
  await db.transaction(async (tx) => {
    const row = await loadRow(tx, { forUpdate: true });
    if (!row) {
      throw setupIncomplete();
    }
    const refs = await findMailSecrets(tx);
    const plan = planSettingsUpdate(currentSettings(row, refs), patch, environment);
    if (plan.changes.length === 0) {
      return;
    }

    const passkeyReady = passkeyReadyFor(plan, context);
    await tx
      .update(settings)
      .set({
        operatingMode: plan.operatingMode,
        publicUrl: plan.publicUrl,
        passkeyReady: passkeyReady.ready,
        mailTransport: plan.mail?.transport ?? null,
        mailConfig: plan.mail,
      })
      .where(eq(settings.id, row.id));
    await applySecrets(tx, plan.secrets, refs);

    await audit(tx, {
      actor: actor.email,
      actorUserId: actor.id,
      action: SETTINGS_AUDIT_ACTIONS.updated,
      target: row.id,
      targetType: "settings",
      ip: actor.ip,
      details: {
        changes: plan.changes,
        operatingMode: plan.operatingMode,
        publicUrl: plan.publicUrl,
        mailTransport: plan.mail?.transport ?? null,
        passkeyReady: passkeyReady.ready,
      },
    });
  });
  return getSettings(db, context);
}

// --- Test send -------------------------------------------------------------------------------

function storedSecretUnreadable(what: string): never {
  // A sealed document that does not open or parse is a broken installation
  // state, not a validation problem of the request.
  throw new ProblemError(500, "Stored mail credential unreadable", {
    type: "urn:restow:problem:mail-credential-unreadable",
    detail: `The stored ${what} cannot be read. Enter it again under Installation, Notification mail.`,
  });
}

async function openGraphApp(db: DbExecutor, ref: SecretRef | null): Promise<AppCredentials | null> {
  const plaintext = ref ? await readSecret(db, ref) : null;
  if (!plaintext) {
    return null;
  }
  let credentials: AppCredentials | null;
  try {
    credentials = parseSourceAppSecret(plaintext);
  } catch {
    credentials = null;
  }
  return credentials ?? storedSecretUnreadable("app credential");
}

async function openGoogleKey(db: DbExecutor, ref: SecretRef | null) {
  const plaintext = ref ? await readSecret(db, ref) : null;
  if (!plaintext) {
    return null;
  }
  const parsed = parseServiceAccountKey(plaintext);
  return parsed.ok ? parsed.key : storedSecretUnreadable("service account key");
}

/** The stored transport with its credentials opened (in memory, for this send only). */
async function resolveStored(
  db: DbExecutor,
  mail: StoredMailConfig,
  refs: MailSecretRefs,
): Promise<ResolvedMailTransport> {
  switch (mail.transport) {
    case "smtp":
      return {
        transport: "smtp",
        host: mail.host,
        port: mail.port,
        security: mail.security,
        from: mail.from,
        username: mail.username ?? null,
        password:
          mail.username && refs.smtpPassword ? await readSecret(db, refs.smtpPassword) : null,
      };
    case "graph": {
      const app = graphAppOf(mail);
      return {
        transport: "graph",
        sender: mail.sender,
        tenantId: mail.tenantId ?? null,
        app,
        credentials: app === "own" ? await openGraphApp(db, refs.graphApp) : await graphMailApp(),
      };
    }
    case "google":
      return {
        transport: "google",
        sender: mail.sender,
        key: await openGoogleKey(db, refs.googleKey),
      };
  }
}

async function resolveForTest(
  db: DbExecutor,
  draft: MailInput | undefined,
  current: CurrentSettings,
  refs: MailSecretRefs,
): Promise<ResolvedMailTransport> {
  if (!draft) {
    if (!current.mail) {
      throw mailNotConfigured();
    }
    return resolveStored(db, current.mail, refs);
  }

  if (draft.transport === "graph") {
    const decision = decideGraphApp(draft.graph, current);
    const graph = {
      transport: "graph" as const,
      sender: draft.graph.sender,
      tenantId: draft.graph.tenantId,
      app: draft.graph.app,
    };
    switch (decision.kind) {
      case "invalid":
        throw validationProblem([decision.issue]);
      case "backup":
        return { ...graph, credentials: await graphMailApp() };
      case "stored":
        return { ...graph, credentials: await openGraphApp(db, refs.graphApp) };
      case "provided":
        return { ...graph, credentials: decision.credentials };
    }
  }

  if (draft.transport === "google") {
    const decision = decideGoogleKey(draft.google, current);
    switch (decision.kind) {
      case "invalid":
        throw validationProblem([decision.issue]);
      case "stored":
        return {
          transport: "google",
          sender: draft.google.sender,
          key: await openGoogleKey(db, refs.googleKey),
        };
      case "provided":
        return { transport: "google", sender: draft.google.sender, key: decision.key };
    }
  }

  const { smtp: input } = draft;
  const smtp = {
    transport: "smtp" as const,
    host: input.host,
    port: input.port,
    security: toStoredSmtpSecurity(input.security),
    from: input.from,
    username: input.username,
  };
  const decision = decideSmtpPassword(input, current);
  switch (decision.kind) {
    case "invalid":
      throw validationProblem([decision.issue]);
    case "provided":
      return { ...smtp, password: decision.password };
    case "stored":
      return {
        ...smtp,
        password: refs.smtpPassword ? await readSecret(db, refs.smtpPassword) : null,
      };
    case "none":
      return { ...smtp, password: null };
  }
}

/**
 * Send a test notification through the stored transport, or through an unsaved
 * draft (the stored SMTP password is used only for the host and user it was
 * saved for), written in the requester's language. Failures are a result, not
 * an error: the admin needs to see why.
 */
export async function sendTestMail(
  db: DbExecutor,
  input: MailTestInput,
  actor: Actor,
  language: SupportedLanguage,
): Promise<MailTestResult> {
  const row = await loadRow(db);
  if (!row) {
    throw setupIncomplete();
  }
  const refs = await findMailSecrets(db);
  const current = currentSettings(row, refs);
  const transport = await resolveForTest(db, input.mail, current, refs);
  const recipient = input.to ?? actor.email;

  const result = await runMailTest(transport, recipient, language, { base: config });

  await audit(db, {
    actor: actor.email,
    actorUserId: actor.id,
    action: SETTINGS_AUDIT_ACTIONS.mailTested,
    target: recipient,
    targetType: "email",
    ip: actor.ip,
    details: {
      transport: result.transport,
      ok: result.ok,
      reason: result.failure?.reason ?? null,
      unsaved: input.mail !== undefined,
    },
  });
  return result;
}

// --- Remove mail configuration ------------------------------------------------------------

/** Danger zone: forget the transport and destroy every stored mail credential. */
export async function removeMailConfiguration(
  db: DbExecutor,
  actor: Actor,
  context: RequestContext,
): Promise<SettingsView> {
  await db.transaction(async (tx) => {
    const row = await loadRow(tx, { forUpdate: true });
    if (!row) {
      throw setupIncomplete();
    }
    const refs = await findMailSecrets(tx);
    const stored = Object.values(refs).filter((ref): ref is SecretRef => ref !== null);
    if (row.mailTransport === null && row.mailConfig === null && stored.length === 0) {
      return;
    }
    await tx
      .update(settings)
      .set({ mailTransport: null, mailConfig: null })
      .where(eq(settings.id, row.id));
    for (const ref of stored) {
      await deleteSecret(tx, ref);
    }
    await audit(tx, {
      actor: actor.email,
      actorUserId: actor.id,
      action: SETTINGS_AUDIT_ACTIONS.mailRemoved,
      target: row.id,
      targetType: "settings",
      ip: actor.ip,
      details: {
        previousTransport: row.mailTransport,
        passwordDeleted: refs.smtpPassword !== null,
        credentialsDeleted: stored.map((ref) => ref.kind),
      },
    });
  });
  return getSettings(db, context);
}

// --- Notification mail marked as not needed ---------------------------------------------------

/**
 * Mark the notification mail as not needed (or take the mark back): the optional last step
 * of the Start checklist stops asking for a test mail. It changes nothing about the transport
 * itself and does not stop a configured transport from sending; installation-level, like
 * the mail settings it belongs to.
 */
export async function setMailNotNeeded(
  db: DbExecutor,
  notNeeded: boolean,
  actor: Actor,
): Promise<{ notNeeded: boolean }> {
  await db.transaction(async (tx) => {
    const row = await loadRow(tx, { forUpdate: true });
    if (!row) {
      throw setupIncomplete();
    }
    if (row.mailNotNeeded === notNeeded) {
      return;
    }
    await tx.update(settings).set({ mailNotNeeded: notNeeded }).where(eq(settings.id, row.id));
    await audit(tx, {
      actor: actor.email,
      actorUserId: actor.id,
      action: SETTINGS_AUDIT_ACTIONS.mailNotNeeded,
      target: row.id,
      targetType: "settings",
      ip: actor.ip,
      details: { notNeeded, transport: row.mailTransport },
    });
  });
  return { notNeeded };
}

// --- Passkey readiness ------------------------------------------------------------------------

export interface PasskeyReadinessCheck {
  passkeyReady: PasskeyReadyResult;
  probe: ReachabilityProbe;
  environment: EnvironmentView;
}

/**
 * Re-run the passkey gate for the requesting browser plus the server-side
 * HTTPS probe, and refresh the stored `passkey_ready` flag when it changed
 * (without touching the row's last-change time: nobody changed a setting).
 */
export async function checkPasskeyReadiness(
  db: DbExecutor,
  context: RequestContext,
  probe: (origin: string | null) => Promise<ReachabilityProbe> = probePublicUrl,
): Promise<PasskeyReadinessCheck> {
  const row = await loadRow(db);
  const state = { operatingMode: row?.operatingMode ?? null, publicUrl: row?.publicUrl ?? null };
  const passkeyReady = passkeyReadyFor(state, context);
  const reachability = await probe(state.operatingMode === "public" ? state.publicUrl : null);

  if (row && row.passkeyReady !== passkeyReady.ready) {
    await db
      .update(settings)
      .set({ passkeyReady: passkeyReady.ready, updatedAt: row.updatedAt })
      .where(eq(settings.id, row.id));
  }
  return {
    passkeyReady,
    probe: reachability,
    environment: environmentView(config.publicUrl, state.publicUrl),
  };
}

// --- Notifier for other features -----------------------------------------------------------

/**
 * The notifier for the stored installation settings, for features that send
 * notifications (reports, alerts, invitations). Null while no transport is
 * configured, so callers can say so instead of failing silently.
 */
export async function createInstallationNotifier(db: DbExecutor): Promise<Notifier | null> {
  const row = await loadRow(db);
  const mail: StoredMailConfig | null = readStoredMailConfig(
    row?.mailTransport ?? null,
    row?.mailConfig,
  );
  if (!mail) {
    // Nothing saved in Settings: fall back to MAIL_TRANSPORT / SMTP_* / GRAPH_MAIL_*
    // from the environment (docs: .env.example), which were otherwise never read.
    if (!environmentMailConfigured(config)) {
      return null;
    }
    return createNotifier(config, config.mailTransport === "graph" ? await graphMailApp() : null);
  }
  const resolved = await resolveStored(db, mail, await findMailSecrets(db));
  return notifierForTransport(transportSpec(config, resolved), { demo: config.demo.enabled });
}

/**
 * Whether the environment alone configures a notification transport: SMTP
 * needs a host and a sender address, Graph a sender mailbox. MAIL_TRANSPORT
 * defaults to SMTP.
 */
export function environmentMailConfigured(base: Config): boolean {
  if (base.mailTransport === "graph") {
    return Boolean(base.graphMailSender?.trim());
  }
  return Boolean(base.smtp.host?.trim() && base.smtp.from?.trim());
}
