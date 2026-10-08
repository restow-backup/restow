import {
  type AppCredentials,
  type CertificateProblem,
  type SourceAppDocument,
  buildSourceApp,
  inspectCertificatePem,
  serializeSourceAppDocument,
} from "@restow/core";
import type { MailConfig } from "@restow/db";
import { z } from "zod";
import {
  type GoogleServiceAccountKey,
  parseServiceAccountKey,
  serializeServiceAccountKey,
} from "../../notify-google.js";
import type { PasskeyReadyResult } from "../../passkeyReady.js";
import { ProblemError } from "../../problem.js";
import { toStoredSmtpSecurity } from "../../schemas.js";
import type {
  GoogleInput,
  GraphInput,
  GraphMailAppOption,
  MailInput,
  OperatingModeOption,
  SmtpInput,
  SmtpSecurityOption,
  UpdateSettingsInput,
} from "./schemas.js";

/**
 * Installation settings rules (pure, no I/O): how a PATCH turns into the next
 * stored state, when a stored mail credential (SMTP password, the own Microsoft
 * 365 app's secret or certificate, the Google service account key) may be
 * reused, and what the API returns. The service applies the result inside one
 * transaction.
 */

// --- Stored mail configuration ------------------------------------------------------

export type StoredSmtpConfig = Extract<MailConfig, { transport: "smtp" }>;
export type StoredGraphConfig = Extract<MailConfig, { transport: "graph" }>;
export type StoredGoogleConfig = Extract<MailConfig, { transport: "google" }>;
export type StoredMailConfig = MailConfig;
export type MailTransportOption = MailConfig["transport"];

const storedMailConfigSchema = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("smtp"),
    host: z.string().min(1),
    port: z.number().int(),
    security: z.enum(["starttls", "implicit", "none"]),
    from: z.string(),
    username: z.string().min(1).optional(),
  }),
  z.object({
    transport: z.literal("graph"),
    sender: z.string().min(1),
    tenantId: z.string().min(1).optional(),
    app: z.enum(["backup", "own"]).optional(),
    clientId: z.string().min(1).optional(),
    credentialKind: z.enum(["secret", "certificate"]).optional(),
  }),
  z.object({
    transport: z.literal("google"),
    sender: z.string().min(1),
    serviceAccountEmail: z.string().min(1),
    clientId: z.string().min(1),
  }),
]);

/**
 * Read the stored configuration defensively: the column is jsonb, so anything
 * that does not match the transport it claims is treated as "not configured"
 * rather than trusted.
 */
export function readStoredMailConfig(
  transport: MailTransportOption | null,
  value: unknown,
): StoredMailConfig | null {
  if (transport === null) {
    return null;
  }
  const parsed = storedMailConfigSchema.safeParse(value);
  if (!parsed.success || parsed.data.transport !== transport) {
    return null;
  }
  const mail = parsed.data;
  if (
    mail.transport === "graph" &&
    mail.app === "own" &&
    (!mail.clientId || !mail.credentialKind || !mail.tenantId)
  ) {
    return null;
  }
  return mail;
}

/** Which app registration a stored Graph transport sends as (`backup` for older rows). */
export function graphAppOf(mail: StoredGraphConfig): GraphMailAppOption {
  return mail.app ?? "backup";
}

/** The public facts of a service account key that the settings row keeps. */
export interface GoogleKeyFacts {
  serviceAccountEmail: string;
  clientId: string;
}

export function googleKeyFacts(key: GoogleServiceAccountKey): GoogleKeyFacts {
  return { serviceAccountEmail: key.clientEmail, clientId: key.clientId };
}

/**
 * The stored shape for a submitted transport (never carries a secret). Google
 * needs the facts of the key that will be used (new or kept).
 */
export function toStoredMail(
  input: MailInput,
  googleKey: GoogleKeyFacts | null = null,
): StoredMailConfig {
  if (input.transport === "smtp") {
    const { host, port, security, from, username } = input.smtp;
    return {
      transport: "smtp",
      host,
      port,
      security: toStoredSmtpSecurity(security),
      from,
      ...(username ? { username } : {}),
    };
  }
  if (input.transport === "google") {
    if (!googleKey) {
      throw new Error("toStoredMail: the Google transport needs the facts of its key");
    }
    return { transport: "google", sender: input.google.sender, ...googleKey };
  }
  const { sender, tenantId, app, ownApp } = input.graph;
  if (app === "own" && ownApp && tenantId) {
    return {
      transport: "graph",
      sender,
      tenantId: tenantId.toLowerCase(),
      app: "own",
      clientId: ownApp.clientId.toLowerCase(),
      credentialKind: ownApp.credentialKind,
    };
  }
  return { transport: "graph", sender, ...(tenantId ? { tenantId } : {}) };
}

