import type { FieldError } from "react-hook-form";
import { z } from "zod";

import type { MailTransport, OperatingMode, SmtpSecurity } from "@/lib/api";
import { validationKey } from "@/lib/form";
import { PASSWORD_MIN_LENGTH } from "@/lib/password";
import type {
  CredentialKind,
  GraphMailApp,
  InstallationSettings,
  MailInput,
  MailSettings,
  SettingsPatch,
} from "./api";
import { MICROSOFT_APP_FIELD_REASONS } from "./microsoft-app/presenters";

/**
 * Form models and validation for the settings sections. The rules mirror the
 * API (apps/api/src/features/settings) so problems show up at the field before
 * a request is made; the API stays authoritative and its 422 issues map onto
 * the same fields. Issue messages are short reasons, never visible text.
 */

// --- Field messages -------------------------------------------------------------------

/** Reasons with a settings-specific explanation (`settings:validation.*`). */
const FEATURE_REASONS: ReadonlySet<string> = new Set([
  "originOnly",
  "domainRequired",
  "passwordRequired",
  "usernameRequired",
  "tenantId",
  "tenantGuid",
  "serviceAccountKey",
  "host",
  "samePassword",
]);

/**
 * The i18n key (with namespace) for a field error: settings reasons map to
 * `settings:validation.*`, everything else to the shared `common:validation.*`.
 */
export function fieldMessageKey(error: FieldError | undefined): string | undefined {
  if (!error) {
    return undefined;
  }
  const reason = typeof error.message === "string" ? error.message : "";
  if (FEATURE_REASONS.has(reason)) {
    return `settings:validation.${reason}`;
  }
  // The own app registration's fields share their reasons with Installation › Microsoft 365.
  if (MICROSOFT_APP_FIELD_REASONS.has(reason)) {
    return `settings:microsoftApp.validation.${reason}`;
  }
  const key = validationKey(error);
  return key ? `common:${key}` : undefined;
}

// --- Public URL ------------------------------------------------------------------------

export type PublicUrlReason =
  | "required"
  | "url"
  | "httpsRequired"
  | "originOnly"
  | "domainRequired";

const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseUrl(value: string): URL | null {
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

/** Why a public URL cannot be saved, or null (same rules as the API). */
export function publicUrlReason(value: string): PublicUrlReason | null {
  if (value.trim().length === 0) {
    return "required";
  }
  const parsed = parseUrl(value);
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return "url";
  }
  const isLocal = LOCAL_HOSTNAMES.has(parsed.hostname);
  if (parsed.protocol === "http:" && !isLocal) {
    return "httpsRequired";
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return "originOnly";
  }
  const isIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.hostname) || parsed.hostname.startsWith("[");
  if (!isLocal && isIp) {
    return "domainRequired";
  }
  return null;
}

/** The origin a valid public URL is stored as. */
export function publicUrlOrigin(value: string): string | null {
  return publicUrlReason(value) === null ? (parseUrl(value)?.origin ?? null) : null;
}

// --- General -----------------------------------------------------------------------------

export interface GeneralFormValues {
  operatingMode: OperatingMode;
  publicUrl: string;
}

export const generalFormSchema = z
  .object({
    operatingMode: z.enum(["local", "public"]),
    publicUrl: z.string(),
  })
  .superRefine((values, ctx) => {
    if (values.operatingMode !== "public") {
      return;
    }
    const reason = publicUrlReason(values.publicUrl);
    if (reason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["publicUrl"], message: reason });
    }
  });

export function generalFormFromSettings(
  settings: Pick<InstallationSettings, "operatingMode" | "publicUrl">,
): GeneralFormValues {
  return {
    operatingMode: settings.operatingMode ?? "local",
    publicUrl: settings.publicUrl ?? "",
  };
}

