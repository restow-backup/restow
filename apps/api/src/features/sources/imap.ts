import {
  BLOCKED_ADDRESS_CODE,
  guardedLookup,
  isBlockedAddressError,
  refuseHostBeforeConnect,
} from "@restow/core";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import type { ImapSecurity } from "./schemas.js";

/**
 * "Test connection" for IMAP sources (docs/IMAP.md): connect, negotiate TLS
 * as configured, authenticate, list the folders once, log out. The probe is
 * bounded by a short timeout so a firewall that swallows packets does not
 * hang the request, and its result is classified so the UI can say *what*
 * failed (credentials, TLS, DNS, refused, timeout) instead of "error".
 *
 * The password only ever lives in the imapflow options for the duration of
 * the probe; the result never contains it.
 *
 * The probe connects from the API server, so the host goes through the
 * address policy (@restow/core net/address-policy.ts): unless private
 * networks are allowed for this probe, a host in a loopback, private or
 * link-local network is refused before and during the connect, and the
 * result says only that, never what answered there.
 */

export interface ImapProbeInput {
  host: string;
  port: number;
  security: ImapSecurity;
  username: string;
  password: string;
  /**
   * SASL PLAIN authorization identity (master-user impersonation, docs/IMAP.md):
   * `username`/`password` authenticate as the master account, the session is
   * authorized as this mailbox. Absent for every other probe.
   */
  authzid?: string;
}

export type ImapProbeFailure =
  /** The host is, or resolves to, an address the probe may not connect to. */
  | "blocked_address"
  | "auth"
  | "timeout"
  | "tls"
  | "starttls_unavailable"
  | "dns"
  | "refused"
  | "unknown";

export interface ImapServerInfo {
  name: string | null;
  vendor: string | null;
  version: string | null;
}

export type ImapProbeResult =
  | {
      ok: true;
      /** ISO-8601 time of the probe. */
      checkedAt: string;
      /** True when the session ran over TLS (implicit or after STARTTLS). */
      secure: boolean;
      server: ImapServerInfo | null;
      mailboxes: number;
      /** Special-use folders the server advertises (`\Sent`, `\Trash`, ...). */
      specialUse: string[];
      /** Capabilities Restow cares about for backup (CONDSTORE, QRESYNC, IDLE, UIDPLUS, ...). */
      capabilities: string[];
    }
  | {
      ok: false;
      checkedAt: string;
      reason: ImapProbeFailure;
      code: string | null;
      message: string;
    };

/** Overall budget for connect + login + LIST + logout. */
export const DEFAULT_IMAP_PROBE_TIMEOUT_MS = 15_000;

/** Capabilities worth reporting; the full list is noise for an operator. */
const INTERESTING_CAPABILITIES = [
  "IMAP4rev1",
  "IMAP4rev2",
  "IDLE",
  "CONDSTORE",
  "QRESYNC",
  "UIDPLUS",
  "MOVE",
  "SPECIAL-USE",
  "LIST-STATUS",
  "BINARY",
  "COMPRESS=DEFLATE",
  "AUTH=XOAUTH2",
] as const;

/** The slice of an imapflow client the probe uses (injectable for tests). */
export interface ImapProbeClient {
  connect(): Promise<void>;
  list(): Promise<Array<{ specialUse?: string }>>;
  logout(): Promise<void>;
  close(): void;
  serverInfo: { name?: string; vendor?: string; version?: string } | null;
  capabilities: Map<string, boolean | number>;
  secureConnection: boolean;
}

export interface ImapProbeOptions {
  /** Permit loopback and private networks (operator flag or a provider admin). Default: refused. */
  allowPrivateNetworks?: boolean;
  timeoutMs?: number;
  createClient?: (options: ImapFlowOptions) => ImapProbeClient;
  now?: () => Date;
}

/**
 * Translate the stored security mode into imapflow's transport switches. Every
 * name is resolved through the guarded lookup, so the address that was checked
 * is the address that is connected to.
 */