/** The contract spelling of a stored security value (`implicit` is `tls` on the wire). */
export function toContractSecurity(security: StoredSmtpConfig["security"]): SmtpSecurityOption {
  return security === "implicit" ? "tls" : security;
}

// --- Current state and environment --------------------------------------------------

/** The stored installation state the update rules work on. */
export interface CurrentSettings {
  operatingMode: OperatingModeOption;
  publicUrl: string | null;
  mail: StoredMailConfig | null;
  /** An installation-level `smtp_password` secret exists. */
  smtpPasswordStored: boolean;
  /** An installation-level `mail_graph_app` secret (the own app's credential) exists. */
  graphAppStored?: boolean;
  /** An installation-level `mail_google_key` secret (the service account key) exists. */
  googleKeyStored?: boolean;
}

/** What the server environment contributes to the mail transport. */
export interface MailEnvironment {
  /** GRAPH_MAIL_TENANT_ID, used when the Graph transport names no tenant. */
  graphTenantIdDefault: string | null;
  /**
   * A usable backup app registration exists (environment or Settings →
   * Microsoft 365), so Graph sendMail can authenticate with it.
   */
  graphAppConfigured: boolean;
}

// --- Validation -------------------------------------------------------------------------

export interface ValidationIssue {
  path: (string | number)[];
  /** Short reason, same vocabulary as the request schemas. */
  message: string;
}

/** A 422 problem in the same shape `parseOrProblem` produces. */
export function validationProblem(issues: ValidationIssue[]): ProblemError {
  return new ProblemError(422, "Validation failed", {
    detail: "The request did not match the expected schema.",
    extensions: { issues },
  });
}

// --- SMTP password ------------------------------------------------------------------------

export type SmtpPasswordDecision =
  | { kind: "provided"; password: string }
  | { kind: "stored" }
  | { kind: "none" }
  | { kind: "invalid"; issue: ValidationIssue };