/** Only what changed; null when the form matches the stored settings. */
export function toGeneralPatch(
  values: GeneralFormValues,
  settings: Pick<InstallationSettings, "operatingMode" | "publicUrl">,
): SettingsPatch | null {
  const patch: SettingsPatch = {};
  if (values.operatingMode !== settings.operatingMode) {
    patch.operatingMode = values.operatingMode;
  }
  if (values.operatingMode === "public") {
    const origin = publicUrlOrigin(values.publicUrl);
    if (origin !== null && origin !== settings.publicUrl) {
      patch.publicUrl = origin;
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Leaving public mode switches passkeys and Entra sign-in off; the UI asks first. */
export function leavesPublicMode(
  values: GeneralFormValues,
  settings: Pick<InstallationSettings, "operatingMode">,
): boolean {
  return settings.operatingMode === "public" && values.operatingMode === "local";
}

/**
 * Why a change would make the registered passkeys stop working, or null:
 * leaving public mode hides the passkey sign-in, and a public URL on another
 * host name is another WebAuthn relying party, for which no passkey exists.
 * A new port or scheme on the same host keeps the passkeys.
 */
export type PasskeyLoss = "leave_public" | "host_change";

export function passkeyLoss(
  values: GeneralFormValues,
  settings: Pick<InstallationSettings, "operatingMode" | "publicUrl">,
): PasskeyLoss | null {
  if (leavesPublicMode(values, settings)) {
    return "leave_public";
  }
  if (settings.operatingMode !== "public" || values.operatingMode !== "public") {
    return null;
  }
  const before = settings.publicUrl ? parseUrl(settings.publicUrl)?.hostname : undefined;
  const origin = publicUrlOrigin(values.publicUrl);
  const after = origin ? parseUrl(origin)?.hostname : undefined;
  return before && after && before !== after ? "host_change" : null;
}

// --- Mail ---------------------------------------------------------------------------------

export const SMTP_SECURITY: readonly SmtpSecurity[] = ["starttls", "tls", "none"];

export const DEFAULT_SMTP_PORT: Record<SmtpSecurity, string> = {
  starttls: "587",
  tls: "465",
  none: "25",
};

export interface MailFormValues {
  transport: MailTransport;
  smtp: {
    host: string;
    port: string;
    security: SmtpSecurity;
    username: string;
    password: string;
    from: string;
  };
  graph: {
    /** The notification mail's own app registration, or the backup app. */
    app: GraphMailApp;
    sender: string;
    tenantId: string;
    clientId: string;
    credentialKind: CredentialKind;
    /** Write-only: empty keeps the stored secret (same tenant, app and kind). */
    clientSecret: string;
    /** Write-only: empty keeps the stored certificate (same tenant, app and kind). */
    certificatePem: string;
  };
  google: {
    sender: string;
    /** Write-only: the service account's JSON key; empty keeps the stored one. */
    serviceAccountKey: string;
  };
}

/** What the mail form compares against: the stored credentials' identity and the environment. */
export interface MailFormContext {
  storedSmtp: { host: string; username: string | null; passwordStored: boolean } | null;
  graphDefaultTenantId: string | null;
  /** The backup app registration is usable, so Graph can send as it. */
  graphBackupAppConfigured: boolean;
  /** The own app as stored, when Graph sends as it. */
  storedGraphOwn: {
    tenantId: string;
    clientId: string;
    credentialKind: CredentialKind;
    credentialStored: boolean;
  } | null;
  /** A Google service account key is stored for the Google transport. */
  googleKeyStored: boolean;
}

export function mailFormContext(settings: InstallationSettings): MailFormContext {
  const { mail } = settings;
  return {
    storedSmtp:
      mail.transport === "smtp"
        ? {
            host: mail.smtp.host,
            username: mail.smtp.username,
            passwordStored: mail.smtp.passwordStored,
          }
        : null,
    graphDefaultTenantId: settings.capabilities.graphMail.defaultTenantId,
    graphBackupAppConfigured: settings.capabilities.graphMail.appConfigured,
    storedGraphOwn:
      mail.transport === "graph" && mail.graph.app === "own" && mail.graph.ownApp
        ? {
            tenantId: mail.graph.tenantId ?? "",
            clientId: mail.graph.ownApp.clientId,
            credentialKind: mail.graph.ownApp.credentialKind,
            credentialStored: mail.graph.ownApp.credentialStored,
          }
        : null,
    googleKeyStored: mail.transport === "google" && mail.google.keyStored,
  };
}

const EMPTY_SMTP: MailFormValues["smtp"] = {
  host: "",
  port: DEFAULT_SMTP_PORT.starttls,
  security: "starttls",
  username: "",
  password: "",
  from: "",
};

/** A new Microsoft 365 transport starts with an own app registration (the recommended way). */
const EMPTY_GRAPH: MailFormValues["graph"] = {
  app: "own",
  sender: "",
  tenantId: "",
  clientId: "",
  credentialKind: "secret",
  clientSecret: "",
  certificatePem: "",
};

const EMPTY_GOOGLE: MailFormValues["google"] = { sender: "", serviceAccountKey: "" };

export function mailFormFromSettings(mail: MailSettings): MailFormValues {
  const empty = { smtp: EMPTY_SMTP, graph: EMPTY_GRAPH, google: EMPTY_GOOGLE };
  if (mail.transport === "smtp") {
    return {
      ...empty,
      transport: "smtp",
      smtp: {
        host: mail.smtp.host,
        port: String(mail.smtp.port),
        security: mail.smtp.security,
        username: mail.smtp.username ?? "",
        password: "",
        from: mail.smtp.from,
      },
    };
  }
  if (mail.transport === "graph") {
    return {
      ...empty,
      transport: "graph",
      graph: {
        ...EMPTY_GRAPH,
        app: mail.graph.app,
        sender: mail.graph.sender,
        tenantId: mail.graph.tenantId ?? "",
        clientId: mail.graph.ownApp?.clientId ?? "",
        credentialKind: mail.graph.ownApp?.credentialKind ?? "secret",
      },
    };
  }
  if (mail.transport === "google") {
    return {
      ...empty,
      transport: "google",
      google: { sender: mail.google.sender, serviceAccountKey: "" },
    };
  }
  return { ...empty, transport: "smtp" };
}

function sameHost(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The stored password is only reused for the host and username it was saved
 * for; changing either needs it again (the API enforces the same rule).
 */
export function mayKeepStoredPassword(
  smtp: Pick<MailFormValues["smtp"], "host" | "username">,
  stored: MailFormContext["storedSmtp"],
): boolean {
  if (!stored?.passwordStored) {
    return false;
  }
  const username = smtp.username.trim();
  return (
    sameHost(smtp.host, stored.host) && (username.length > 0 ? username : null) === stored.username
  );
}

/**
 * The own app's stored secret or certificate is only reused for the tenant,
 * application ID and credential kind it was saved for (the API enforces the
 * same rule).
 */
export function mayKeepGraphCredential(
  graph: Pick<MailFormValues["graph"], "tenantId" | "clientId" | "credentialKind">,
  stored: MailFormContext["storedGraphOwn"],
): boolean {
  return (
    stored?.credentialStored === true &&
    sameHost(graph.tenantId, stored.tenantId) &&
    sameHost(graph.clientId, stored.clientId) &&
    graph.credentialKind === stored.credentialKind
  );
}

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6 = /^[0-9a-f:.]+$/i;

export function isValidHost(value: string): boolean {
  const host = value.trim();
  if (host.length === 0 || host.length > 253) {
    return false;
  }
  return HOSTNAME.test(host) || IPV4.test(host) || (host.includes(":") && IPV6.test(host));
}

export function isValidPort(value: string): boolean {
  if (!/^\d{1,5}$/.test(value.trim())) {
    return false;
  }
  const port = Number(value);
  return port >= 1 && port <= 65535;
}

const TENANT_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_DOMAIN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** An Entra tenant id (GUID) or verified domain. */
export function isValidTenantId(value: string): boolean {
  const tenant = value.trim();
  return TENANT_GUID.test(tenant) || TENANT_DOMAIN.test(tenant);
}

export function isGuid(value: string): boolean {
  return TENANT_GUID.test(value.trim());
}

function isEmail(value: string): boolean {
  return z.string().email().safeParse(value.trim()).success;
}

/** The public facts of a pasted service account key, or null when it is not one. */
export interface ServiceAccountKeyPreview {
  clientEmail: string;
  clientId: string;
}

/**
 * Read what the guide needs (the client ID for the domain-wide delegation)
 * from a pasted key, without keeping the private key anywhere but the field.
 * The API checks the key itself again.
 */
export function previewServiceAccountKey(text: string): ServiceAccountKeyPreview | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const { type, client_email: clientEmail, client_id: clientId, private_key: key } = value;
  if (
    type !== "service_account" ||
    typeof clientEmail !== "string" ||
    !isEmail(clientEmail) ||
    typeof clientId !== "string" ||
    !/^\d{6,30}$/.test(clientId) ||
    typeof key !== "string" ||
    !key.includes("PRIVATE KEY")
  ) {
    return null;
  }
  return { clientEmail, clientId };
}

type Issue = { path: (string | number)[]; message: string };

function smtpIssues(smtp: MailFormValues["smtp"], context: MailFormContext): Issue[] {
  const issues: Issue[] = [];
  if (!isValidHost(smtp.host)) {
    issues.push({ path: ["smtp", "host"], message: smtp.host.trim() ? "host" : "required" });
  }
  if (!isValidPort(smtp.port)) {
    issues.push({ path: ["smtp", "port"], message: "port" });
  }
  if (!isEmail(smtp.from)) {
    issues.push({ path: ["smtp", "from"], message: smtp.from.trim() ? "email" : "required" });
  }
  const hasUsername = smtp.username.trim().length > 0;
  if (!hasUsername && smtp.password.length > 0) {
    issues.push({ path: ["smtp", "username"], message: "usernameRequired" });
  }
  if (
    hasUsername &&
    smtp.password.length === 0 &&
    !mayKeepStoredPassword(smtp, context.storedSmtp)
  ) {
    issues.push({ path: ["smtp", "password"], message: "passwordRequired" });
  }
  return issues;
}

function ownAppIssues(graph: MailFormValues["graph"], context: MailFormContext): Issue[] {
  const issues: Issue[] = [];
  const tenant = graph.tenantId.trim();
  if (tenant.length === 0) {
    issues.push({ path: ["graph", "tenantId"], message: "required" });
  } else if (!isGuid(tenant)) {
    issues.push({ path: ["graph", "tenantId"], message: "tenantGuid" });
  }
  const clientId = graph.clientId.trim();
  if (!isGuid(clientId)) {
    issues.push({ path: ["graph", "clientId"], message: clientId ? "guid" : "required" });
  }
  const field = graph.credentialKind === "secret" ? "clientSecret" : "certificatePem";
  const supplied = graph[field].trim();
  if (supplied.length === 0 && !mayKeepGraphCredential(graph, context.storedGraphOwn)) {
    issues.push({ path: ["graph", field], message: "credentialRequired" });
  } else if (field === "clientSecret" && isGuid(supplied)) {
    issues.push({ path: ["graph", field], message: "secretIsId" });
  }
  return issues;
}

function graphIssues(graph: MailFormValues["graph"], context: MailFormContext): Issue[] {
  const issues: Issue[] = [];
  if (!isEmail(graph.sender)) {
    issues.push({
      path: ["graph", "sender"],
      message: graph.sender.trim() ? "email" : "required",
    });
  }
  if (graph.app === "own") {
    return [...issues, ...ownAppIssues(graph, context)];
  }
  const tenant = graph.tenantId.trim();
  if (tenant.length > 0 && !isValidTenantId(tenant)) {
    issues.push({ path: ["graph", "tenantId"], message: "tenantId" });
  } else if (tenant.length === 0 && !context.graphDefaultTenantId) {
    issues.push({ path: ["graph", "tenantId"], message: "required" });
  }
  return issues;
}

function googleIssues(google: MailFormValues["google"], context: MailFormContext): Issue[] {
  const issues: Issue[] = [];
  if (!isEmail(google.sender)) {
    issues.push({
      path: ["google", "sender"],
      message: google.sender.trim() ? "email" : "required",
    });
  }
  const key = google.serviceAccountKey.trim();
  if (key.length === 0) {
    if (!context.googleKeyStored) {
      issues.push({ path: ["google", "serviceAccountKey"], message: "required" });
    }
  } else if (!previewServiceAccountKey(key)) {
    issues.push({ path: ["google", "serviceAccountKey"], message: "serviceAccountKey" });
  }
  return issues;
}

/** Only the selected transport's fields are validated. */
export function mailFormSchema(context: MailFormContext) {
  return z
    .object({
      transport: z.enum(["smtp", "graph", "google"]),
      smtp: z.object({
        host: z.string(),
        port: z.string(),
        security: z.enum(SMTP_SECURITY as [SmtpSecurity, ...SmtpSecurity[]]),
        username: z.string(),
        password: z.string(),
        from: z.string(),
      }),
      graph: z.object({
        app: z.enum(["backup", "own"]),
        sender: z.string(),
        tenantId: z.string(),
        clientId: z.string(),
        credentialKind: z.enum(["secret", "certificate"]),
        clientSecret: z.string(),
        certificatePem: z.string(),
      }),
      google: z.object({ sender: z.string(), serviceAccountKey: z.string() }),
    })
    .superRefine((values, ctx) => {
      const issues =
        values.transport === "smtp"
          ? smtpIssues(values.smtp, context)
          : values.transport === "graph"
            ? graphIssues(values.graph, context)
            : googleIssues(values.google, context);
      for (const issue of issues) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, ...issue });
      }
    });
}

