import { type AppCredentials, addressOf, isPlainEmail } from "@restow/core";
import type { SupportedLanguage } from "@restow/i18n";
import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "./config.js";
import {
  errorMessage,
  failed,
  type MailFailureReason,
  type NotificationMessage,
  type Notifier,
  type NotifyResult,
  singleLine,
  testNotification,
} from "./notify-core.js";
import { GoogleNotifier, type GoogleServiceAccountKey } from "./notify-google.js";
import { type GraphMailApp, GraphNotifier } from "./notify-graph.js";

export {
  isTransportFailureReason,
  MAIL_FAILURE_REASONS,
  type MailAttachment,
  type MailFailureReason,
  type NotificationMessage,
  type Notifier,
  type NotifyResult,
  testNotification,
} from "./notify-core.js";
export { GoogleNotifier } from "./notify-google.js";
export { GraphNotifier } from "./notify-graph.js";

/**
 * Notification transport (docs/ARCHITECTURE.md, notification mail service).
 *
 * One interface, three implementations:
 *   - `smtp`   — nodemailer over an operator-provided SMTP server.
 *   - `graph`  — Microsoft 365: Graph `sendMail` as an app (client credentials,
 *                application permission `Mail.Send`, notify-graph.ts). The app
 *                registration is the operator's own one for notifications or
 *                the backup app's, resolved by the caller.
 *   - `google` — Google Workspace: the Gmail API as a service account with
 *                domain-wide delegation (notify-google.ts).
 *
 * Every failure carries a reason code the UI explains in the operator's
 * language (notify-core.ts); the transport's own message is only a detail.
 * The separate SMTP *journal receiver* (archive) only ever receives; it never
 * sends and is not this module.
 */

/**
 * Demo mode (deploy/demo/README.md): nothing the demo does may leave the
 * server, so no notification is ever actually sent. Logged, so a missing
 * mail in the demo is visibly "skipped: demo mode", not a silent failure.
 */
export class NoopNotifier implements Notifier {
  async send(message: NotificationMessage): Promise<NotifyResult> {
    console.log(
      JSON.stringify({
        level: "info",
        message: "demo mode: notification not sent",
        to: message.to,
        subject: message.subject,
      }),
    );
    return { ok: true };
  }

  async sendTest(to: string, language: SupportedLanguage): Promise<NotifyResult> {
    return this.send({ ...testNotification(language), to });
  }
}

/** Bounded waits, so a test send or notification never hangs on an unreachable server. */
export const SMTP_TIMEOUTS = {
  connectionTimeout: 15_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
} as const;

/**
 * nodemailer options for an SMTP configuration. An explicit `starttls` choice
 * requires the upgrade (a server or attacker that strips STARTTLS cannot make
 * Restow send credentials in the clear), `none` never upgrades, `implicit`
 * speaks TLS from the first byte. Without an explicit choice (environment
 * configuration) STARTTLS is used whenever the server offers it.
 */
export function smtpTransportOptions(smtp: Config["smtp"]) {
  const implicit =
    smtp.security !== undefined ? smtp.security === "implicit" : smtp.secure || smtp.port === 465;
  return {
    host: smtp.host,
    port: smtp.port,
    secure: implicit,
    requireTLS: !implicit && smtp.security === "starttls",
    ignoreTLS: !implicit && smtp.security === "none",
    auth: smtp.username ? { user: smtp.username, pass: smtp.password } : undefined,
    ...SMTP_TIMEOUTS,
  };
}

const SMTP_CONNECTION_CODES: ReadonlySet<string> = new Set([
  "ECONNECTION",
  "ETIMEDOUT",
  "ESOCKET",
  "EDNS",
  "ECONNREFUSED",
  "EGREETING",
]);

const TLS_WORDING = /certificate|self[- ]signed|\bTLS\b|\bSSL\b|wrong version number/i;