export function imapFlowOptions(
  input: ImapProbeInput,
  timeoutMs: number,
  allowPrivateNetworks = false,
): ImapFlowOptions {
  const transport: Pick<ImapFlowOptions, "secure" | "doSTARTTLS"> =
    input.security === "tls"
      ? { secure: true }
      : input.security === "starttls"
        ? // Fail instead of silently continuing in plaintext when STARTTLS is unavailable.
          { secure: false, doSTARTTLS: true }
        : { secure: false, doSTARTTLS: false };
  return {
    host: input.host,
    port: input.port,
    ...transport,
    tls: { lookup: guardedLookup(allowPrivateNetworks) },
    auth: {
      user: input.username,
      pass: input.password,
      // Force AUTH=PLAIN whenever an authzid is set: imapflow only threads authzid
      // through that mechanism, and without a forced loginMethod a server that
      // advertises AUTH=LOGIN but not AUTH=PLAIN silently drops authzid and signs
      // in as the master account itself (docs/IMAP.md, master-user mode). Forcing
      // it here makes an unsupported server fail the probe loudly instead of
      // reporting success for the wrong identity.
      ...(input.authzid ? { authzid: input.authzid, loginMethod: "AUTH=PLAIN" } : {}),
    },
    clientInfo: { name: "Restow", vendor: "Restow" },
    // Verify only: authenticate, no IDLE, no compression, no ENABLE.
    verifyOnly: false,
    disableAutoIdle: true,
    disableCompression: true,
    disableAutoEnable: true,
    logger: false,
    connectionTimeout: timeoutMs,
    greetingTimeout: Math.min(timeoutMs, 10_000),
    socketTimeout: timeoutMs,
  };
}

interface ImapErrorLike {
  code?: unknown;
  message?: unknown;
  authenticationFailed?: unknown;
  serverResponseCode?: unknown;
  response?: unknown;
  responseText?: unknown;
}

/** Map an imapflow / socket error onto an actionable failure reason. */
export function classifyImapError(error: unknown): {
  reason: ImapProbeFailure;
  code: string | null;
} {
  const err = (typeof error === "object" && error !== null ? error : {}) as ImapErrorLike;
  const code = typeof err.code === "string" ? err.code : null;
  const message = typeof err.message === "string" ? err.message : "";

  if (isBlockedAddressError(error)) {
    return { reason: "blocked_address", code: BLOCKED_ADDRESS_CODE };
  }
  if (err.authenticationFailed === true || code === "AUTHENTICATIONFAILED") {
    return { reason: "auth", code };
  }
  switch (code) {
    case "CONNECT_TIMEOUT":
    case "GREETING_TIMEOUT":
    case "UPGRADE_TIMEOUT":
    case "ETIMEOUT":
    case "ETIMEDOUT":
    case "PROBE_TIMEOUT":
      return { reason: "timeout", code };
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "EAI_NONAME":
      return { reason: "dns", code };
    case "ECONNREFUSED":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "ECONNRESET":
      return { reason: "refused", code };
    case "STARTTLS_INJECTION":
      return { reason: "tls", code };
    default:
      break;
  }
  if (/starttls/i.test(message) && /not support|unavailable|not available/i.test(message)) {
    return { reason: "starttls_unavailable", code };
  }
  if (
    (code !== null && /CERT|TLS|SSL|SELF_SIGNED|HANDSHAKE/i.test(code)) ||
    /certificate|tls|ssl|handshake/i.test(message)
  ) {
    return { reason: "tls", code };
  }
  return { reason: "unknown", code };
}

/** What a refused host is told: no address, no banner, nothing about what is there. */
const BLOCKED_ADDRESS_MESSAGE =
  "The host is in a loopback, private or link-local network, which this server does not connect to.";

