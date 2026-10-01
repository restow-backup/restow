import { OAuth2Error } from "../backup/imap/oauth2.js";
/**
 * Turn any error a job can hit into a {@link FailureCause}.
 *
 * The classifier looks at the error and its `cause` chain, outermost first,
 * and takes the first layer it recognises: an explicit cause carried by the
 * error (see {@link FailureError}), a Graph answer, an Entra token refusal, an
 * IMAP or OAuth error, a storage backend error, a Postgres error, an
 * encryption error, or a socket error. What it cannot place becomes
 * `unknown`, with the redacted message kept in `technical` so nothing is
 * hidden.
 *
 * Callers that know which subsystem was talking pass `role`; a bare socket
 * error (ECONNREFUSED) says nothing about whether it was Microsoft, an IMAP
 * server or the storage endpoint.
 */
import { ImapAuthError, ImapConfigError, ImapSessionError } from "../backup/imap/types.js";
import {
  ChunkStoreFailedError,
  JobAbortedError,
  MissingChunkError,
  RestoreIntegrityError,
} from "../engine/chunkstore.js";
import { TokenAcquisitionError } from "../graph/auth/token.js";
import { GraphError } from "../graph/errors.js";
import { isBlockedAddressError } from "../net/address-policy.js";
import { catalogEntry } from "./catalog.js";
import { classifyGraphError, classifyTokenError } from "./graph.js";
import { redactSensitiveText } from "./redact.js";
import {
  type FailureCause,
  type FailureCode,
  type FailureParams,
  type FailureRole,
  type FailureTechnical,
  isFailureCode,
} from "./types.js";

export interface ClassifyContext {
  /** The subsystem the failing call belongs to, when the caller knows. */
  role?: FailureRole;
  /** Remote host (IMAP server, storage endpoint), when a socket error does not name it. */
  host?: string;
  port?: number;
  /** Why the run's abort signal fired ("shutdown", "expired", "cancelled"), for an aborted job. */
  abortReason?: string | null;
}

/** An error that already knows its cause; the classifier returns it untouched. */
export class FailureError extends Error {
  readonly failure: FailureCause;

  constructor(
    message: string,
    failure: {
      code: FailureCode;
      params?: FailureParams;
      technical?: FailureTechnical;
      transient?: boolean;
    },
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FailureError";
    this.failure = buildCause(failure.code, failure.params, failure.technical, failure.transient);
  }
}

/** A cause with the catalog's default transience unless the caller says otherwise. */
export function buildCause(
  code: FailureCode,
  params: FailureParams = {},
  technical: FailureTechnical = {},
  transient?: boolean,
): FailureCause {
  return {
    code,
    transient: transient ?? catalogEntry(code)?.transient ?? false,
    params,
    technical,
  };
}

// ---------------------------------------------------------------------------
// Walking the error chain
// ---------------------------------------------------------------------------

const MAX_CHAIN = 6;

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  Code?: unknown;
  cause?: unknown;
  _err?: unknown;
  errors?: unknown;
  syscall?: unknown;
  path?: unknown;
  hostname?: unknown;
  host?: unknown;
  address?: unknown;
  port?: unknown;
  status?: unknown;
  severity?: unknown;
  $metadata?: { httpStatusCode?: number };
  failure?: unknown;
  authenticationFailed?: unknown;
  serverResponseCode?: unknown;
  responseStatus?: unknown;
  responseText?: unknown;
  response?: unknown;
  executedCommand?: unknown;
}

function isObject(value: unknown): value is ErrorLike {
  return typeof value === "object" && value !== null;
}

/** The error and what it wraps, outermost first. */
export function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && chain.length < MAX_CHAIN) {
    if (chain.includes(current)) {
      break;
    }
    chain.push(current);
    if (!isObject(current)) {
      break;
    }
    const aggregate = Array.isArray(current.errors) ? current.errors[0] : undefined;
    current = current.cause ?? current._err ?? aggregate;
  }
  return chain;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function messageOf(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (isObject(value) && typeof value.message === "string") {
    return value.message;
  }
  return typeof value === "string" ? value : "";
}

function isCauseLike(value: unknown): value is FailureCause {
  if (!isObject(value)) {
    return false;
  }
  const candidate = value as { code?: unknown; transient?: unknown; params?: unknown };
  return (
    isFailureCode(candidate.code) &&
    typeof candidate.transient === "boolean" &&
    isObject(candidate.params)
  );
}