/** The API payload for validated form values; an empty secret keeps the stored one. */
export function toMailInput(values: MailFormValues): MailInput {
  if (values.transport === "graph") {
    const { graph } = values;
    const tenantId = graph.tenantId.trim();
    const base = {
      sender: graph.sender.trim(),
      tenantId: tenantId.length > 0 ? tenantId : null,
    };
    if (graph.app === "backup") {
      return { transport: "graph", graph: { ...base, app: "backup" } };
    }
    const clientSecret = graph.clientSecret.trim();
    const certificatePem = graph.certificatePem.trim();
    return {
      transport: "graph",
      graph: {
        ...base,
        app: "own",
        ownApp: {
          clientId: graph.clientId.trim(),
          credentialKind: graph.credentialKind,
          ...(graph.credentialKind === "secret" && clientSecret ? { clientSecret } : {}),
          ...(graph.credentialKind === "certificate" && certificatePem ? { certificatePem } : {}),
        },
      },
    };
  }
  if (values.transport === "google") {
    const key = values.google.serviceAccountKey.trim();
    return {
      transport: "google",
      google: {
        sender: values.google.sender.trim(),
        ...(key.length > 0 ? { serviceAccountKey: key } : {}),
      },
    };
  }
  const { smtp } = values;
  const username = smtp.username.trim();
  return {
    transport: "smtp",
    smtp: {
      host: smtp.host.trim(),
      port: Number(smtp.port.trim()),
      security: smtp.security,
      from: smtp.from.trim(),
      username: username.length > 0 ? username : null,
      ...(smtp.password.length > 0 ? { password: smtp.password } : {}),
    },
  };
}