/** A safe, short description of a failure; never includes credentials. */
function failureMessage(error: unknown): string {
  if (isBlockedAddressError(error)) {
    return BLOCKED_ADDRESS_MESSAGE;
  }
  const err = (typeof error === "object" && error !== null ? error : {}) as ImapErrorLike;
  const parts = [
    typeof err.message === "string" ? err.message : String(error),
    typeof err.responseText === "string" ? err.responseText : null,
    typeof err.response === "string" ? err.response : null,
  ].filter((part): part is string => typeof part === "string" && part.length > 0);
  return [...new Set(parts)].join("; ").slice(0, 500);
}

function serverInfoOf(client: ImapProbeClient): ImapServerInfo | null {
  const info = client.serverInfo;
  if (!info) {
    return null;
  }
  return {
    name: info.name ?? null,
    vendor: info.vendor ?? null,
    version: info.version ?? null,
  };
}

function timeoutError(timeoutMs: number): Error & { code: string } {
  const error = new Error(`The IMAP probe did not finish within ${timeoutMs} ms`) as Error & {
    code: string;
  };
  error.code = "PROBE_TIMEOUT";
  return error;
}

/** Run a bounded verification session against the IMAP server. */
export async function probeImapConnection(
  input: ImapProbeInput,
  options: ImapProbeOptions = {},
): Promise<ImapProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_IMAP_PROBE_TIMEOUT_MS;
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const allowPrivateNetworks = options.allowPrivateNetworks === true;
  // Literal addresses never reach the lookup; local-only names are not even resolved.
  const refused = refuseHostBeforeConnect(input.host, allowPrivateNetworks);
  if (refused) {
    return {
      ok: false,
      checkedAt,
      reason: "blocked_address",
      code: BLOCKED_ADDRESS_CODE,
      message: BLOCKED_ADDRESS_MESSAGE,
    };
  }
  const flowOptions = imapFlowOptions(input, timeoutMs, allowPrivateNetworks);
  const client: ImapProbeClient =
    options.createClient?.(flowOptions) ??
    (new ImapFlow(flowOptions) as unknown as ImapProbeClient);

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(timeoutMs)), timeoutMs);
  });

  const session = async (): Promise<ImapProbeResult> => {
    await client.connect();
    if (input.authzid && !client.capabilities.has("AUTH=PLAIN")) {
      // Same gap as the worker's connector (imapflow-connector.ts): imapflow
      // only attempts SASL (where the forced loginMethod: "AUTH=PLAIN" and
      // authzid apply) when the server advertises AUTH=LOGIN or AUTH=PLAIN.
      // A server offering neither falls back to the plain IMAP LOGIN command
      // regardless of loginMethod, which has no authzid at all: the session
      // that just connected is already authenticated as the master account
      // itself, not impersonating this mailbox. `client.capabilities`
      // reflects what the server actually offered, so this is caught here
      // and reported as a failed probe rather than a green one for the
      // wrong identity.
      await client.logout();
      return {
        ok: false,
        checkedAt,
        reason: "auth",
        code: "AUTHZID_UNSUPPORTED",
        message: `${input.host}:${input.port} does not offer AUTH=PLAIN, so a master-user login cannot impersonate a mailbox (authzid) here; it would silently sign in as the master account itself instead. Configure a Dovecot separator login for this server.`,
      };
    }
    const folders = await client.list();
    const result: ImapProbeResult = {
      ok: true,
      checkedAt,
      secure: client.secureConnection,
      server: serverInfoOf(client),
      mailboxes: folders.length,
      specialUse: [...new Set(folders.map((f) => f.specialUse).filter(isString))].sort(),
      capabilities: INTERESTING_CAPABILITIES.filter((cap) => client.capabilities.has(cap)),
    };
    await client.logout();
    return result;
  };

  try {
    return await Promise.race([session(), deadline]);
  } catch (error) {
    const { reason, code } = classifyImapError(error);
    return { ok: false, checkedAt, reason, code, message: failureMessage(error) };
  } finally {
    clearTimeout(timer);
    // Idempotent; also tears down a session the deadline interrupted.
    try {
      client.close();
    } catch {
      // Nothing to release.
    }
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