function sameHost(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * A stored password is only ever used for the host and username it was saved
 * for: pointing the transport elsewhere must never hand the old credential to
 * a new server.
 */
export function mayReuseStoredPassword(
  draft: Pick<SmtpInput, "host" | "username">,
  current: CurrentSettings,
): boolean {
  const stored = current.mail;
  return (
    current.smtpPasswordStored &&
    stored?.transport === "smtp" &&
    sameHost(stored.host, draft.host) &&
    (stored.username ?? null) === draft.username
  );
}

/** Which password an SMTP draft authenticates with, or why it cannot. */
export function decideSmtpPassword(
  draft: SmtpInput,
  current: CurrentSettings,
): SmtpPasswordDecision {
  if (draft.username === null) {
    return draft.password === undefined
      ? { kind: "none" }
      : {
          kind: "invalid",
          issue: { path: ["mail", "smtp", "username"], message: "usernameRequired" },
        };
  }
  if (draft.password !== undefined) {
    return { kind: "provided", password: draft.password };
  }
  if (mayReuseStoredPassword(draft, current)) {
    return { kind: "stored" };
  }
  return {
    kind: "invalid",
    issue: { path: ["mail", "smtp", "password"], message: "passwordRequired" },
  };
}

// --- Microsoft 365: the notification mail's own app registration --------------------------

/** Issue reasons for a certificate, in the vocabulary of Installation › Microsoft 365. */
const CERTIFICATE_REASONS: Record<CertificateProblem, string> = {
  certificate_missing: "certificateMissing",
  private_key_missing: "privateKeyMissing",
  private_key_encrypted: "privateKeyEncrypted",
  certificate_invalid: "certificateInvalid",
  private_key_invalid: "privateKeyInvalid",
  unsupported_key_type: "unsupportedKeyType",
  key_mismatch: "keyMismatch",
  expired: "certificateExpired",
  not_yet_valid: "certificateNotYetValid",
};

export type GraphAppDecision =
  /** Graph sends as the backup app registration; no own credential is involved. */
  | { kind: "backup" }
  | { kind: "provided"; document: SourceAppDocument; credentials: AppCredentials }
  | { kind: "stored" }
  | { kind: "invalid"; issue: ValidationIssue };

const OWN_APP_PATH = ["mail", "graph", "ownApp"] as const;

/**
 * The stored own-app credential is only reused for the tenant, client id and
 * credential kind it was saved for: pointing the transport at another app must
 * never hand the old secret to it.
 */
export function mayReuseStoredGraphApp(graph: GraphInput, current: CurrentSettings): boolean {
  const stored = current.mail;
  const own = graph.ownApp;
  return (
    current.graphAppStored === true &&
    own !== undefined &&
    graph.tenantId !== null &&
    stored?.transport === "graph" &&
    graphAppOf(stored) === "own" &&
    stored.tenantId?.toLowerCase() === graph.tenantId.toLowerCase() &&
    stored.clientId?.toLowerCase() === own.clientId.toLowerCase() &&
    stored.credentialKind === own.credentialKind
  );
}

/** Which own-app credential a Graph draft authenticates with, or why it cannot. */
export function decideGraphApp(
  graph: GraphInput,
  current: CurrentSettings,
  now: Date = new Date(),
): GraphAppDecision {
  if (graph.app !== "own") {
    return { kind: "backup" };
  }
  const own = graph.ownApp;
  if (!own || !graph.tenantId) {
    // The request schema already refuses this; kept for a total function.
    return { kind: "invalid", issue: { path: [...OWN_APP_PATH], message: "required" } };
  }
  const field = own.credentialKind === "secret" ? "clientSecret" : "certificatePem";
  const supplied = own.credentialKind === "secret" ? own.clientSecret : own.certificatePem;
  if (supplied === undefined) {
    return mayReuseStoredGraphApp(graph, current)
      ? { kind: "stored" }
      : {
          kind: "invalid",
          issue: { path: [...OWN_APP_PATH, field], message: "credentialRequired" },
        };
  }

  let certificatePem: string | undefined;
  if (own.credentialKind === "certificate") {
    const inspection = inspectCertificatePem(supplied, now);
    if (!inspection.ok) {
      return {
        kind: "invalid",
        issue: { path: [...OWN_APP_PATH, field], message: CERTIFICATE_REASONS[inspection.problem] },
      };
    }
    // Stored as key plus certificate only; anything else pasted around them is dropped.
    certificatePem = `${inspection.privateKeyPem.trim()}\n${inspection.certificatePem.trim()}\n`;
  }
  const built = buildSourceApp({
    tenantId: graph.tenantId,
    clientId: own.clientId,
    credentialKind: own.credentialKind,
    clientSecret: own.credentialKind === "secret" ? supplied : null,
    certificatePem: certificatePem ?? null,
  });
  if (!built.ok) {
    const issue: ValidationIssue =
      built.problem === "tenant_id"
        ? { path: ["mail", "graph", "tenantId"], message: "tenantGuid" }
        : built.problem === "client_id"
          ? { path: [...OWN_APP_PATH, "clientId"], message: "guid" }
          : built.problem === "certificate"
            ? { path: [...OWN_APP_PATH, field], message: "certificateInvalid" }
            : { path: [...OWN_APP_PATH, field], message: "credentialRequired" };
    return { kind: "invalid", issue };
  }
  return { kind: "provided", document: built.document, credentials: built.credentials };
}

/** The sealed plaintext of an own-app credential. */
export function graphAppPlaintext(document: SourceAppDocument): string {
  return serializeSourceAppDocument(document);
}

// --- Google Workspace: the service account key ----------------------------------------------

export type GoogleKeyDecision =
  | { kind: "provided"; key: GoogleServiceAccountKey; plaintext: string }
  | { kind: "stored"; facts: GoogleKeyFacts }
  | { kind: "invalid"; issue: ValidationIssue };

const GOOGLE_KEY_PATH = ["mail", "google", "serviceAccountKey"] as const;

/**
 * Which service account key a Google draft sends with. Without a new key the
 * stored one is kept while the transport stays Google (the key, not the
 * sender, identifies the delegation).
 */
export function decideGoogleKey(google: GoogleInput, current: CurrentSettings): GoogleKeyDecision {
  if (google.serviceAccountKey !== undefined) {
    const parsed = parseServiceAccountKey(google.serviceAccountKey);
    if (!parsed.ok) {
      return {
        kind: "invalid",
        issue: { path: [...GOOGLE_KEY_PATH], message: "serviceAccountKey" },
      };
    }
    return {
      kind: "provided",
      key: parsed.key,
      plaintext: serializeServiceAccountKey(parsed.key),
    };
  }
  const stored = current.mail;
  if (current.googleKeyStored === true && stored?.transport === "google") {
    return {
      kind: "stored",
      facts: { serviceAccountEmail: stored.serviceAccountEmail, clientId: stored.clientId },
    };
  }
  return { kind: "invalid", issue: { path: [...GOOGLE_KEY_PATH], message: "required" } };
}

// --- Update plan -----------------------------------------------------------------------

export type SecretAction =
  | { action: "keep" }
  | { action: "set"; plaintext: string }
  | { action: "delete" };

/** What happens to each installation-level mail credential. */
export interface MailSecretActions {
  smtpPassword: SecretAction;
  graphApp: SecretAction;
  googleKey: SecretAction;
}

const KEEP_ALL: MailSecretActions = {
  smtpPassword: { action: "keep" },
  graphApp: { action: "keep" },
  googleKey: { action: "keep" },
};

export interface SettingsUpdatePlan {
  operatingMode: OperatingModeOption;
  publicUrl: string | null;
  mail: StoredMailConfig | null;
  /** What happens to the stored mail credentials. */
  secrets: MailSecretActions;
  /** Names of the changed settings for the audit log (never secret values). */
  changes: string[];
}

type MailPlan = { mail: StoredMailConfig; secrets: MailSecretActions } | { issue: ValidationIssue };

function planMail(input: MailInput, current: CurrentSettings, env: MailEnvironment): MailPlan {
  // A credential nothing uses any more is removed, not kept around.
  const drop = (stored: boolean | undefined): SecretAction =>
    stored ? { action: "delete" } : { action: "keep" };
  const unused: MailSecretActions = {
    smtpPassword: drop(current.smtpPasswordStored),
    graphApp: drop(current.graphAppStored),
    googleKey: drop(current.googleKeyStored),
  };

  if (input.transport === "graph") {
    const decision = decideGraphApp(input.graph, current);
    switch (decision.kind) {
      case "invalid":
        return { issue: decision.issue };
      case "backup":
        if (!input.graph.tenantId && !env.graphTenantIdDefault) {
          return { issue: { path: ["mail", "graph", "tenantId"], message: "required" } };
        }
        return { mail: toStoredMail(input), secrets: unused };
      case "stored":
        return {
          mail: toStoredMail(input),
          secrets: { ...unused, graphApp: { action: "keep" } },
        };
      case "provided":
        return {
          mail: toStoredMail(input),
          secrets: {
            ...unused,
            graphApp: { action: "set", plaintext: graphAppPlaintext(decision.document) },
          },
        };
    }
  }

  if (input.transport === "google") {
    const decision = decideGoogleKey(input.google, current);
    switch (decision.kind) {
      case "invalid":
        return { issue: decision.issue };
      case "stored":
        return {
          mail: toStoredMail(input, decision.facts),
          secrets: { ...unused, googleKey: { action: "keep" } },
        };
      case "provided":
        return {
          mail: toStoredMail(input, googleKeyFacts(decision.key)),
          secrets: { ...unused, googleKey: { action: "set", plaintext: decision.plaintext } },
        };
    }
  }

  const mail = toStoredMail(input);
  const decision = decideSmtpPassword(input.smtp, current);
  switch (decision.kind) {
    case "invalid":
      return { issue: decision.issue };
    case "provided":
      return {
        mail,
        secrets: { ...unused, smtpPassword: { action: "set", plaintext: decision.password } },
      };
    case "stored":
      return { mail, secrets: { ...unused, smtpPassword: { action: "keep" } } };
    case "none":
      return { mail, secrets: unused };
  }
}

function diffMail(before: StoredMailConfig | null, after: StoredMailConfig | null): string[] {
  if ((before?.transport ?? null) !== (after?.transport ?? null)) {
    return ["mail.transport"];
  }
  if (!before || !after) {
    return [];
  }
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => key !== "transport" && a[key] !== b[key])
    .sort()
    .map((key) => `mail.${key}`);
}