/** Follow the conventional port unless the admin typed their own. */
export function portForSecurity(currentPort: string, next: SmtpSecurity): string {
  const port = currentPort.trim();
  const isDefault = Object.values(DEFAULT_SMTP_PORT).includes(port);
  return isDefault || port.length === 0 ? DEFAULT_SMTP_PORT[next] : currentPort;
}

// --- Test message -------------------------------------------------------------------------

export interface MailTestFormValues {
  recipient: string;
}

export const mailTestFormSchema = z.object({
  recipient: z.string().trim().min(1, "required").email("email"),
});

// --- Passkey name ----------------------------------------------------------------------------

export const PASSKEY_NAME_MAX_LENGTH = 64;

export interface PasskeyNameValues {
  name: string;
}

export const passkeyNameSchema = z.object({
  name: z.string().trim().min(1, "required").max(PASSKEY_NAME_MAX_LENGTH, "required"),
});

// --- Authenticator --------------------------------------------------------------------------

export interface PasswordConfirmValues {
  password: string;
}

/** Changes to the second factor are confirmed with the account password. */
export const passwordConfirmSchema = z.object({
  password: z.string().min(1, "required"),
});

export interface ChangePasswordValues {
  current: string;
  password: string;
  confirm: string;
  revokeOtherSessions: boolean;
}