// ---------------------------------------------------------------------------
// Sockets and TLS
// ---------------------------------------------------------------------------

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_FAIL", "EAI_NODATA"]);
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "ETIMEOUT",
  "ESOCKETTIMEDOUT",
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
  "PROBE_TIMEOUT",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const TLS_REASONS: Readonly<Record<string, string>> = {
  CERT_HAS_EXPIRED: "expired",
  CERT_NOT_YET_VALID: "expired",
  DEPTH_ZERO_SELF_SIGNED_CERT: "self_signed",
  SELF_SIGNED_CERT_IN_CHAIN: "self_signed",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "untrusted",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "untrusted",
  UNABLE_TO_GET_ISSUER_CERT: "untrusted",
  CERT_UNTRUSTED: "untrusted",
  ERR_TLS_CERT_ALTNAME_INVALID: "hostname_mismatch",
  HOSTNAME_MISMATCH: "hostname_mismatch",
  EPROTO: "protocol",
  STARTTLS_INJECTION: "protocol",
  ERR_SSL_WRONG_VERSION_NUMBER: "protocol",
};

const MICROSOFT_HOST =
  /(^|\.)(microsoft\.com|microsoftonline\.com|microsoftonline\.us|microsoftonline-p\.com|microsoftonline\.cn|windows\.net|windows\.us|chinacloudapi\.cn|sharepoint\.com|sharepoint\.us|office\.com|office365\.com|office365\.us|outlook\.com|live\.com|azure\.com|azureedge\.net)$/i;

function tlsReasonOf(code: string, message: string, heuristics: boolean): string | null {
  const known = TLS_REASONS[code];
  if (known) {
    return known;
  }
  if (/^(ERR_SSL_|ERR_TLS_|ERR_OSSL_)/.test(code) || /^CERT_/.test(code)) {
    return "protocol";
  }
  if (!heuristics) {
    return null;
  }
  if (/self[- ]signed/i.test(message)) {
    return "self_signed";
  }
  if (/certificate has expired|cert.*expired/i.test(message)) {
    return "expired";
  }
  if (/altnames|hostname\/ip does not match|hostname mismatch/i.test(message)) {
    return "hostname_mismatch";
  }
  if (/unable to verify|unable to get (local )?issuer/i.test(message)) {
    return "untrusted";
  }
  if (/wrong version number|handshake failure|tlsv1 alert|ssl routines/i.test(message)) {
    return "protocol";
  }
  return null;
}

type SocketKind = "dns" | "unreachable" | "timeout" | "tls";

function socketKind(
  layer: ErrorLike,
  heuristics: boolean,
): { kind: SocketKind; systemCode: string; tls: string | null } | null {
  const systemCode = str(layer.code) ?? "";
  const message = messageOf(layer);
  const name = str(layer.name) ?? "";
  const tls = tlsReasonOf(systemCode, message, heuristics);
  if (tls && (systemCode !== "" || /certificate|tls|ssl/i.test(message))) {
    return { kind: "tls", systemCode, tls };
  }
  if (DNS_CODES.has(systemCode)) {
    return { kind: "dns", systemCode, tls: null };
  }
  if (TIMEOUT_CODES.has(systemCode) || name === "TimeoutError" || name === "AbortError") {
    return { kind: "timeout", systemCode: systemCode || name, tls: null };
  }
  if (UNREACHABLE_CODES.has(systemCode)) {
    return { kind: "unreachable", systemCode, tls: null };
  }
  if (
    heuristics &&
    !isPostgresLike(layer) &&
    /socket (hang up|timeout)|connection (closed|reset|terminated)|network (error|is unreachable)/i.test(
      message,
    )
  ) {
    return { kind: /timeout/i.test(message) ? "timeout" : "unreachable", systemCode, tls: null };
  }
  return null;
}

function hostOf(layer: ErrorLike, context: ClassifyContext): string | null {
  return str(layer.hostname) ?? str(layer.host) ?? str(layer.address) ?? context.host ?? null;
}

function roleOf(host: string | null, context: ClassifyContext): FailureRole | null {
  if (context.role) {
    return context.role;
  }
  return host && MICROSOFT_HOST.test(host) ? "microsoft" : null;
}

