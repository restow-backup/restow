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
 * The setup token comes first: proof that whoever sets up has access to the
 * server (apps/api lib/setup-token.ts). Then the operator responsibility
 * notice (apps/api lib/disclaimer.ts). Neither is part of the form: the token
 * travels as a header, the acceptance with the setup request, and the server
 * refuses the setup without either.
 */
export const STEP_KEYS = ["token", "disclaimer", "mode", "admin", "mail", "review"] as const;
export type StepKey = (typeof STEP_KEYS)[number];

const SMTP_SECURITY: readonly SmtpSecurity[] = ["starttls", "tls", "none"];

export const DEFAULT_SMTP_PORT: Record<SmtpSecurity, string> = {
  starttls: "587",
  tls: "465",
  none: "25",
};

export const setupFormSchema = z
  .object({
    operatingMode: z.enum(["local", "public"]),
    publicUrl: z.string().trim(),
    admin: z.object({
      name: z.string().trim().min(1, "required"),
      email: z.string().trim().min(1, "required").email("email"),
      password: z.string().min(PASSWORD_MIN_LENGTH, "minLength"),
      confirm: z.string(),
    }),
    mail: z.object({
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
  Exclude<StepKey, "token" | "disclaimer" | "review">,
  readonly FieldPath[]
> = {
  mode: ["operatingMode", "publicUrl"],
  admin: ["admin.name", "admin.email", "admin.password", "admin.confirm"],
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
  admin: { name: "", email: "", password: "", confirm: "" },
  mail: {
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
 * `disclaimerVersion` is the version of the notice the operator accepted.
 */
export function buildSubmission(
  values: SetupFormValues,
  disclaimerVersion: string,
): SetupSubmission {
  const publicUrl = values.publicUrl.trim();
  const base: SetupSubmission = {
    disclaimer: { version: disclaimerVersion, accepted: true },
    operatingMode: values.operatingMode,
    firstAdmin: {
      name: values.admin.name.trim(),
      email: values.admin.email.trim(),
      password: values.admin.password,
    },
    mail:
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
          },
    sendTest: values.sendTest,
  };
  if (values.operatingMode === "public" && publicUrl) {
    base.publicUrl = publicUrl.replace(/\/+$/, "");
  }
  return base;
}