/** Map a nodemailer error onto a reason (its `code`, and the TLS wording of socket errors). */
export function smtpFailureReason(err: unknown): MailFailureReason {
  const code =
    typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  if (code === "EAUTH") {
    return "smtp_auth_failed";
  }
  if (code === "ETLS" || TLS_WORDING.test(errorMessage(err))) {
    return "smtp_tls_failed";
  }
  if (typeof code === "string" && SMTP_CONNECTION_CODES.has(code)) {
    return "smtp_connection_failed";
  }
  return "transport_error";
}

/** SMTP answers that refuse a recipient or the message for good. */
const PERMANENT_SMTP_CODES: ReadonlySet<number> = new Set([550, 551, 553, 554]);

function smtpErrorFields(err: unknown): {
  responseCode?: unknown;
  command: string;
  code?: unknown;
  /** The server's reply and the error's message, where the reply's wording is found. */
  text: string;
} {
  if (typeof err !== "object" || err === null) {
    return { command: "", text: "" };
  }
  const { responseCode, command, code, response } = err as {
    responseCode?: unknown;
    command?: unknown;
    code?: unknown;
    response?: unknown;
  };
  return {
    responseCode,
    code,
    command: typeof command === "string" ? command.toUpperCase() : "",
    text: `${typeof response === "string" ? response : ""}\n${errorMessage(err)}`,
  };
}

/**
 * The wording of a server that refuses the sender after MAIL FROM: Postfix and its relatives
 * (`reject_sender_login_mismatch`, `smtpd_delay_reject`) answer at RCPT TO with "Sender address
 * rejected" or "not owned by user", Exchange Online after DATA with 5.2.252 `SendAsDenied` ("not
 * allowed to send as") or 5.7.60 ("does not have permissions to send as this sender").
 */
const SENDER_REFUSAL_WORDING =
  /sender address rejected|not owned by (?:the )?(?:auth(?:enticated)? )?user|\b5\.2\.252\b|sendasdenied|not (?:allowed|authori[sz]ed|permitted) to send (?:as|on behalf)|permissions? to send as/i;

/**
 * Whether a nodemailer error is a permanent refusal of the recipient or the message: a 550, 551,
 * 553 or 554 answer to RCPT TO or DATA. nodemailer reports a refused envelope as `EENVELOPE`
 * whichever step refused it, so the step (`command`) decides: a refused MAIL FROM is the sender
 * (see {@link isSmtpSenderRejection}), never the recipient. Retrying cannot change it; the
 * address raises a delivery failure alert instead (0.5.0).
 */
export function isPermanentSmtpRejection(err: unknown): boolean {
  const { responseCode, command } = smtpErrorFields(err);
  if (typeof responseCode !== "number" || !PERMANENT_SMTP_CODES.has(responseCode)) {
    return false;
  }
  if (isSmtpSenderRejection(err)) {
    return false;
  }
  return command.startsWith("RCPT") || command === "DATA" || command === "MESSAGE";
}

/**
 * Whether the server refused the sender, e.g. a branded From the relay will not send as: a 5xx
 * answer to MAIL FROM, or a 5xx answer to RCPT TO or DATA whose wording names the sender
 * ({@link SENDER_REFUSAL_WORDING}; many servers check the sender only there). That concerns every
 * message, not one address: it is reported as `smtp_sender_rejected`, a failure of the transport
 * (one episode), and retried like one.
 */
export function isSmtpSenderRejection(err: unknown): boolean {
  const { responseCode, command, text } = smtpErrorFields(err);
  if (typeof responseCode !== "number" || responseCode < 500 || responseCode >= 600) {
    return false;
  }
  if (command === "MAIL FROM") {
    return true;
  }
  const later = command.startsWith("RCPT") || command === "DATA" || command === "MESSAGE";
  return later && SENDER_REFUSAL_WORDING.test(text);
}

