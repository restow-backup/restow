import { z } from "zod";

import type { SetupSubmission, SmtpSecurity } from "@/lib/api";
import { PASSWORD_MIN_LENGTH } from "@/lib/password";

/**
 * Wizard form model and validation. Issue messages are short reasons that
 * `validationKey` maps to `common:validation.*` keys. Everything the wizard
 * collects lives in one form so steps can validate their own slice with
 * `trigger(...)` and the review step reads the whole picture.
 */

/**
 * The language comes first, so the whole wizard runs in the language the
 * operator reads. It lives in the app's i18n instance (the wizard's one source
 * of truth for it, also when the language switcher in the header is used), not
 * in the form; it travels with the setup request. Then the setup token: proof
 * that whoever sets up has access to the server (apps/api lib/setup-token.ts),
 * and the operator responsibility notice (apps/api lib/disclaimer.ts). Neither
 * of those is part of the form: the token travels as a header, the acceptance
 * with the setup request, and the server refuses the setup without either.
 */
export const STEP_KEYS = [
  "language",
  "token",
  "disclaimer",
  "mode",
  "admin",
  "mail",
  "review",
] as const;
export type StepKey = (typeof STEP_KEYS)[number];

/** The languages the wizard offers; the language of the operator's own organisation. */
export const SETUP_LANGUAGES = ["en", "de"] as const;
export type SetupLanguage = (typeof SETUP_LANGUAGES)[number];

const SMTP_SECURITY: readonly SmtpSecurity[] = ["starttls", "tls", "none"];

/** The longest organisation name the API accepts (the same limit as a tenant's name). */
export const ORGANISATION_NAME_MAX_LENGTH = 200;

export const DEFAULT_SMTP_PORT: Record<SmtpSecurity, string> = {
  starttls: "587",
  tls: "465",
  none: "25",
};

export const setupFormSchema = z
  .object({
    operatingMode: z.enum(["local", "public"]),
    publicUrl: z.string().trim(),
    /** The organisation that runs this installation; becomes the operator's own organisation. */
    organisationName: z
      .string()
      .trim()
      .min(1, "required")
      .max(ORGANISATION_NAME_MAX_LENGTH, "maxLength"),
    admin: z.object({
      name: z.string().trim().min(1, "required"),
      email: z.string().trim().min(1, "required").email("email"),
      password: z.string().min(PASSWORD_MIN_LENGTH, "minLength"),
      confirm: z.string(),
    }),
    mail: z.object({
      /**
       * The operator skipped this step ("Skip for now"): nothing below is validated or
       * sent, and the notification mail is set up later in the settings.
       */
      skipped: z.boolean(),
      transport: z.enum(["smtp", "graph"]),
      smtp: z.object({
        host: z.string().trim(),
        port: z.string().trim(),
        security: z.enum(SMTP_SECURITY as [SmtpSecurity, ...SmtpSecurity[]]),
        username: z.string().trim(),
        password: z.string(),
        from: z.string().trim(),
      }),
      graph: z.object({
        sender: z.string().trim(),
        tenantId: z.string().trim(),
      }),
    }),
    sendTest: z.boolean(),
  })
  .superRefine((values, ctx) => {
    if (values.operatingMode === "public") {
      const reason = publicUrlReason(values.publicUrl);
      if (reason) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["publicUrl"], message: reason });
      }
    }

    if (values.admin.password !== values.admin.confirm) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["admin", "confirm"],
        message: "passwordMismatch",
      });
    }

    if (values.mail.skipped) {
      return;
    }

    if (values.mail.transport === "smtp") {
      const { smtp } = values.mail;
      if (!smtp.host) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["mail", "smtp", "host"],
          message: "required",
        });
      }
      if (!isValidPort(smtp.port)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["mail", "smtp", "port"],
          message: "port",
        });
      }
      if (!isEmail(smtp.from)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["mail", "smtp", "from"],
          message: "email",
        });
      }
    } else if (!isEmail(values.mail.graph.sender)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mail", "graph", "sender"],
        message: "email",
      });
    }
  });

export type SetupFormValues = z.infer<typeof setupFormSchema>;