/**
 * The own password: the current one, a new one of at least
 * {@link PASSWORD_MIN_LENGTH} characters that differs from it, typed twice.
 */
export const changePasswordSchema = z
  .object({
    current: z.string().min(1, "required"),
    password: z.string().min(PASSWORD_MIN_LENGTH, "minLength"),
    confirm: z.string(),
    revokeOtherSessions: z.boolean(),
  })
  .superRefine((values, ctx) => {
    if (values.password !== values.confirm) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["confirm"], message: "passwordMismatch" });
    }
    if (values.password !== "" && values.password === values.current) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["password"], message: "samePassword" });
    }
  });

export interface TotpCodeValues {
  code: string;
}

export const TOTP_CODE_LENGTH = 6;

/** The current six-digit code; spaces typed or pasted from an authenticator app are ignored. */
export const totpCodeSchema = z.object({
  code: z
    .string()
    .transform((value) => value.replace(/\s+/g, ""))
    .pipe(z.string().regex(/^\d{6}$/, "totp")),
});

// --- API issues --------------------------------------------------------------------------------

export interface FieldIssue {
  /** Field path in the form, e.g. `smtp.password`. */
  field: string;
  reason: string;
}

/**
 * The field-level issues of a 422 problem, re-rooted onto a form: the API's
 * `["mail", "smtp", "password"]` becomes `smtp.password` for the mail form
 * (prefix `mail`). Issues outside the prefix are left out.
 */
export function problemFieldIssues(error: unknown, prefix: readonly string[] = []): FieldIssue[] {
  if (typeof error !== "object" || error === null) {
    return [];
  }
  const problem = (error as { status?: unknown; problem?: unknown }).problem;
  const status = (error as { status?: unknown }).status;
  if (status !== 422 || typeof problem !== "object" || problem === null) {
    return [];
  }
  const issues = (problem as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) {
    return [];
  }
  const result: FieldIssue[] = [];
  for (const issue of issues) {
    const path = (issue as { path?: unknown }).path;
    const message = (issue as { message?: unknown }).message;
    if (!Array.isArray(path) || typeof message !== "string") {
      continue;
    }
    const segments = path.map(String);
    const inPrefix = prefix.every((segment, index) => segments[index] === segment);
    if (!inPrefix || segments.length <= prefix.length) {
      continue;
    }
    result.push({ field: segments.slice(prefix.length).join("."), reason: message });
  }
  return result;
}