/** Audit names of the stored credentials (never their values). */
const SECRET_CHANGE_NAMES: Record<keyof MailSecretActions, string> = {
  smtpPassword: "mail.password",
  graphApp: "mail.graphAppCredential",
  googleKey: "mail.googleKey",
};

/** The changed setting names between the current state and a plan. */
export function diffSettings(
  current: CurrentSettings,
  next: Pick<SettingsUpdatePlan, "operatingMode" | "publicUrl" | "mail" | "secrets">,
): string[] {
  const changes: string[] = [];
  if (current.operatingMode !== next.operatingMode) {
    changes.push("operatingMode");
  }
  if (current.publicUrl !== next.publicUrl) {
    changes.push("publicUrl");
  }
  changes.push(...diffMail(current.mail, next.mail));
  for (const kind of Object.keys(SECRET_CHANGE_NAMES) as (keyof MailSecretActions)[]) {
    if (next.secrets[kind].action !== "keep") {
      changes.push(SECRET_CHANGE_NAMES[kind]);
    }
  }
  return changes;
}

/**
 * Turn a PATCH into the next stored state. Every problem is collected and
 * reported at once as a 422 with issue paths the form can attach to fields.
 *
 *   - Public mode needs a public URL; local mode stores none (it binds no domain).
 *   - A present `mail` replaces the transport. Each stored credential is kept
 *     only for the same server and user (SMTP), the same tenant, app and
 *     credential kind (own Microsoft 365 app) or while the transport stays
 *     Google (service account key); a credential the new transport does not
 *     use is deleted.
 *   - Graph with the backup app needs a tenant, either submitted or from
 *     GRAPH_MAIL_TENANT_ID; the own app needs its directory (tenant) ID.
 */
