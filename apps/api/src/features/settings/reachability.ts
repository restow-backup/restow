/**
 * Server-side reachability check of the public URL (docs/ARCHITECTURE.md, setup and operating modes:
 * reachable over HTTPS with a valid, trusted certificate).
 *
 * The passkey-ready gate itself (passkeyReady.ts) can only look at the URL; it
 * cannot tell a Let's Encrypt certificate from a self-signed one. This probe
 * requests the public setup-state endpoint through the public URL with full
 * certificate validation and reports what it found. It is advisory: a server
 * behind NAT may not reach its own public address (hairpin routing), and a
 * private CA trusted by the browsers may be unknown to the container, so the
 * result is shown next to the gate rather than folded into it.
 *
 * Only provider admins can trigger it, only the configured origin is requested
 * (a fixed path, no redirects followed) and nothing from the response body is
 * returned, so it cannot be used to read internal services.
 */

export type ReachabilityStatus =
  | "ok"
  | "skipped"
  | "unreachable"
  | "timeout"
  | "certificate_invalid"
  | "unexpected_response";

export interface ReachabilityProbe {
  status: ReachabilityStatus;
  /** The URL that was requested; null when the check was skipped. */
  url: string | null;
  /** Technical detail (an error code or HTTP status), never a sentence. */
  detail: string | null;
  checkedAt: string;
}

/** Answered by every Restow installation, publicly, with a small JSON body. */
export const REACHABILITY_PATH = "/api/v1/setup/state";

export const REACHABILITY_TIMEOUT_MS = 8_000;

/** Node/OpenSSL error codes for certificates the client does not trust. */
const CERTIFICATE_ERROR_CODES: ReadonlySet<string> = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "CERT_SIGNATURE_FAILURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
]);

const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

interface ErrorFacts {
  codes: string[];
  names: string[];
}

/** Collect `code` and `name` along the `cause` chain (fetch wraps the socket error). */
function errorFacts(error: unknown): ErrorFacts {
  const facts: ErrorFacts = { codes: [], names: [] };
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
    const { code, name, cause } = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof code === "string") {
      facts.codes.push(code);
    }
    if (typeof name === "string") {
      facts.names.push(name);
    }
    current = cause;
  }
  return facts;
}

/** Map a failed request onto a probe status with its technical detail. */
export function classifyFetchError(error: unknown): {
  status: Exclude<ReachabilityStatus, "ok" | "skipped" | "unexpected_response">;
  detail: string | null;
} {
  const { codes, names } = errorFacts(error);
  const certificateCode = codes.find(
    (code) => CERTIFICATE_ERROR_CODES.has(code) || code.startsWith("ERR_TLS_CERT"),
  );
  if (certificateCode) {
    return { status: "certificate_invalid", detail: certificateCode };
  }
  if (names.includes("TimeoutError") || names.includes("AbortError")) {
    return { status: "timeout", detail: null };
  }
  const timeoutCode = codes.find((code) => TIMEOUT_CODES.has(code));
  if (timeoutCode) {
    return { status: "timeout", detail: timeoutCode };
  }
  return { status: "unreachable", detail: codes[0] ?? null };
}

function looksLikeRestow(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { configured?: unknown }).configured === "boolean"
  );
}

export interface ProbeDependencies {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * Probe `origin` over HTTPS. Skipped without a public URL, for plain HTTP
 * (nothing to validate) and for the `localhost` development exception.
 */
export async function probePublicUrl(
  origin: string | null,
  deps: ProbeDependencies = {},
): Promise<ReachabilityProbe> {
  const now = deps.now ?? (() => new Date());
  const result = (status: ReachabilityStatus, url: string | null, detail: string | null) => ({
    status,
    url,
    detail,
    checkedAt: now().toISOString(),
  });

  let target: URL | null = null;
  try {
    target = origin ? new URL(REACHABILITY_PATH, origin) : null;
  } catch {
    target = null;
  }
  const isLocal = target?.hostname === "localhost" || target?.hostname === "127.0.0.1";
  if (!target || target.protocol !== "https:" || isLocal) {
    return result("skipped", null, null);
  }

  const url = target.toString();
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(deps.timeoutMs ?? REACHABILITY_TIMEOUT_MS),
    });
    if (!response.ok) {
      return result("unexpected_response", url, `HTTP ${response.status}`);
    }
    const body: unknown = await response.json().catch(() => null);
    return looksLikeRestow(body)
      ? result("ok", url, null)
      : result("unexpected_response", url, "not_restow");
  } catch (error) {
    const { status, detail } = classifyFetchError(error);
    return result(status, url, detail);
  }
}
