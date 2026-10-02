import type { MailConfig } from "@restow/db";
import { z } from "zod";
import type { PasskeyReadyResult } from "../../passkeyReady.js";
import { ProblemError } from "../../problem.js";
import { toStoredSmtpSecurity } from "../../schemas.js";
import type {
  MailInput,
  OperatingModeOption,
  SmtpInput,
  SmtpSecurityOption,
  UpdateSettingsInput,
} from "./schemas.js";

/**
 * Installation settings rules (pure, no I/O): how a PATCH turns into the next
 * stored state, when the stored SMTP password may be reused, and what the API
 * returns. The service applies the result inside one transaction.
 */

// --- Stored mail configuration ------------------------------------------------------

export type StoredSmtpConfig = Extract<MailConfig, { transport: "smtp" }>;

/**
 * The Graph transport as stored. The db `MailConfig` type has no tenant member,
 * so the tenant rides along in the same jsonb column (schema gap, noted for the
 * db owner); readers that do not know it simply ignore it.
 */
export type StoredGraphConfig = Extract<MailConfig, { transport: "graph" }> & {
  tenantId?: string;
};

export type StoredMailConfig = StoredSmtpConfig | StoredGraphConfig;

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
  }),
]);

/**
 * Read the stored configuration defensively: the column is jsonb, so anything
 * that does not match the transport it claims is treated as "not configured"
 * rather than trusted.
 */
export function readStoredMailConfig(
  transport: "smtp" | "graph" | null,
  value: unknown,
): StoredMailConfig | null {
  if (transport === null) {
    return null;
  }
  const parsed = storedMailConfigSchema.safeParse(value);
  return parsed.success && parsed.data.transport === transport ? parsed.data : null;
}

/** The stored shape for a submitted transport (never carries the password). */
export function toStoredMail(input: MailInput): StoredMailConfig {
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
  const { sender, tenantId } = input.graph;
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
}

/** What the server environment contributes to the mail transport. */
export interface MailEnvironment {
  /** GRAPH_MAIL_TENANT_ID, used when the Graph transport names no tenant. */
  graphTenantIdDefault: string | null;
  /**
   * A usable app registration exists (environment or Settings → Microsoft 365),
   * so Graph sendMail can authenticate.
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

// --- Update plan -----------------------------------------------------------------------

export type SecretAction =
  | { action: "keep" }
  | { action: "set"; plaintext: string }
  | { action: "delete" };

export interface SettingsUpdatePlan {
  operatingMode: OperatingModeOption;
  publicUrl: string | null;
  mail: StoredMailConfig | null;
  /** What happens to the stored SMTP password. */
  secret: SecretAction;
  /** Names of the changed settings for the audit log (never secret values). */
  changes: string[];
}

type MailPlan = { mail: StoredMailConfig; secret: SecretAction } | { issue: ValidationIssue };

function planMail(input: MailInput, current: CurrentSettings, env: MailEnvironment): MailPlan {
  // A credential nothing uses any more is removed, not kept around.
  const dropPassword: SecretAction = current.smtpPasswordStored
    ? { action: "delete" }
    : { action: "keep" };

  if (input.transport === "graph") {
    if (!input.graph.tenantId && !env.graphTenantIdDefault) {
      return { issue: { path: ["mail", "graph", "tenantId"], message: "required" } };
    }
    return { mail: toStoredMail(input), secret: dropPassword };
  }

  const mail = toStoredMail(input);
  const decision = decideSmtpPassword(input.smtp, current);
  switch (decision.kind) {
    case "invalid":
      return { issue: decision.issue };
    case "provided":
      return { mail, secret: { action: "set", plaintext: decision.password } };
    case "stored":
      return { mail, secret: { action: "keep" } };
    case "none":
      return { mail, secret: dropPassword };
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

/** The changed setting names between the current state and a plan. */
export function diffSettings(
  current: CurrentSettings,
  next: Pick<SettingsUpdatePlan, "operatingMode" | "publicUrl" | "mail" | "secret">,
): string[] {
  const changes: string[] = [];
  if (current.operatingMode !== next.operatingMode) {
    changes.push("operatingMode");
  }
  if (current.publicUrl !== next.publicUrl) {
    changes.push("publicUrl");
  }
  changes.push(...diffMail(current.mail, next.mail));
  if (next.secret.action !== "keep") {
    changes.push("mail.password");
  }
  return changes;
}

/**
 * Turn a PATCH into the next stored state. Every problem is collected and
 * reported at once as a 422 with issue paths the form can attach to fields.
 *
 *   - Public mode needs a public URL; local mode stores none (it binds no domain).
 *   - A present `mail` replaces the transport. SMTP keeps the stored password
 *     only for the same host and user; switching to Graph or dropping the
 *     username deletes it.
 *   - Graph needs a tenant, either submitted or from GRAPH_MAIL_TENANT_ID.
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
  let secret: SecretAction = { action: "keep" };
  if (patch.mail) {
    const planned = planMail(patch.mail, current, env);
    if ("issue" in planned) {
      issues.push(planned.issue);
    } else {
      mail = planned.mail;
      secret = planned.secret;
    }
  }

  if (issues.length > 0) {
    throw validationProblem(issues);
  }
  const next = { operatingMode, publicUrl, mail, secret };
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
  | { transport: "graph"; graph: { sender: string; tenantId: string | null } };

export function toMailView(
  mail: StoredMailConfig | null,
  smtpPasswordStored: boolean,
): MailSettingsView {
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
        passwordStored: smtpPasswordStored,
      },
    };
  }
  return { transport: "graph", graph: { sender: mail.sender, tenantId: mail.tenantId ?? null } };
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
    mail: toMailView(input.mail, input.smtpPasswordStored),
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