/** nodemailer's attachment shape for ours (inline when it has a Content-ID). */
export function nodemailerAttachments(message: NotificationMessage) {
  return (message.attachments ?? []).map((attachment) => ({
    filename: singleLine(attachment.filename),
    contentType: attachment.contentType,
    content: attachment.content,
    ...(attachment.cid
      ? { cid: singleLine(attachment.cid), contentDisposition: "inline" as const }
      : {}),
  }));
}

/** SMTP transport via nodemailer. */
export class SmtpNotifier implements Notifier {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(smtp: Config["smtp"]) {
    this.transporter = nodemailer.createTransport(smtpTransportOptions(smtp));
    this.from = smtp.from ?? "";
  }

  /** The From of a message: the branding's name and address, else the configured sender. */
  private fromOf(message: NotificationMessage): string | { name: string; address: string } {
    if (!message.from) {
      return this.from;
    }
    const address =
      message.from.address && isPlainEmail(message.from.address)
        ? message.from.address
        : (addressOf(this.from) ?? this.from);
    return { name: singleLine(message.from.name), address };
  }

  async send(message: NotificationMessage): Promise<NotifyResult> {
    try {
      await this.transporter.sendMail({
        from: this.fromOf(message),
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(message.replyTo && isPlainEmail(message.replyTo)
          ? { replyTo: singleLine(message.replyTo) }
          : {}),
        ...(message.attachments?.length ? { attachments: nodemailerAttachments(message) } : {}),
      });
      return { ok: true };
    } catch (err) {
      if (isSmtpSenderRejection(err)) {
        return failed("smtp_sender_rejected", errorMessage(err));
      }
      if (isPermanentSmtpRejection(err)) {
        return { ...failed("recipient_rejected", errorMessage(err)), permanent: true };
      }
      return failed(smtpFailureReason(err), errorMessage(err));
    }
  }

  async sendTest(to: string, language: SupportedLanguage): Promise<NotifyResult> {
    return this.send({ to, ...testNotification(language) });
  }
}

/**
 * What a notifier sends with, resolved from the settings (secrets opened) or
 * from the environment.
 */
export type TransportSpec =
  | { transport: "smtp"; smtp: Config["smtp"] }
  | {
      transport: "graph";
      sender: string;
      tenantId: string | null;
      /** The app registration to authenticate as; null when none is usable. */
      app: AppCredentials | null;
      /** Whether `app` is the backup app registration or the notification mail's own. */
      appKind: GraphMailApp;
    }
  | { transport: "google"; sender: string; key: GoogleServiceAccountKey | null };

/**
 * The notifier for a resolved transport. In demo mode every notifier is a
 * {@link NoopNotifier}: nothing the demo sends may leave the server, whatever
 * transport the wizard or Settings (nominally) configured.
 */
export function notifierForTransport(spec: TransportSpec, options: { demo: boolean }): Notifier {
  if (options.demo) {
    return new NoopNotifier();
  }
  switch (spec.transport) {
    case "smtp":
      return new SmtpNotifier(spec.smtp);
    case "graph":
      return new GraphNotifier({
        sender: spec.sender,
        tenantId: spec.tenantId,
        app: spec.app,
        appKind: spec.appKind,
      });
    case "google":
      return new GoogleNotifier({ sender: spec.sender, key: spec.key });
  }
}

/**
 * Select the notifier implementation from the environment configuration
 * (defaults to SMTP). `graphApp` is the resolved backup app registration,
 * needed for `graph` only. Demo mode always gets a {@link NoopNotifier}.
 */
export function createNotifier(config: Config, graphApp: AppCredentials | null = null): Notifier {
  const spec: TransportSpec =
    config.mailTransport === "graph"
      ? {
          transport: "graph",
          sender: config.graphMailSender ?? "",
          tenantId: config.graphMailTenantId ?? null,
          app: graphApp,
          appKind: "backup",
        }
      : { transport: "smtp", smtp: config.smtp };
  return notifierForTransport(spec, { demo: config.demo.enabled });
}
