import type { FieldError } from "react-hook-form";
import { z } from "zod";

import type { MailTransport, OperatingMode, SmtpSecurity } from "@/lib/api";
import { validationKey } from "@/lib/form";
import type { InstallationSettings, MailInput, MailSettings, SettingsPatch } from "./api";

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
  "host",
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
    sender: string;
    tenantId: string;
  };
}

/** What the mail form compares against: the stored SMTP identity and the environment. */
export interface MailFormContext {
  storedSmtp: { host: string; username: string | null; passwordStored: boolean } | null;
  graphDefaultTenantId: string | null;
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

export function mailFormFromSettings(mail: MailSettings): MailFormValues {
  if (mail.transport === "smtp") {
    return {
      transport: "smtp",
      smtp: {
        host: mail.smtp.host,
        port: String(mail.smtp.port),
        security: mail.smtp.security,
        username: mail.smtp.username ?? "",
        password: "",
        from: mail.smtp.from,
      },
      graph: { sender: "", tenantId: "" },
    };
  }
  if (mail.transport === "graph") {
    return {
      transport: "graph",
      smtp: EMPTY_SMTP,
      graph: { sender: mail.graph.sender, tenantId: mail.graph.tenantId ?? "" },
    };
  }
  return { transport: "smtp", smtp: EMPTY_SMTP, graph: { sender: "", tenantId: "" } };
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

function isEmail(value: string): boolean {
  return z.string().email().safeParse(value.trim()).success;
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

function graphIssues(graph: MailFormValues["graph"], context: MailFormContext): Issue[] {
  const issues: Issue[] = [];
  if (!isEmail(graph.sender)) {
    issues.push({
      path: ["graph", "sender"],
      message: graph.sender.trim() ? "email" : "required",
    });
  }
  const tenant = graph.tenantId.trim();
  if (tenant.length > 0 && !isValidTenantId(tenant)) {
    issues.push({ path: ["graph", "tenantId"], message: "tenantId" });
  } else if (tenant.length === 0 && !context.graphDefaultTenantId) {
    issues.push({ path: ["graph", "tenantId"], message: "required" });
  }
  return issues;
}

/** Only the selected transport's fields are validated. */
export function mailFormSchema(context: MailFormContext) {
  return z
    .object({
      transport: z.enum(["smtp", "graph"]),
      smtp: z.object({
        host: z.string(),
        port: z.string(),
        security: z.enum(SMTP_SECURITY as [SmtpSecurity, ...SmtpSecurity[]]),
        username: z.string(),
        password: z.string(),
        from: z.string(),
      }),
      graph: z.object({ sender: z.string(), tenantId: z.string() }),
    })
    .superRefine((values, ctx) => {
      const issues =
        values.transport === "smtp"
          ? smtpIssues(values.smtp, context)
          : graphIssues(values.graph, context);
      for (const issue of issues) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, ...issue });
      }
    });
}

/** The API payload for validated form values; an empty password keeps the stored one. */
export function toMailInput(values: MailFormValues): MailInput {
  if (values.transport === "graph") {
    const tenantId = values.graph.tenantId.trim();
    return {
      transport: "graph",
      graph: {
        sender: values.graph.sender.trim(),
        tenantId: tenantId.length > 0 ? tenantId : null,
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
