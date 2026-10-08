import { createPrivateKey, createSign } from "node:crypto";
import type { SupportedLanguage } from "@restow/i18n";
import MailComposer from "nodemailer/lib/mail-composer";
import {
  type MailFailureReason,
  type NotificationMessage,
  type Notifier,
  type NotifyResult,
  errorMessage,
  failed,
  singleLine,
  testNotification,
} from "./notify-core.js";

/**
 * Google Workspace transport: the Gmail API (`users.messages.send`) as a
 * service account with domain-wide delegation, impersonating the sender
 * mailbox (docs/MICROSOFT.md "Benachrichtigungs-Mail", Google part).
 *
 * No Google client library: the service account signs its own RS256 JWT with
 * node:crypto (RFC 7523 JWT bearer grant against oauth2.googleapis.com), and
 * the message is composed with nodemailer's MIME builder (already a
 * dependency for SMTP), base64url encoded and handed to the Gmail API. The
 * only scope ever requested is `gmail.send`; the delegation entry in the
 * Admin console must allow exactly that one.
 *
 * The token endpoint and the API host are fixed: the `token_uri` inside an
 * uploaded key is ignored, so a crafted key cannot send the signed assertion
 * anywhere else. Nothing here logs or returns key material.
 */

export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

/** The parts of a service account key that sending needs. */
export interface GoogleServiceAccountKey {
  clientEmail: string;
  /** The numeric OAuth client id the Admin console's delegation entry names. */
  clientId: string;
  privateKeyPem: string;
  privateKeyId: string | null;
  projectId: string | null;
}

export type ServiceAccountKeyProblem =
  | "json"
  | "type"
  | "client_email"
  | "client_id"
  | "private_key";

export type ServiceAccountKeyParse =
  | { ok: true; key: GoogleServiceAccountKey }
  | { ok: false; problem: ServiceAccountKeyProblem };

const ANY_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function stringField(value: Record<string, unknown>, name: string): string | null {
  const field = value[name];
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : null;
}

/**
 * Read a service account key as Google hands it out (the JSON file from
 * IAM › Service accounts › Keys) or as Restow seals it. Never echoes a value.
 */
export function parseServiceAccountKey(text: string): ServiceAccountKeyParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problem: "json" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, problem: "json" };
  }
  const value = raw as Record<string, unknown>;
  if (value.type !== "service_account") {
    return { ok: false, problem: "type" };
  }
  const clientEmail = stringField(value, "client_email");
  if (!clientEmail || !ANY_EMAIL.test(clientEmail)) {
    return { ok: false, problem: "client_email" };
  }
  const clientId = stringField(value, "client_id");
  if (!clientId || !/^\d{6,30}$/.test(clientId)) {
    return { ok: false, problem: "client_id" };
  }
  const privateKeyPem = stringField(value, "private_key");
  if (!privateKeyPem) {
    return { ok: false, problem: "private_key" };
  }
  try {
    const key = createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== "rsa") {
      return { ok: false, problem: "private_key" };
    }
  } catch {
    return { ok: false, problem: "private_key" };
  }
  return {
    ok: true,
    key: {
      clientEmail,
      clientId,
      privateKeyPem,
      privateKeyId: stringField(value, "private_key_id"),
      projectId: stringField(value, "project_id"),
    },
  };
}

/**
 * The document sealed in the installation secret store: the Google field
 * names, so the stored value is itself a valid key file, without the fields
 * sending does not need.
 */
