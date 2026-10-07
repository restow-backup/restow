import type { AppCredentials } from "@restow/core";
import type { SupportedLanguage } from "@restow/i18n";
import type { Config } from "../../config.js";
import type { MailFailureReason } from "../../notify-core.js";
import type { GoogleServiceAccountKey } from "../../notify-google.js";
import { type Notifier, type TransportSpec, notifierForTransport } from "../../notify.js";
import type { StoredSmtpConfig } from "./logic.js";
import type { GraphMailAppOption } from "./schemas.js";

/**
 * Notification mail transport as configured in the settings: turn the stored
 * (or drafted) configuration with its opened credentials into a notifier and
 * run a test send with an honest, bounded result. The transports themselves
 * live in notify.ts, notify-graph.ts and notify-google.ts.
 */

/** A transport with everything needed to send, including the opened credentials. */
export type ResolvedMailTransport =
  | {
      transport: "smtp";
      host: string;
      port: number;
      security: StoredSmtpConfig["security"];
      from: string;
      username: string | null;
      /** Plaintext, held in memory for this send only. */
      password: string | null;
    }
  | {
      transport: "graph";
      sender: string;
      tenantId: string | null;
      /** Which app registration sends: the backup app or the notification mail's own. */
      app: GraphMailAppOption;
      /** The app's credentials (opened); null when none is usable. */
      credentials: AppCredentials | null;
    }
  | {
      transport: "google";
      sender: string;
      /** The service account key (opened); null when none is stored. */
      key: GoogleServiceAccountKey | null;
    };

/** The notifier input for a resolved transport (GRAPH_MAIL_TENANT_ID fills a missing tenant). */
export function transportSpec(base: Config, mail: ResolvedMailTransport): TransportSpec {
  switch (mail.transport) {
    case "smtp":
      return {
        transport: "smtp",
        smtp: {
          host: mail.host,
          port: mail.port,
          secure: mail.security === "implicit",
          security: mail.security,
          username: mail.username ?? undefined,
          password: mail.username ? (mail.password ?? undefined) : undefined,
          from: mail.from,
        },
      };
    case "graph":
      return {
        transport: "graph",
        sender: mail.sender,
        tenantId:
          mail.tenantId ?? (mail.app === "backup" ? (base.graphMailTenantId ?? null) : null),
        app: mail.credentials,
      };
    case "google":
      return { transport: "google", sender: mail.sender, key: mail.key };
  }
}

/** Why a test send failed; the UI explains each reason in the operator's language. */
export type MailTestFailureReason = MailFailureReason;

export interface MailTestResult {
  ok: boolean;
  transport: ResolvedMailTransport["transport"];
  recipient: string;
  durationMs: number;
  /** Null on success. `detail` is the transport's own (technical) message, if any. */
  failure: { reason: MailTestFailureReason; detail: string | null } | null;
}

/** A misconfigured transport should fail fast, not keep the admin waiting two minutes. */
export const MAIL_TEST_TIMEOUT_MS = 20_000;

const MAX_DETAIL_LENGTH = 500;
const TIMED_OUT = Symbol("timed-out");

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Remove the credentials from a transport message (defence in depth) and bound its length. */
export function sanitizeDetail(
  message: string | null | undefined,
  secrets: string | null | readonly (string | null | undefined)[],
): string | null {
  if (!message) {
    return null;
  }
  const list = (Array.isArray(secrets) ? secrets : [secrets]).filter(
    (secret): secret is string => typeof secret === "string" && secret.length >= 4,
  );
  let redacted = message;
  for (const secret of list) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  const trimmed = redacted.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length > MAX_DETAIL_LENGTH ? `${trimmed.slice(0, MAX_DETAIL_LENGTH)}…` : trimmed;
}

/** The secret values a detail message must never repeat. */
function secretsOf(mail: ResolvedMailTransport): string[] {
  switch (mail.transport) {
    case "smtp":
      return mail.password ? [mail.password] : [];
    case "graph": {
      const credential = mail.credentials?.credential;
      if (!credential) {
        return [];
      }
      return credential.type === "secret" ? [credential.clientSecret] : [credential.privateKeyPem];
    }
    case "google":
      return mail.key ? [mail.key.privateKeyPem] : [];
  }
}

/** What is missing before anything is sent: no request to Microsoft or Google without it. */
function preflight(mail: ResolvedMailTransport, base: Config): MailTestFailureReason | null {
  if (mail.transport === "graph") {
    if (!mail.credentials) {
      return mail.app === "own" ? "graph_credential_missing" : "graph_app_missing";
    }
    if (!mail.tenantId && (mail.app === "own" || !base.graphMailTenantId)) {
      return "graph_tenant_missing";
    }
  }
  if (mail.transport === "google" && !mail.key) {
    return "google_key_missing";
  }
  return null;
}

export interface MailTestDependencies {
  base: Config;
  notifierFor?: (spec: TransportSpec) => Notifier;
  timeoutMs?: number;
  clock?: () => number;
}

/**
 * Send one test notification, written in `language` (the requester's), and
 * describe the outcome; never throws.
 */
export async function runMailTest(
  mail: ResolvedMailTransport,
  recipient: string,
  language: SupportedLanguage,
  deps: MailTestDependencies,
): Promise<MailTestResult> {
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const secrets = secretsOf(mail);
  const finish = (failure: MailTestResult["failure"]): MailTestResult => ({
    ok: failure === null,
    transport: mail.transport,
    recipient,
    durationMs: Math.max(0, clock() - started),
    failure,
  });

  const missing = preflight(mail, deps.base);
  if (missing) {
    return finish({ reason: missing, detail: null });
  }

  try {
    const spec = transportSpec(deps.base, mail);
    const notifier = deps.notifierFor
      ? deps.notifierFor(spec)
      : notifierForTransport(spec, { demo: deps.base.demo.enabled });
    const outcome = await withTimeout(
      notifier.sendTest(recipient, language),
      deps.timeoutMs ?? MAIL_TEST_TIMEOUT_MS,
    );
    if (outcome === TIMED_OUT) {
      return finish({ reason: "timeout", detail: null });
    }
    return outcome.ok
      ? finish(null)
      : finish({
          reason: outcome.reason ?? "transport_error",
          detail: sanitizeDetail(outcome.error, secrets),
        });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finish({ reason: "transport_error", detail: sanitizeDetail(message, secrets) });
  }
}
