import type { FieldError } from "react-hook-form";
import { z } from "zod";

import { validationKey } from "@/lib/form";
import type {
  CreateImapSourceInput,
  CreateM365SourceInput,
  ImapAuthMode,
  ImapSecurity,
  ImapTestInput,
  MasterUserInput,
  UpdateSourceInput,
} from "./types";

/**
 * Form models and validation for the source dialogs. Issue messages are short
 * reasons: the common ones (`required`, `port`, ...) map to `common:validation.*`
 * through `validationKey`; feature-specific reasons (`host`, `tenantHint`,
 * `groupId`, `passwordAgain`) map to `sources:validation.*`. Nothing here
 * produces visible text.
 */

export const IMAP_SECURITY: readonly ImapSecurity[] = ["tls", "starttls", "none"];

/** Conventional port per security mode (mirrors the API's DEFAULT_IMAP_PORT). */
export const DEFAULT_IMAP_PORT: Record<ImapSecurity, string> = {
  tls: "993",
  starttls: "143",
  none: "143",
};

const FEATURE_REASONS = new Set([
  "host",
  "tenantHint",
  "groupId",
  "passwordAgain",
  "masterUsername",
]);

/**
 * The i18n key for a field error: a fully qualified key set from an API
 * problem (`sources:errors.*`) as is, `sources:validation.*` for feature
 * reasons, else the shared `common:validation.*` key.
 */
export function fieldMessageKey(error: FieldError | undefined): string | undefined {
  if (!error) {
    return undefined;
  }
  const reason = typeof error.message === "string" ? error.message : "";
  if (/^[a-z]+:[\w.]+$/i.test(reason)) {
    return reason;
  }
  if (FEATURE_REASONS.has(reason)) {
    return `sources:validation.${reason}`;
  }
  const key = validationKey(error);
  return key ? `common:${key}` : undefined;
}

// --- IMAP -----------------------------------------------------------------------

const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6 = /^[0-9a-f:]+$/i;

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

export const IMAP_AUTH_MODES: readonly ImapAuthMode[] = ["shared", "per_mailbox", "master_user"];
export const MASTER_USER_STYLES = ["dovecot_separator", "sasl_authzid"] as const;

export interface ImapFormValues {
  name: string;
  host: string;
  port: string;
  security: ImapSecurity;
  username: string;
  password: string;
  imapAuthMode: ImapAuthMode;
  masterUsername: string;
  masterUserStyle: (typeof MASTER_USER_STYLES)[number];
  masterUserSeparator: string;
}

/** What the edit form compares against: the stored connection. */
export interface StoredImapConnection {
  name: string;
  host: string;
  port: number;
  security: ImapSecurity;
  username: string;
  imapAuthMode: ImapAuthMode;
  masterUser: MasterUserInput | null;
}

export const emptyImapForm: ImapFormValues = {
  name: "",
  host: "",
  port: DEFAULT_IMAP_PORT.tls,
  security: "tls",
  username: "",
  password: "",
  imapAuthMode: "shared",
  masterUsername: "",
  masterUserStyle: "dovecot_separator",
  masterUserSeparator: "",
};

export function imapFormFromStored(stored: StoredImapConnection): ImapFormValues {
  return {
    name: stored.name,
    host: stored.host,
    port: String(stored.port),
    security: stored.security,
    username: stored.username,
    password: "",
    imapAuthMode: stored.imapAuthMode,
    masterUsername: stored.masterUser?.username ?? "",
    masterUserStyle: stored.masterUser?.style ?? "dovecot_separator",
    masterUserSeparator: stored.masterUser?.separator ?? "",
  };
}

