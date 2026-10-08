import { type SupportedLanguage, createI18n } from "@restow/i18n";

/**
 * The shared shape of every notification transport (notify.ts, notify-graph.ts,
 * notify-google.ts): the message, the result and the reasons a send can fail
 * for. A reason is a short code the web UI explains in the operator's
 * language; `error` is the transport's own technical message (English, as the
 * server or provider wrote it) and is only ever shown as a detail.
 */

export interface NotificationMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Why a send failed. Kept in one list so the API, the setup wizard and the
 * settings page translate exactly the same codes.
 */
export const MAIL_FAILURE_REASONS = [
  // Any transport
  "timeout",
  "transport_error",
  // SMTP
  "smtp_auth_failed",
  "smtp_connection_failed",
  "smtp_tls_failed",
  // Microsoft 365 (Graph sendMail)
  "graph_app_missing",
  "graph_credential_missing",
  "graph_tenant_missing",
  "graph_tenant_not_found",
  "graph_app_not_found",
  "graph_secret_invalid",
  "graph_secret_expired",
  "graph_certificate_invalid",
  "graph_token_failed",
  "graph_send_denied",
  "graph_sender_not_found",
  // Google Workspace (Gmail API)
  "google_key_missing",
  "google_key_invalid",
  "google_delegation_missing",
  "google_sender_not_found",
  "google_api_disabled",
  "google_send_denied",
  "google_token_failed",
] as const;

export type MailFailureReason = (typeof MAIL_FAILURE_REASONS)[number];

export interface NotifyResult {
  ok: boolean;
  /** Set when `ok` is false and the transport recognised the cause. */
  reason?: MailFailureReason;
  /** The transport's technical message; never contains a credential. */
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

export function errorMessage(err: unknown): string {
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

/** A failed result with a reason and the technical message. */
export function failed(reason: MailFailureReason, error: string): NotifyResult {
  return { ok: false, reason, error };
}

/** Header values must never carry a line break (header injection). */
export function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}