export function planSettingsUpdate(
  current: CurrentSettings,
  patch: UpdateSettingsInput,
  env: MailEnvironment,
): SettingsUpdatePlan {
  const issues: ValidationIssue[] = [];

  const operatingMode = patch.operatingMode ?? current.operatingMode;
  const requestedUrl = patch.publicUrl !== undefined ? patch.publicUrl : current.publicUrl;
  if (operatingMode === "public" && !requestedUrl) {
    issues.push({ path: ["publicUrl"], message: "required" });
  }
  const publicUrl = operatingMode === "public" ? requestedUrl : null;

  let mail = current.mail;
  let secrets: MailSecretActions = KEEP_ALL;
  if (patch.mail) {
    const planned = planMail(patch.mail, current, env);
    if ("issue" in planned) {
      issues.push(planned.issue);
    } else {
      mail = planned.mail;
      secrets = planned.secrets;
    }
  }

  if (issues.length > 0) {
    throw validationProblem(issues);
  }
  const next = { operatingMode, publicUrl, mail, secrets };
  return { ...next, changes: diffSettings(current, next) };
}

// --- Response ------------------------------------------------------------------------------

export type MailSettingsView =
  | { transport: null }
  | {
      transport: "smtp";
      smtp: {
        host: string;
        port: number;
        security: SmtpSecurityOption;
        from: string;
        username: string | null;
        /** A password is stored (it is never returned). */
        passwordStored: boolean;
      };
    }
  | {
      transport: "graph";
      graph: {
        sender: string;
        tenantId: string | null;
        app: GraphMailAppOption;
        /** The own app's public facts; null while Graph sends as the backup app. */
        ownApp: {
          clientId: string;
          credentialKind: "secret" | "certificate";
          /** The secret or certificate is stored (it is never returned). */
          credentialStored: boolean;
        } | null;
      };
    }
  | {
      transport: "google";
      google: {
        sender: string;
        serviceAccountEmail: string;
        /** The OAuth client id the Admin console's domain-wide delegation entry names. */
        clientId: string;
        /** The key is stored (it is never returned). */
        keyStored: boolean;
      };
    };

/** Which mail credentials the installation secret store holds. */
export interface StoredSecretFlags {
  smtpPassword: boolean;
  graphApp?: boolean;
  googleKey?: boolean;
}