function sameHost(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * A stored password is only ever used for the host and username it was saved
 * for (the API enforces the same rule); changing either needs it again.
 */
export function needsPasswordAgain(
  values: Pick<ImapFormValues, "host" | "username">,
  stored: Pick<StoredImapConnection, "host" | "username"> | null,
): boolean {
  if (!stored) {
    return true;
  }
  return !sameHost(values.host, stored.host) || values.username.trim() !== stored.username;
}

/**
 * `create` requires a password unless the mode is `per_mailbox` (every
 * mailbox seals its own instead); `edit` keeps the stored one unless host or
 * username change. `master_user` also needs the master account's login.
 */
export function imapFormSchema(stored: StoredImapConnection | null) {
  return z
    .object({
      name: z.string().trim().min(1, "required"),
      host: z.string().trim().refine(isValidHost, "host"),
      port: z.string().trim().refine(isValidPort, "port"),
      security: z.enum(IMAP_SECURITY as [ImapSecurity, ...ImapSecurity[]]),
      username: z.string().trim().min(1, "required"),
      password: z.string(),
      imapAuthMode: z.enum(IMAP_AUTH_MODES as [ImapAuthMode, ...ImapAuthMode[]]),
      masterUsername: z.string().trim(),
      masterUserStyle: z.enum(MASTER_USER_STYLES),
      masterUserSeparator: z.string().trim(),
    })
    .superRefine((values, ctx) => {
      if (values.imapAuthMode === "master_user" && values.masterUsername.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["masterUsername"],
          message: "masterUsername",
        });
      }
      if (
        values.imapAuthMode === "per_mailbox" ||
        values.password.length > 0 ||
        !needsPasswordAgain(values, stored)
      ) {
        return;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["password"],
        message: stored ? "passwordAgain" : "required",
      });
    });
}

function masterUserFromValues(values: ImapFormValues): MasterUserInput | undefined {
  if (values.imapAuthMode !== "master_user") {
    return undefined;
  }
  const separator = values.masterUserSeparator.trim();
  return {
    username: values.masterUsername.trim(),
    style: values.masterUserStyle,
    ...(separator.length > 0 ? { separator } : {}),
  };
}

/** The create payload from validated form values. */
export function toCreateImapInput(values: ImapFormValues): CreateImapSourceInput {
  const masterUser = masterUserFromValues(values);
  return {
    kind: "imap",
    name: values.name.trim(),
    host: values.host.trim(),
    port: Number(values.port),
    security: values.security,
    username: values.username.trim(),
    imapAuthMode: values.imapAuthMode,
    // No password of its own for per_mailbox: every mailbox seals its own instead.
    ...(values.imapAuthMode !== "per_mailbox" ? { password: values.password } : {}),
    ...(masterUser ? { masterUser } : {}),
  };
}

/**
 * The inline test payload: the typed password, or (editing, same host and
 * username) the stored one by source id. Null when a password is needed first.
 *
 * `master_user` logs in as the master account, not `values.username` (a
 * label only, see `usernameHintMasterUser`): without a saved source there is
 * no mailbox to impersonate yet, so this runs the same bare master login
 * `testSource` (apps/api/src/features/sources/service.ts) falls back to
 * before any mailbox exists, a weaker connectivity check than the real
 * per-mailbox login the worker uses, but the only one available pre-save.
 * Null when the master username is not filled in yet.
 */
export function toImapTestInput(
  values: ImapFormValues,
  stored: { sourceId: string; connection: StoredImapConnection } | null,
): ImapTestInput | null {
  const loginUsername =
    values.imapAuthMode === "master_user" ? values.masterUsername.trim() : values.username.trim();
  if (values.imapAuthMode === "master_user" && loginUsername.length === 0) {
    return null;
  }
  const connection = {
    host: values.host.trim(),
    port: Number(values.port),
    security: values.security,
    username: loginUsername,
  };
  if (values.password.length > 0) {
    return { ...connection, password: values.password };
  }
  if (
    values.imapAuthMode !== "master_user" &&
    stored &&
    !needsPasswordAgain(values, stored.connection)
  ) {
    return { ...connection, sourceId: stored.sourceId };
  }
  return null;
}