export function serializeServiceAccountKey(key: GoogleServiceAccountKey): string {
  return JSON.stringify({
    type: "service_account",
    project_id: key.projectId,
    private_key_id: key.privateKeyId,
    private_key: key.privateKeyPem,
    client_email: key.clientEmail,
    client_id: key.clientId,
  });
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * The RS256 JWT a service account signs to ask for a token on behalf of
 * `subject` (domain-wide delegation, RFC 7523).
 */
export function buildServiceAccountAssertion(input: {
  key: GoogleServiceAccountKey;
  subject: string;
  scope: string;
  nowMs: number;
  audience?: string;
}): string {
  const issuedAt = Math.floor(input.nowMs / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
    ...(input.key.privateKeyId ? { kid: input.key.privateKeyId } : {}),
  };
  const claims = {
    iss: input.key.clientEmail,
    sub: input.subject,
    scope: input.scope,
    aud: input.audience ?? GOOGLE_TOKEN_ENDPOINT,
    iat: issuedAt,
    exp: issuedAt + 3600,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(input.key.privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

/** The RFC 5322 message, ready for the Gmail API (`raw`, base64url). */
export async function buildMimeMessage(input: {
  from: string;
  message: NotificationMessage;
}): Promise<Buffer> {
  const composer = new MailComposer({
    from: singleLine(input.from),
    to: singleLine(input.message.to),
    subject: singleLine(input.message.subject),
    text: input.message.text,
    ...(input.message.html ? { html: input.message.html } : {}),
  });
  return composer.compile().build();
}

/** Map the token endpoint's answer (`error`, `error_description`) onto a reason. */
export function googleTokenFailureReason(
  error: string | null,
  description: string | null,
): MailFailureReason {
  const text = (description ?? "").toLowerCase();
  switch (error) {
    case "unauthorized_client":
    case "access_denied":
      // Google's answer when the Admin console has no delegation entry for the
      // client id, or the entry does not include the gmail.send scope.
      return "google_delegation_missing";
    case "invalid_client":
    case "disabled_client":
      return "google_key_invalid";
    case "invalid_grant":
      if (text.includes("invalid email or user id") || text.includes("user not found")) {
        return "google_sender_not_found";
      }
      if (text.includes("signature") || text.includes("account not found")) {
        return "google_key_invalid";
      }
      return "google_token_failed";
    default:
      return "google_token_failed";
  }
}

interface GmailErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    status?: unknown;
    errors?: Array<{ reason?: unknown }>;
    details?: Array<{ reason?: unknown }>;
  };
}

function gmailError(body: unknown): { message: string | null; reasons: string[] } {
  const error = (body as GmailErrorBody | null | undefined)?.error;
  const reasons = [...(error?.errors ?? []), ...(error?.details ?? [])]
    .map((entry) => entry?.reason)
    .filter((reason): reason is string => typeof reason === "string");
  if (typeof error?.status === "string") {
    reasons.push(error.status);
  }
  return { message: typeof error?.message === "string" ? error.message : null, reasons };
}

/** Map a non-2xx Gmail API answer onto a reason. */
export function gmailSendFailureReason(status: number, body: unknown): MailFailureReason {
  const { reasons } = gmailError(body);
  if (reasons.includes("accessNotConfigured") || reasons.includes("SERVICE_DISABLED")) {
    return "google_api_disabled";
  }
  if (status === 401) {
    return "google_token_failed";
  }
  if (status === 403) {
    return "google_send_denied";
  }
  if (status === 404 || reasons.includes("failedPrecondition")) {
    return "google_sender_not_found";
  }
  return "transport_error";
}

export interface GoogleNotifierOptions {
  /** The sender mailbox the service account acts as (a user of the Workspace domain). */
  sender: string;
  key: GoogleServiceAccountKey | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

class GoogleFailure extends Error {
  constructor(
    readonly reason: MailFailureReason,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

/** Gmail API transport as a service account with domain-wide delegation. */
export class GoogleNotifier implements Notifier {
  private readonly sender: string;
  private readonly key: GoogleServiceAccountKey | null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private token: { value: string; expiresAtMs: number } | null = null;

  constructor(options: GoogleNotifierOptions) {
    this.sender = options.sender;
    this.key = options.key;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAtMs - 60_000 > this.now()) {
      return this.token.value;
    }
    if (!this.key) {
      throw new GoogleFailure("google_key_missing", "No service account key is stored.");
    }
    const assertion = buildServiceAccountAssertion({
      key: this.key,
      subject: this.sender,
      scope: GMAIL_SEND_SCOPE,
      nowMs: this.now(),
    });
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
        redirect: "error",
      });
    } catch (error) {
      throw new GoogleFailure("google_token_failed", errorMessage(error));
    }
    const payload = (await readJson(response)) as {
      access_token?: unknown;
      expires_in?: unknown;
      error?: unknown;
      error_description?: unknown;
    } | null;
    if (!response.ok || typeof payload?.access_token !== "string") {
      const error = typeof payload?.error === "string" ? payload.error : null;
      const description =
        typeof payload?.error_description === "string" ? payload.error_description : null;
      throw new GoogleFailure(
        googleTokenFailureReason(error, description),
        `Google token request failed with ${response.status}${error ? ` (${error})` : ""}${
          description ? `: ${description}` : ""
        }`,
      );
    }
    const expiresIn = Number(payload.expires_in ?? 3600);
    this.token = {
      value: payload.access_token,
      expiresAtMs: this.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
    };
    return this.token.value;
  }

  async send(message: NotificationMessage): Promise<NotifyResult> {
    try {
      const token = await this.accessToken();
      const raw = (await buildMimeMessage({ from: this.sender, message })).toString("base64url");
      const response = await this.fetchImpl(GMAIL_SEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ raw }),
        redirect: "error",
      });
      if (response.ok) {
        await response.text().catch(() => undefined);
        return { ok: true };
      }
      const body = await readJson(response);
      if (response.status === 401) {
        this.token = null;
      }
      const detail = gmailError(body).message;
      return failed(
        gmailSendFailureReason(response.status, body),
        `Gmail API returned ${response.status}${detail ? `: ${detail}` : "."}`,
      );
    } catch (error) {
      if (error instanceof GoogleFailure) {
        return failed(error.reason, error.message);
      }
      return failed("transport_error", errorMessage(error));
    }
  }

  async sendTest(to: string, language: SupportedLanguage): Promise<NotifyResult> {
    return this.send({ to, ...testNotification(language) });
  }
}
