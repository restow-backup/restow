import { createHash } from "node:crypto";
import { ConfidentialClientApplication, type NodeAuthOptions } from "@azure/msal-node";
import {
  type AppCredentials,
  DEFAULT_AUTHORITY_HOST,
  FetchGraphClient,
  appCredentialsFingerprint,
  derFromPem,
} from "@restow/core";
import { type SupportedLanguage, createI18n } from "@restow/i18n";
import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "./config.js";

/**
 * Notification transport (docs/ARCHITECTURE.md, notification mail service).
 *
 * One interface, two implementations chosen by `MAIL_TRANSPORT`:
 *   - `smtp`  — nodemailer over an operator-provided SMTP server.
 *   - `graph` — Microsoft Graph `sendMail` as the app (client credentials), which
 *               needs the `Mail.Send` application permission (docs/MICROSOFT.md).
 *               The app registration is the backup app's, resolved by the
 *               caller (environment or Settings → Microsoft 365).
 *
 * The separate SMTP *journal receiver* (archive) only ever receives; it never
 * sends and is not this module.
 */

export interface NotificationMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface NotifyResult {
  ok: boolean;
  error?: string;
}

export interface Notifier {
  send(message: NotificationMessage): Promise<NotifyResult>;
  /**
   * Send the test notification (setup wizard, Settings) in the language of
   * the person who asked for it.
   */
  sendTest(to: string, language: SupportedLanguage): Promise<NotifyResult>;
}

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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The test notification in `language` (namespace `notifications`). */
export function testNotification(language: SupportedLanguage): { subject: string; text: string } {
  const i18n = createI18n({ lng: language });
  return {
    subject: String(i18n.t("notifications:test.subject")),
    text: String(i18n.t("notifications:test.body")),
  };
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

/** SMTP transport via nodemailer. */
export class SmtpNotifier implements Notifier {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: Config) {
    this.transporter = nodemailer.createTransport(smtpTransportOptions(config.smtp));
    this.from = config.smtp.from ?? "";
  }

  async send(message: NotificationMessage): Promise<NotifyResult> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  async sendTest(to: string, language: SupportedLanguage): Promise<NotifyResult> {
    return this.send({ to, ...testNotification(language) });
  }
}

/** msal's options for the app in one tenant: a client secret, or the certificate (SHA-256 thumbprint). */
export function msalAuthOptions(app: AppCredentials, tenantId: string): NodeAuthOptions {
  const host = (app.authorityHost ?? DEFAULT_AUTHORITY_HOST).replace(/\/+$/, "");
  const base = { clientId: app.clientId, authority: `${host}/${tenantId}` };
  const credential = app.credential;
  if (credential.type === "secret") {
    return { ...base, clientSecret: credential.clientSecret };
  }
  const thumbprint = credential.certificatePem
    ? {
        thumbprintSha256: createHash("sha256")
          .update(derFromPem(credential.certificatePem))
          .digest("hex"),
      }
    : { thumbprint: credential.thumbprintSha1Hex ?? "" };
  return { ...base, clientCertificate: { ...thumbprint, privateKey: credential.privateKeyPem } };
}

const MSAL_CLIENT_LIMIT = 16;

/**
 * msal clients (with their token caches) per credential and tenant. The key is
 * the registration's fingerprint, so a changed secret or certificate gets a
 * new client instead of reusing tokens from the old one; it is never logged.
 */
const msalClients = new Map<string, ConfidentialClientApplication>();

function msalClientFor(app: AppCredentials, tenantId: string): ConfidentialClientApplication {
  const key = `${appCredentialsFingerprint(app)}:${tenantId}`;
  let client = msalClients.get(key);
  if (!client) {
    client = new ConfidentialClientApplication({ auth: msalAuthOptions(app, tenantId) });
    if (msalClients.size >= MSAL_CLIENT_LIMIT) {
      const oldest = msalClients.keys().next().value;
      if (oldest !== undefined) {
        msalClients.delete(oldest);
      }
    }
    msalClients.set(key, client);
  }
  return client;
}

/** Microsoft Graph `sendMail` transport (client credentials + the throttling client). */
export class GraphNotifier implements Notifier {
  private readonly client: ConfidentialClientApplication | null;
  private readonly graph: FetchGraphClient;
  private readonly sender: string;

  constructor(config: Config, app: AppCredentials | null) {
    this.sender = config.graphMailSender ?? "";
    // Client credentials require a concrete tenant id; `common` is only a
    // typecheck-safe placeholder until the operator's tenant is configured.
    const tenantId = config.graphMailTenantId ?? "common";
    this.client = app ? msalClientFor(app, tenantId) : null;
    this.graph = new FetchGraphClient({
      accessTokenProvider: () => this.acquireToken(),
    });
  }

  private async acquireToken(): Promise<string> {
    if (!this.client) {
      throw new Error("No Microsoft 365 app registration is configured for Graph sendMail.");
    }
    const result = await this.client.acquireTokenByClientCredential({
      scopes: ["https://graph.microsoft.com/.default"],
    });
    if (!result?.accessToken) {
      throw new Error("Failed to acquire a Microsoft Graph token for sendMail.");
    }
    return result.accessToken;
  }

  async send(message: NotificationMessage): Promise<NotifyResult> {
    try {
      const response = await this.graph.request({
        method: "POST",
        url: `/users/${encodeURIComponent(this.sender)}/sendMail`,
        body: {
          message: {
            subject: message.subject,
            body: {
              contentType: message.html ? "HTML" : "Text",
              content: message.html ?? message.text,
            },
            toRecipients: [{ emailAddress: { address: message.to } }],
          },
          saveToSentItems: false,
        },
      });
      const ok = response.status >= 200 && response.status < 300;
      return ok
        ? { ok: true }
        : { ok: false, error: `Graph sendMail returned ${response.status}.` };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  async sendTest(to: string, language: SupportedLanguage): Promise<NotifyResult> {
    return this.send({ to, ...testNotification(language) });
  }
}

/**
 * Select the notifier implementation from configuration (defaults to SMTP).
 * `graphApp` is the resolved backup app registration, needed for `graph` only.
 * In demo mode every notifier is a {@link NoopNotifier}: nothing the demo
 * sends may leave the server, whatever transport the wizard or Settings
 * (nominally) configured.
 */
export function createNotifier(config: Config, graphApp: AppCredentials | null = null): Notifier {
  if (config.demo.enabled) {
    return new NoopNotifier();
  }
  return config.mailTransport === "graph"
    ? new GraphNotifier(config, graphApp)
    : new SmtpNotifier(config);
}