/** Only the fields that differ from the stored source; an empty password keeps the old one. */
export function toUpdateImapInput(
  values: ImapFormValues,
  current: StoredImapConnection,
): UpdateSourceInput {
  const patch: UpdateSourceInput = {};
  const name = values.name.trim();
  const host = values.host.trim();
  const port = Number(values.port);
  const username = values.username.trim();
  if (name !== current.name) {
    patch.name = name;
  }
  if (!sameHost(host, current.host)) {
    patch.host = host;
  }
  if (port !== current.port) {
    patch.port = port;
  }
  if (values.security !== current.security) {
    patch.security = values.security;
  }
  if (username !== current.username) {
    patch.username = username;
  }
  // No password of its own for per_mailbox: every mailbox seals its own instead.
  // A password typed while a different mode was selected must not leak into
  // the patch once the mode is switched to per_mailbox before saving.
  if (values.password.length > 0 && values.imapAuthMode !== "per_mailbox") {
    patch.password = values.password;
  }
  if (values.imapAuthMode !== current.imapAuthMode) {
    patch.imapAuthMode = values.imapAuthMode;
  }
  const masterUser = masterUserFromValues(values) ?? null;
  const currentMasterUser = current.masterUser;
  const masterUserChanged =
    (masterUser === null) !== (currentMasterUser === null) ||
    (masterUser !== null &&
      currentMasterUser !== null &&
      (masterUser.username !== currentMasterUser.username ||
        masterUser.style !== currentMasterUser.style ||
        (masterUser.separator ?? "") !== (currentMasterUser.separator ?? "")));
  if (masterUserChanged) {
    patch.masterUser = masterUser;
  }
  return patch;
}

/** Follow the conventional port when the user has not typed their own. */
export function portForSecurity(currentPort: string, next: ImapSecurity): string {
  const isDefault = Object.values(DEFAULT_IMAP_PORT).includes(currentPort.trim());
  return isDefault || currentPort.trim().length === 0 ? DEFAULT_IMAP_PORT[next] : currentPort;
}

// --- Microsoft 365 ----------------------------------------------------------------

const TENANT_HINT =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i;

/** Empty (let the admin pick), a tenant id (GUID) or a verified domain. */
export function isValidTenantHint(value: string): boolean {
  const hint = value.trim();
  return hint.length === 0 || (hint.length <= 253 && TENANT_HINT.test(hint));
}

export interface M365FormValues {
  name: string;
  entraTenantHint: string;
  scopeMode: "all" | "group";
  groupId: string;
}

export const emptyM365Form: M365FormValues = {
  name: "",
  entraTenantHint: "",
  scopeMode: "all",
  groupId: "",
};

export const m365FormSchema = z
  .object({
    name: z.string().trim().min(1, "required"),
    entraTenantHint: z.string().trim().refine(isValidTenantHint, "tenantHint"),
    scopeMode: z.enum(["all", "group"]),
    groupId: z.string().trim(),
  })
  .superRefine((values, ctx) => {
    if (values.scopeMode === "group" && values.groupId.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["groupId"], message: "groupId" });
    }
  });

export function toCreateM365Input(values: M365FormValues): CreateM365SourceInput {
  const hint = values.entraTenantHint.trim();
  return {
    kind: "m365",
    name: values.name.trim(),
    ...(hint.length > 0 ? { entraTenantHint: hint } : {}),
    scope:
      values.scopeMode === "group"
        ? { mode: "group", groupId: values.groupId.trim(), exclude: [] }
        : { mode: "all", exclude: [] },
  };
}

/** Editing an M365 source: its name, and the consent target while it is not connected yet. */
export interface M365EditValues {
  name: string;
  entraTenantHint: string;
}

export const m365EditSchema = z.object({
  name: z.string().trim().min(1, "required"),
  entraTenantHint: z.string().trim().refine(isValidTenantHint, "tenantHint"),
});

export function toUpdateM365Input(
  values: M365EditValues,
  current: { name: string; entraTenantHint: string | null; connected: boolean },
): UpdateSourceInput {
  const patch: UpdateSourceInput = {};
  const name = values.name.trim();
  if (name !== current.name) {
    patch.name = name;
  }
  if (!current.connected) {
    const hint = values.entraTenantHint.trim();
    if (hint !== (current.entraTenantHint ?? "")) {
      patch.entraTenantHint = hint.length > 0 ? hint : null;
    }
  }
  return patch;
}

const MICROSOFT_IMAP_HOSTS: ReadonlySet<string> = new Set([
  "outlook.office365.com",
  "outlook.office.com",
  "imap-mail.outlook.com",
]);

/**
 * Whether `host` is one of Microsoft's IMAP endpoints for Outlook.com and
 * Microsoft 365, which refuse password sign-in (OAuth2 only). Case and
 * surrounding whitespace do not matter.
 */
export function isMicrosoftImapHost(host: string): boolean {
  return MICROSOFT_IMAP_HOSTS.has(host.trim().toLowerCase().replace(/\.$/, ""));
}