export function toMailView(
  mail: StoredMailConfig | null,
  stored: StoredSecretFlags | boolean,
): MailSettingsView {
  const flags: StoredSecretFlags = typeof stored === "boolean" ? { smtpPassword: stored } : stored;
  if (!mail) {
    return { transport: null };
  }
  if (mail.transport === "smtp") {
    return {
      transport: "smtp",
      smtp: {
        host: mail.host,
        port: mail.port,
        security: toContractSecurity(mail.security),
        from: mail.from,
        username: mail.username ?? null,
        passwordStored: flags.smtpPassword,
      },
    };
  }
  if (mail.transport === "google") {
    return {
      transport: "google",
      google: {
        sender: mail.sender,
        serviceAccountEmail: mail.serviceAccountEmail,
        clientId: mail.clientId,
        keyStored: flags.googleKey === true,
      },
    };
  }
  const app = graphAppOf(mail);
  return {
    transport: "graph",
    graph: {
      sender: mail.sender,
      tenantId: mail.tenantId ?? null,
      app,
      ownApp:
        app === "own" && mail.clientId && mail.credentialKind
          ? {
              clientId: mail.clientId,
              credentialKind: mail.credentialKind,
              credentialStored: flags.graphApp === true,
            }
          : null,
    },
  };
}

function originOf(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export interface EnvironmentView {
  /** RESTOW_PUBLIC_URL the server runs with (better-auth base URL and passkey RP). */
  publicUrl: string | null;
  /**
   * The environment names a different origin than the saved public URL.
   * better-auth reads the environment at start-up, so passkeys and sign-in
   * links keep following it until the variable is changed and Restow restarts.
   */
  publicUrlMismatch: boolean;
}

export function environmentView(
  environmentUrl: string | null | undefined,
  storedUrl: string | null,
): EnvironmentView {
  const environmentOrigin = originOf(environmentUrl);
  const storedOrigin = originOf(storedUrl);
  return {
    publicUrl: environmentOrigin,
    publicUrlMismatch:
      environmentOrigin !== null && storedOrigin !== null && environmentOrigin !== storedOrigin,
  };
}

export interface SettingsView {
  operatingMode: OperatingModeOption | null;
  publicUrl: string | null;
  passkeyReady: PasskeyReadyResult;
  environment: EnvironmentView;
  mail: MailSettingsView;
  capabilities: {
    graphMail: { appConfigured: boolean; defaultTenantId: string | null };
  };
  /**
   * The operator responsibility notice as this installation holds it: the
   * version it was accepted at and when (both null before the first
   * acceptance) next to the version the server asks for now.
   */
  disclaimer: {
    acceptedVersion: string | null;
    acceptedAt: string | null;
    currentVersion: string;
  };
  /** Last change of the settings row (ISO 8601), null before setup. */
  updatedAt: string | null;
}

export interface SettingsViewInput {
  operatingMode: OperatingModeOption | null;
  publicUrl: string | null;
  mail: StoredMailConfig | null;
  smtpPasswordStored: boolean;
  graphAppStored?: boolean;
  googleKeyStored?: boolean;
  updatedAt: Date | null;
  passkeyReady: PasskeyReadyResult;
  environmentPublicUrl: string | null;
  mailEnvironment: MailEnvironment;
  disclaimerVersion: string | null;
  disclaimerAcceptedAt: Date | null;
  /** Version of the notice text the server asks to be accepted (lib/disclaimer.ts). */
  currentDisclaimerVersion: string;
}

/** The GET/PATCH response body. Secrets never appear, only whether one is stored. */
export function toSettingsView(input: SettingsViewInput): SettingsView {
  return {
    operatingMode: input.operatingMode,
    publicUrl: input.publicUrl,
    passkeyReady: input.passkeyReady,
    environment: environmentView(input.environmentPublicUrl, input.publicUrl),
    mail: toMailView(input.mail, {
      smtpPassword: input.smtpPasswordStored,
      graphApp: input.graphAppStored === true,
      googleKey: input.googleKeyStored === true,
    }),
    capabilities: {
      graphMail: {
        appConfigured: input.mailEnvironment.graphAppConfigured,
        defaultTenantId: input.mailEnvironment.graphTenantIdDefault,
      },
    },
    disclaimer: {
      acceptedVersion: input.disclaimerVersion,
      acceptedAt: input.disclaimerAcceptedAt ? input.disclaimerAcceptedAt.toISOString() : null,
      currentVersion: input.currentDisclaimerVersion,
    },
    updatedAt: input.updatedAt ? input.updatedAt.toISOString() : null,
  };
}
