import type { AppCredentials } from "@restow/core";
import { type Settings, settings } from "@restow/db";
import type { SupportedLanguage } from "@restow/i18n";
import { eq } from "drizzle-orm";
import { config } from "../../config.js";
import { audit } from "../../lib/audit.js";
import {
  type SecretRef,
  deleteSecret,
  findProviderSecret,
  readSecret,
  upsertProviderSecret,
} from "../../lib/secrets.js";
import type { DbExecutor } from "../../lib/tenant-context.js";
import { type Notifier, createNotifier } from "../../notify.js";
import { type PasskeyReadyResult, computePasskeyReady } from "../../passkeyReady.js";
import { ProblemError } from "../../problem.js";
import { resolveEntraApp } from "../sources/entra.js";
import {
  type CurrentSettings,
  type EnvironmentView,
  type MailEnvironment,
  type SecretAction,
  type SettingsView,
  type StoredMailConfig,
  decideSmtpPassword,
  environmentView,
  planSettingsUpdate,
  readStoredMailConfig,
  toSettingsView,
  toStoredMail,
  validationProblem,
} from "./logic.js";
import {
  type MailTestResult,
  type ResolvedMailTransport,
  notifierConfig,
  resolveMail,
  runMailTest,
} from "./mail.js";
import { type ReachabilityProbe, probePublicUrl } from "./reachability.js";
import type { MailInput, MailTestInput, UpdateSettingsInput } from "./schemas.js";

/**
 * Installation settings (docs/ARCHITECTURE.md, setup and operating modes): the
 * single `settings` row the setup wizard wrote, changed later by provider
 * admins. The SMTP password lives only in the encrypted secret store. Every
 * change and every test send is written to the audit log; secrets never are.
 */

export const SETTINGS_AUDIT_ACTIONS = {
  updated: "settings.updated",
  mailTested: "settings.mail.tested",
  mailRemoved: "settings.mail.removed",
} as const;

const SMTP_PASSWORD_KIND = "smtp_password";

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

function findSmtpPassword(executor: DbExecutor): Promise<SecretRef | null> {
  return findProviderSecret(executor, SMTP_PASSWORD_KIND);
}

function currentSettings(row: Settings, smtpPasswordStored: boolean): CurrentSettings {
  if (!row.operatingMode) {
    throw setupIncomplete();
  }
  return {
    operatingMode: row.operatingMode,
    publicUrl: row.publicUrl,
    mail: readStoredMailConfig(row.mailTransport, row.mailConfig),
    smtpPasswordStored,
  };
}

async function applySecret(
  tx: DbExecutor,
  action: SecretAction,
  existing: SecretRef | null,
): Promise<void> {
  if (action.action === "set") {
    await upsertProviderSecret(tx, SMTP_PASSWORD_KIND, action.plaintext);
  } else if (action.action === "delete" && existing) {
    await deleteSecret(tx, existing);
  }
}

// --- Read -------------------------------------------------------------------------------

export async function getSettings(db: DbExecutor, context: RequestContext): Promise<SettingsView> {
  const row = await loadRow(db);
  const secret = await findSmtpPassword(db);
  const state = { operatingMode: row?.operatingMode ?? null, publicUrl: row?.publicUrl ?? null };
  return toSettingsView({
    ...state,
    mail: readStoredMailConfig(row?.mailTransport ?? null, row?.mailConfig),
    smtpPasswordStored: secret !== null,
    updatedAt: row?.updatedAt ?? null,
    passkeyReady: passkeyReadyFor(state, context),
    environmentPublicUrl: config.publicUrl ?? null,
    mailEnvironment: await mailEnvironment(),
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
    const secretRef = await findSmtpPassword(tx);
    const plan = planSettingsUpdate(currentSettings(row, secretRef !== null), patch, environment);
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
    await applySecret(tx, plan.secret, secretRef);

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

async function resolveForTest(
  db: DbExecutor,
  draft: MailInput | undefined,
  current: CurrentSettings,
  secretRef: SecretRef | null,
): Promise<ResolvedMailTransport> {
  const storedPassword = async () => (secretRef ? readSecret(db, secretRef) : null);

  if (!draft) {
    if (!current.mail) {
      throw mailNotConfigured();
    }
    const needsPassword = current.mail.transport === "smtp" && current.mail.username !== undefined;
    return resolveMail(current.mail, needsPassword ? await storedPassword() : null);
  }

  const mail = toStoredMail(draft);
  if (draft.transport === "graph") {
    return resolveMail(mail, null);
  }
  const decision = decideSmtpPassword(draft.smtp, current);
  switch (decision.kind) {
    case "invalid":
      throw validationProblem([decision.issue]);
    case "provided":
      return resolveMail(mail, decision.password);
    case "stored":
      return resolveMail(mail, await storedPassword());
    case "none":
      return resolveMail(mail, null);
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
  const secretRef = await findSmtpPassword(db);
  const current = currentSettings(row, secretRef !== null);
  const transport = await resolveForTest(db, input.mail, current, secretRef);
  const recipient = input.to ?? actor.email;

  const graphApp = transport.transport === "graph" ? await graphMailApp() : null;
  const result = await runMailTest(transport, recipient, language, { base: config, graphApp });

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

/** Danger zone: forget the transport and destroy the stored SMTP password. */
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
    const secretRef = await findSmtpPassword(tx);
    if (row.mailTransport === null && row.mailConfig === null && secretRef === null) {
      return;
    }
    await tx
      .update(settings)
      .set({ mailTransport: null, mailConfig: null })
      .where(eq(settings.id, row.id));
    if (secretRef) {
      await deleteSecret(tx, secretRef);
    }
    await audit(tx, {
      actor: actor.email,
      actorUserId: actor.id,
      action: SETTINGS_AUDIT_ACTIONS.mailRemoved,
      target: row.id,
      targetType: "settings",
      ip: actor.ip,
      details: { previousTransport: row.mailTransport, passwordDeleted: secretRef !== null },
    });
  });
  return getSettings(db, context);
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
    return null;
  }
  const secretRef = mail.transport === "smtp" && mail.username ? await findSmtpPassword(db) : null;
  const password = secretRef ? await readSecret(db, secretRef) : null;
  const graphApp = mail.transport === "graph" ? await graphMailApp() : null;
  return createNotifier(notifierConfig(config, resolveMail(mail, password)), graphApp);
}
