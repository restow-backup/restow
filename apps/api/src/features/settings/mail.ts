import type { AppCredentials } from "@restow/core";
import type { SupportedLanguage } from "@restow/i18n";
import type { Config } from "../../config.js";
import { type Notifier, createNotifier } from "../../notify.js";
import type { StoredMailConfig, StoredSmtpConfig } from "./logic.js";

/**
 * Notification mail transport as configured in the settings: turn the stored
 * (or drafted) configuration into a notifier and run a test send with an
 * honest, bounded result. The transports themselves live in notify.ts.
 */

/** A transport with everything needed to send, including the resolved password. */
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
  | { transport: "graph"; sender: string; tenantId: string | null };

export function resolveMail(
  mail: StoredMailConfig,
  password: string | null,
): ResolvedMailTransport {
  if (mail.transport === "smtp") {
    return {
      transport: "smtp",
      host: mail.host,
      port: mail.port,
      security: mail.security,
      from: mail.from,
      username: mail.username ?? null,
      password: mail.username ? password : null,
    };
  }
  return { transport: "graph", sender: mail.sender, tenantId: mail.tenantId ?? null };
}

/** A notifier configuration derived from the settings instead of the environment. */
export function notifierConfig(base: Config, mail: ResolvedMailTransport): Config {
  if (mail.transport === "smtp") {
    return {
      ...base,
      mailTransport: "smtp",
      smtp: {
        host: mail.host,
        port: mail.port,
        secure: mail.security === "implicit",
        security: mail.security,
        username: mail.username ?? undefined,
        password: mail.password ?? undefined,
        from: mail.from,
      },
    };
  }
  return {
    ...base,
    mailTransport: "graph",
    graphMailSender: mail.sender,
    graphMailTenantId: mail.tenantId ?? base.graphMailTenantId,
  };
}

/** Why a test send failed; the UI explains each reason in the operator's language. */
export type MailTestFailureReason =
  | "timeout"
  | "graph_app_missing"
  | "graph_tenant_missing"
  | "transport_error";

export interface MailTestResult {
  ok: boolean;
  transport: "smtp" | "graph";
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

/** Remove the credential from a transport message (defence in depth) and bound its length. */
export function sanitizeDetail(
  message: string | null | undefined,
  secret: string | null,
): string | null {
  if (!message) {
    return null;
  }
  const redacted = secret ? message.split(secret).join("[redacted]") : message;
  const trimmed = redacted.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length > MAX_DETAIL_LENGTH ? `${trimmed.slice(0, MAX_DETAIL_LENGTH)}…` : trimmed;
}

/** Graph sendMail needs the app registration and a concrete tenant (client credentials). */
function graphPreflight(
  mail: ResolvedMailTransport,
  base: Config,
  graphApp: AppCredentials | null,
): MailTestFailureReason | null {
  if (mail.transport !== "graph") {
    return null;
  }
  if (!graphApp) {
    return "graph_app_missing";
  }
  if (!mail.tenantId && !base.graphMailTenantId) {
    return "graph_tenant_missing";
  }
  return null;
}

export interface MailTestDependencies {
  base: Config;
  /** The backup app registration Graph sendMail authenticates as; null when none is usable. */
  graphApp: AppCredentials | null;
  notifierFor?: (config: Config, graphApp: AppCredentials | null) => Notifier;
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
  const secret = mail.transport === "smtp" ? mail.password : null;
  const graphApp = mail.transport === "graph" ? deps.graphApp : null;
  const finish = (failure: MailTestResult["failure"]): MailTestResult => ({
    ok: failure === null,
    transport: mail.transport,
    recipient,
    durationMs: Math.max(0, clock() - started),
    failure,
  });

  const preflight = graphPreflight(mail, deps.base, graphApp);
  if (preflight) {
    return finish({ reason: preflight, detail: null });
  }

  try {
    const notifier = (deps.notifierFor ?? createNotifier)(
      notifierConfig(deps.base, mail),
      graphApp,
    );
    const outcome = await withTimeout(
      notifier.sendTest(recipient, language),
      deps.timeoutMs ?? MAIL_TEST_TIMEOUT_MS,
    );
    if (outcome === TIMED_OUT) {
      return finish({ reason: "timeout", detail: null });
    }
    return outcome.ok
      ? finish(null)
      : finish({ reason: "transport_error", detail: sanitizeDetail(outcome.error, secret) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finish({ reason: "transport_error", detail: sanitizeDetail(message, secret) });
  }
}