/** Which form fields each step validates before it lets the user continue. */
export const STEP_FIELDS: Record<
  Exclude<StepKey, "language" | "token" | "disclaimer" | "review">,
  readonly FieldPath[]
> = {
  mode: ["operatingMode", "publicUrl"],
  admin: ["organisationName", "admin.name", "admin.email", "admin.password", "admin.confirm"],
  mail: [
    "mail.transport",
    "mail.smtp.host",
    "mail.smtp.port",
    "mail.smtp.security",
    "mail.smtp.username",
    "mail.smtp.password",
    "mail.smtp.from",
    "mail.graph.sender",
    "mail.graph.tenantId",
  ],
};

type FieldPath =
  | "operatingMode"
  | "publicUrl"
  | "organisationName"
  | "admin.name"
  | "admin.email"
  | "admin.password"
  | "admin.confirm"
  | "mail.transport"
  | "mail.smtp.host"
  | "mail.smtp.port"
  | "mail.smtp.security"
  | "mail.smtp.username"
  | "mail.smtp.password"
  | "mail.smtp.from"
  | "mail.graph.sender"
  | "mail.graph.tenantId"
  | "sendTest";

export const defaultSetupValues: SetupFormValues = {
  operatingMode: "local",
  publicUrl: "",
  organisationName: "",
  admin: { name: "", email: "", password: "", confirm: "" },
  mail: {
    skipped: false,
    transport: "smtp",
    smtp: {
      host: "",
      port: DEFAULT_SMTP_PORT.starttls,
      security: "starttls",
      username: "",
      password: "",
      from: "",
    },
    graph: { sender: "", tenantId: "" },
  },
  sendTest: true,
};

function isEmail(value: string): boolean {
  return z.string().email().safeParse(value).success;
}

function isValidPort(value: string): boolean {
  if (!/^\d+$/.test(value)) {
    return false;
  }
  const port = Number.parseInt(value, 10);
  return port >= 1 && port <= 65535;
}

/** Reason a public URL is unusable, or `null` when it is fine. */
export function publicUrlReason(value: string): "required" | "url" | "httpsRequired" | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return "required";
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "url";
  }
  if (parsed.protocol === "https:") {
    return null;
  }
  const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  return parsed.protocol === "http:" && isLocalhost ? null : "httpsRequired";
}

/**
 * Only what the API contract needs; empty optionals are dropped, not sent.
 * `disclaimerVersion` is the version of the notice the operator accepted and
 * `language` the one chosen in the first step. A skipped mail step sends no
 * `mail` and no test message.
 */
export function buildSubmission(
  values: SetupFormValues,
  disclaimerVersion: string,
  language: SetupLanguage,
): SetupSubmission {
  const publicUrl = values.publicUrl.trim();
  const base: SetupSubmission = {
    disclaimer: { version: disclaimerVersion, accepted: true },
    operatingMode: values.operatingMode,
    providerName: values.organisationName.trim(),
    language,
    firstAdmin: {
      name: values.admin.name.trim(),
      email: values.admin.email.trim(),
      password: values.admin.password,
    },
    sendTest: values.mail.skipped ? false : values.sendTest,
  };
  if (!values.mail.skipped) {
    base.mail =
      values.mail.transport === "smtp"
        ? {
            transport: "smtp",
            smtp: {
              host: values.mail.smtp.host.trim(),
              port: Number.parseInt(values.mail.smtp.port, 10),
              security: values.mail.smtp.security,
              from: values.mail.smtp.from.trim(),
              ...(values.mail.smtp.username.trim()
                ? { username: values.mail.smtp.username.trim() }
                : {}),
              ...(values.mail.smtp.password ? { password: values.mail.smtp.password } : {}),
            },
          }
        : {
            transport: "graph",
            graph: {
              sender: values.mail.graph.sender.trim(),
              ...(values.mail.graph.tenantId.trim()
                ? { tenantId: values.mail.graph.tenantId.trim() }
                : {}),
            },
          };
  }
  if (values.operatingMode === "public" && publicUrl) {
    base.publicUrl = publicUrl.replace(/\/+$/, "");
  }
  return base;
}
