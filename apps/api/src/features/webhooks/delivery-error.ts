/**
 * The `webhook_deliveries.last_error` format, written by the worker
 * (apps/worker/src/handlers/webhooks.ts) and read here for the delivery log:
 *
 *   <code>[ <HTTP status>][: <detail>]
 *
 * e.g. `http_error 503: upstream unavailable`, `timeout`,
 * `connection_failed: ECONNREFUSED`, `blocked_address: 10.0.0.7`. The code
 * lets the UI explain the failure in the operator's language; the detail is
 * the technical evidence (an errno, the start of the response body).
 */

export const DELIVERY_ERROR_CODES = [
  "http_error",
  "redirect",
  "timeout",
  "connection_failed",
  "dns_failed",
  "tls_failed",
  "blocked_address",
  "invalid_url",
  "secret_missing",
  "webhook_disabled",
  "internal",
] as const;

export type DeliveryErrorCode = (typeof DELIVERY_ERROR_CODES)[number] | "unknown";

export interface DeliveryErrorDto {
  code: DeliveryErrorCode;
  httpStatus: number | null;
  detail: string | null;
}

const FORMAT = /^([a-z_]+)(?: (\d{3}))?(?:: ([\s\S]*))?$/;

function isKnownCode(value: string): value is (typeof DELIVERY_ERROR_CODES)[number] {
  return (DELIVERY_ERROR_CODES as readonly string[]).includes(value);
}

/** Parse a stored `last_error`; anything unrecognised is kept verbatim as `unknown`. */
export function parseDeliveryError(raw: string | null): DeliveryErrorDto | null {
  if (raw === null || raw.trim().length === 0) {
    return null;
  }
  const match = FORMAT.exec(raw.trim());
  const code = match?.[1];
  if (!match || code === undefined || !isKnownCode(code)) {
    return { code: "unknown", httpStatus: null, detail: raw.trim() };
  }
  const detail = match[3]?.trim();
  return {
    code,
    httpStatus: match[2] ? Number(match[2]) : null,
    detail: detail ? detail : null,
  };
}