function networkCause(
  layer: ErrorLike,
  found: { kind: SocketKind; systemCode: string; tls: string | null },
  context: ClassifyContext,
): FailureCause {
  const host = hostOf(layer, context);
  const port = typeof layer.port === "number" ? layer.port : (context.port ?? null);
  const role = roleOf(host, context);
  const technical: FailureTechnical = {};
  if (found.systemCode) {
    technical.systemCode = found.systemCode;
  }
  if (host) {
    technical.host = redactSensitiveText(host, 200);
  }
  if (port !== null) {
    technical.port = port;
  }
  const message = messageOf(layer);
  if (message) {
    technical.message = redactSensitiveText(message);
  }
  const params: FailureParams = { role, host, port };
  if (found.systemCode) {
    params.systemCode = found.systemCode;
  }

  if (role === "database") {
    return buildCause("database.unavailable", { ...params, reason: found.kind }, technical, true);
  }
  if (role === "storage") {
    const code: FailureCode =
      found.kind === "tls"
        ? "storage.tls"
        : found.kind === "timeout"
          ? "storage.timeout"
          : "storage.unreachable";
    return buildCause(code, found.tls ? { ...params, reason: found.tls } : params, technical);
  }
  switch (found.kind) {
    case "dns":
      return buildCause("network.dns", params, technical);
    case "timeout":
      return buildCause("network.timeout", params, technical);
    case "tls":
      return buildCause("network.tls", { ...params, reason: found.tls }, technical);
    default:
      return buildCause("network.unreachable", params, technical);
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const FS_CODES: Readonly<Record<string, FailureCode>> = {
  ENOENT: "storage.path_missing",
  ENOTDIR: "storage.path_missing",
  EISDIR: "storage.path_missing",
  EACCES: "storage.not_writable",
  EPERM: "storage.not_writable",
  EROFS: "storage.not_writable",
  ENOSPC: "storage.full",
  EDQUOT: "storage.full",
};

const S3_NAMES: Readonly<Record<string, FailureCode>> = {
  AccessDenied: "storage.access_denied",
  Forbidden: "storage.access_denied",
  AllAccessDisabled: "storage.access_denied",
  InvalidAccessKeyId: "storage.credentials_invalid",
  SignatureDoesNotMatch: "storage.credentials_invalid",
  InvalidToken: "storage.credentials_invalid",
  ExpiredToken: "storage.credentials_invalid",
  CredentialsProviderError: "storage.credentials_invalid",
  NoSuchBucket: "storage.bucket_missing",
  PermanentRedirect: "storage.wrong_region",
  AuthorizationHeaderMalformed: "storage.wrong_region",
  IllegalLocationConstraintException: "storage.wrong_region",
  TimeoutError: "storage.timeout",
  RequestTimeout: "storage.timeout",
  RequestTimeoutException: "storage.timeout",
  StorageProbeTimeout: "storage.timeout",
  StorageIntegrityError: "storage.integrity",
  SlowDown: "storage.rate_limited",
  ServiceUnavailable: "storage.rate_limited",
  ThrottlingException: "storage.rate_limited",
  RequestLimitExceeded: "storage.rate_limited",
  TooManyRequests: "storage.rate_limited",
  QuotaExceeded: "storage.full",
  StorageLimitExceeded: "storage.full",
  InternalError: "storage.error",
};

function storageTechnical(layer: ErrorLike): FailureTechnical {
  const technical: FailureTechnical = {};
  const systemCode = str(layer.code) ?? str(layer.Code) ?? str(layer.name);
  if (systemCode) {
    technical.errorCode = redactSensitiveText(systemCode, 120);
  }
  const status = layer.$metadata?.httpStatusCode;
  if (typeof status === "number") {
    technical.httpStatus = status;
  }
  const syscall = str(layer.syscall);
  if (syscall) {
    technical.syscall = syscall;
  }
  const path = str(layer.path);
  if (path) {
    technical.path = redactSensitiveText(path, 300);
  }
  const message = messageOf(layer);
  if (message) {
    technical.message = redactSensitiveText(message);
  }
  return technical;
}

/** A storage backend error (filesystem or S3 SDK shape), or null. */
function classifyStorageLayer(layer: ErrorLike, forced: boolean): FailureCause | null {
  const codes = [str(layer.code), str(layer.Code), str(layer.name)].filter(
    (value): value is string => value !== undefined,
  );
  const s3Shaped = layer.$metadata !== undefined;
  for (const candidate of codes) {
    const fs = FS_CODES[candidate];
    // A bare ENOENT may come from anywhere; the worker's only file access is storage.
    if (fs && (forced || str(layer.syscall) !== undefined || str(layer.path) !== undefined)) {
      const params: FailureParams = {};
      const path = str(layer.path);
      if (path) {
        params.path = redactSensitiveText(path, 300);
      }
      if (candidate === "ENOTDIR" || candidate === "EISDIR") {
        params.reason = "not_a_directory";
      }
      return buildCause(fs, params, storageTechnical(layer));
    }
    const s3 = S3_NAMES[candidate];
    if (
      s3 &&
      (forced ||
        s3Shaped ||
        candidate === "StorageIntegrityError" ||
        candidate === "StorageProbeTimeout")
    ) {
      return buildCause(s3, {}, storageTechnical(layer));
    }
  }
  if (s3Shaped) {
    const status = layer.$metadata?.httpStatusCode;
    if (status === 301 || status === 307) {
      return buildCause("storage.wrong_region", {}, storageTechnical(layer));
    }
    if (status === 401 || status === 403) {
      return buildCause("storage.access_denied", {}, storageTechnical(layer));
    }
    if (status === 429 || status === 503) {
      return buildCause("storage.rate_limited", {}, storageTechnical(layer));
    }
    if (typeof status === "number" && status >= 500) {
      return buildCause("storage.error", {}, storageTechnical(layer));
    }
    return buildCause("storage.error", {}, storageTechnical(layer));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Database and encryption
// ---------------------------------------------------------------------------

function isPostgresLike(layer: ErrorLike): boolean {
  return typeof layer.severity === "string" && /^[0-9A-Z]{5}$/.test(str(layer.code) ?? "");
}

const DB_MESSAGES =
  /connection terminated|timeout exceeded when trying to connect|remaining connection slots|too many clients|client has encountered a connection error|server closed the connection|the database system is (starting up|shutting down)|database "[^"]*" does not exist/i;

function classifyDatabase(layer: ErrorLike, heuristics: boolean): FailureCause | null {
  const message = messageOf(layer);
  if (isPostgresLike(layer)) {
    const sqlState = str(layer.code) ?? "";
    const technical: FailureTechnical = { sqlState, message: redactSensitiveText(message) };
    const cls = sqlState.slice(0, 2);
    const reason =
      sqlState === "53300"
        ? "too_many_connections"
        : sqlState === "53100"
          ? "disk_full"
          : cls === "57"
            ? "shutdown"
            : cls === "08"
              ? "connection"
              : cls === "40"
                ? "conflict"
                : null;
    if (reason) {
      return buildCause("database.unavailable", { sqlState, reason }, technical, true);
    }
    return buildCause("database.error", { sqlState }, technical, false);
  }
  if (heuristics && DB_MESSAGES.test(message)) {
    return buildCause(
      "database.unavailable",
      { reason: "connection" },
      { message: redactSensitiveText(message) },
      true,
    );
  }
  return null;
}

function classifyCrypto(layer: ErrorLike): FailureCause | null {
  const message = messageOf(layer);
  const technical: FailureTechnical = { message: redactSensitiveText(message) };
  if (/has no data-encryption key/i.test(message)) {
    return buildCause("crypto.key_missing", { reason: "tenant_key" }, technical);
  }
  if (/requires a KEK|RESTOW_MASTER_KEY|KEK must/i.test(message)) {
    return buildCause("crypto.key_missing", { reason: "master_key" }, technical);
  }
  if (
    /unable to authenticate data|bad decrypt|key version mismatch|sealed secret is bound|wrapped dek|unsupported state/i.test(
      message,
    )
  ) {
    return buildCause("crypto.key_invalid", {}, technical);
  }
  return null;
}

// ---------------------------------------------------------------------------
// IMAP
// ---------------------------------------------------------------------------

const IMAP_COMMAND = /^\s*(?:[A-Za-z0-9]+\s+)?([A-Z][A-Z0-9-]*)/;

function imapTechnical(layer: ErrorLike): FailureTechnical {
  const technical: FailureTechnical = {};
  const response = str(layer.responseText) ?? str(layer.response);
  if (response) {
    technical.imapResponse = redactSensitiveText(response, 300);
  }
  const serverCode = str(layer.serverResponseCode);
  if (serverCode) {
    technical.imapCode = redactSensitiveText(serverCode, 60);
  }
  const status = str(layer.responseStatus);
  if (status) {
    technical.imapStatus = status;
  }
  const command = str(layer.executedCommand);
  if (command) {
    // The verb only: LOGIN and AUTHENTICATE carry credentials in their arguments.
    const verb = IMAP_COMMAND.exec(command)?.[1];
    if (verb) {
      technical.imapCommand = verb;
    }
  }
  const message = messageOf(layer);
  if (message) {
    technical.message = redactSensitiveText(message);
  }
  return technical;
}

/** imapflow-shaped errors (they are plain Errors with extra properties). */
function classifyImapShape(
  layer: ErrorLike,
  context: ClassifyContext,
  heuristics: boolean,
): FailureCause | null {
  const serverCode = (str(layer.serverResponseCode) ?? "").toUpperCase();
  const response = `${str(layer.responseText) ?? ""} ${str(layer.response) ?? ""}`;
  const technical = imapTechnical(layer);
  const hostParams: FailureParams = context.host ? { host: context.host } : {};
  if (
    (heuristics && /\[AUTHENTICATIONFAILED\]/i.test(`${response} ${messageOf(layer)}`)) ||
    layer.authenticationFailed === true ||
    serverCode === "AUTHENTICATIONFAILED" ||
    serverCode === "AUTHORIZATIONFAILED" ||
    str(layer.code)?.toUpperCase() === "AUTHENTICATIONFAILED"
  ) {
    return buildCause("imap.auth_failed", hostParams, technical);
  }
  const quotaText = heuristics ? `${response} ${messageOf(layer)}` : response;
  if (
    serverCode === "OVERQUOTA" ||
    serverCode === "LIMIT" ||
    /over ?quota|quota exceeded|mailbox is full/i.test(quotaText)
  ) {
    return buildCause("imap.mailbox_full", hostParams, technical);
  }
  if (
    str(layer.code) === "NoConnection" ||
    (heuristics &&
      /connection not available|connection closed|closed unexpectedly/i.test(messageOf(layer)))
  ) {
    return buildCause("imap.connection_lost", hostParams, technical, true);
  }
  if (str(layer.responseStatus) !== undefined || str(layer.executedCommand) !== undefined) {
    return buildCause(
      "imap.command_failed",
      { ...hostParams, ...(serverCode ? { imapCode: serverCode } : {}) },
      technical,
    );
  }
  return null;
}

function classifyOAuth(error: OAuth2Error): FailureCause {
  const technical: FailureTechnical = { message: redactSensitiveText(error.message) };
  if (error.status !== null) {
    technical.httpStatus = error.status;
  }
  if (error.code) {
    technical.errorCode = redactSensitiveText(error.code, 120);
  }
  if (error.code === "network") {
    return buildCause(
      "network.unreachable",
      { role: "imap", host: null, port: null },
      technical,
      true,
    );
  }
  if (error.status !== null && error.status >= 500) {
    return buildCause(
      "network.unreachable",
      { role: "imap", host: null, port: null },
      technical,
      true,
    );
  }
  const reason =
    error.code === "invalid_grant"
      ? "token_expired"
      : error.code === "invalid_client" || error.code === "unauthorized_client"
        ? "client_invalid"
        : error.code === "invalid_secret"
          ? "secret_invalid"
          : "other";
  return buildCause("imap.oauth_failed", { reason }, technical);
}

function classifyImapConfig(error: ImapConfigError, context: ClassifyContext): FailureCause {
  const technical: FailureTechnical = { message: redactSensitiveText(error.message) };
  const params: FailureParams = context.host ? { host: context.host } : {};
  if (
    isBlockedAddressError(error) ||
    /not a public address|not allowed|loopback|private/i.test(error.message)
  ) {
    return buildCause("imap.address_blocked", params, technical);
  }
  if (/starttls|not encrypted|TLS is required/i.test(error.message)) {
    return buildCause("imap.starttls_unavailable", params, technical);
  }
  return buildCause("imap.config_invalid", params, technical);
}

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

function unknownCause(error: unknown, chain: readonly unknown[]): FailureCause {
  const technical: FailureTechnical = {};
  const first = chain[0];
  const name = first instanceof Error ? first.name : isObject(first) ? str(first.name) : undefined;
  if (name && name !== "Error") {
    technical.errorName = redactSensitiveText(name, 80);
  }
  const code = isObject(first) ? (str(first.code) ?? str(first.Code)) : undefined;
  if (code) {
    technical.errorCode = redactSensitiveText(code, 120);
  }
  const message = messageOf(first ?? error) || (typeof error === "string" ? error : "");
  technical.message = redactSensitiveText(message || String(error));
  return buildCause("unknown", {}, technical);
}

function classifyLayer(
  layer: unknown,
  chain: readonly unknown[],
  index: number,
  context: ClassifyContext,
  heuristics: boolean,
): FailureCause | null {
  if (!isObject(layer)) {
    return null;
  }
  if (isCauseLike(layer.failure)) {
    return layer.failure;
  }
  if (layer instanceof GraphError) {
    return classifyGraphError(layer);
  }
  if (layer instanceof TokenAcquisitionError) {
    return classifyTokenError(layer);
  }
  if (layer instanceof OAuth2Error) {
    return classifyOAuth(layer);
  }
  if (layer instanceof ImapAuthError) {
    return buildCause(
      "imap.auth_failed",
      context.host ? { host: context.host } : {},
      layer.serverResponse ? { imapResponse: redactSensitiveText(layer.serverResponse, 300) } : {},
    );
  }
  if (layer instanceof ImapConfigError) {
    return classifyImapConfig(layer, context);
  }
  if (layer instanceof ImapSessionError) {
    const deeper = classifyChain(chain.slice(index + 1), {
      ...context,
      role: context.role ?? "imap",
    });
    if (deeper && deeper.code !== "unknown") {
      return deeper;
    }
    const technical = { ...imapTechnical(layer) };
    return layer.connectionLost
      ? buildCause(
          "imap.connection_lost",
          context.host ? { host: context.host } : {},
          technical,
          true,
        )
      : buildCause("imap.command_failed", context.host ? { host: context.host } : {}, technical);
  }
  if (layer instanceof ChunkStoreFailedError) {
    const inner = classifyChain(chain.slice(index + 1), { ...context, role: "storage" });
    return (
      inner ?? buildCause("storage.error", {}, { message: redactSensitiveText(layer.message) })
    );
  }
  if (layer instanceof JobAbortedError || str(layer.name) === "JobAbortedError") {
    const reason = context.abortReason ?? "aborted";
    return buildCause(
      "job.interrupted",
      { reason },
      { message: redactSensitiveText(messageOf(layer)) },
      true,
    );
  }
  if (layer instanceof RestoreIntegrityError) {
    return buildCause("verify.hash_mismatch", {}, { message: redactSensitiveText(layer.message) });
  }
  if (layer instanceof MissingChunkError) {
    return buildCause("verify.chunk_missing", {}, { message: redactSensitiveText(layer.message) });
  }
  if (str(layer.name) === "DirectoryConflictError") {
    return buildCause(
      "directory.conflict",
      {},
      { message: redactSensitiveText(messageOf(layer)) },
      true,
    );
  }

  // Shapes without a class of our own.
  const database = classifyDatabase(layer, heuristics);
  if (database) {
    return database;
  }
  const imap = classifyImapShape(layer, context, heuristics);
  if (imap) {
    return imap;
  }
  // The AWS SDK marks its errors with $metadata: whatever it hit was the storage endpoint.
  const effective: ClassifyContext =
    layer.$metadata !== undefined ? { ...context, role: "storage" } : context;
  const socket = socketKind(layer, heuristics);
  if (socket) {
    return networkCause(layer, socket, effective);
  }
  const storage = classifyStorageLayer(layer, effective.role === "storage");
  if (storage) {
    return storage;
  }
  return heuristics ? classifyCrypto(layer) : null;
}

/**
 * Two passes over the chain: the first trusts classes, error codes and
 * properties; only when it finds nothing does the second read message texts
 * (a wrapper's message repeats what it wraps, so it must not decide early).
 */
function classifyChain(chain: readonly unknown[], context: ClassifyContext): FailureCause | null {
  for (const heuristics of [false, true]) {
    for (let index = 0; index < chain.length; index += 1) {
      const found = classifyLayer(chain[index], chain, index, context, heuristics);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

/**
 * Classify `error`. Never throws; an error nothing recognises becomes
 * `unknown` with its redacted message under `technical.message`.
 */
export function classifyFailure(error: unknown, context: ClassifyContext = {}): FailureCause {
  const chain = errorChain(error);
  const found = classifyChain(chain, context);
  return found ?? unknownCause(error, chain);
}
