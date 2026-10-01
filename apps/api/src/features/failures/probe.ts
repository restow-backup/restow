import {
  type FailureCause,
  type FailureTechnical,
  buildCause,
  redactSensitiveText,
} from "@restow/core";
import type { ImapProbeResult } from "../sources/imap.js";

/**
 * The cause behind a failed IMAP connection test (features/sources/imap.ts):
 * the probe already classified the failure into a reason an operator can act
 * on; this names it in the shared vocabulary, so a broken source or mailbox
 * login is explained like a failed job.
 */
export function causeOfImapProbe(
  probe: ImapProbeResult,
  server: { host?: string | null; port?: number | null } = {},
): FailureCause | null {
  if (probe.ok) {
    return null;
  }
  const technical: FailureTechnical = { message: redactSensitiveText(probe.message) };
  if (probe.code) {
    technical.errorCode = redactSensitiveText(probe.code, 120);
  }
  const params = { role: "imap", host: server.host ?? null, port: server.port ?? null };
  switch (probe.reason) {
    case "auth":
      // The server accepted the connection but the master-user login cannot impersonate.
      return probe.code === "AUTHZID_UNSUPPORTED"
        ? buildCause("imap.config_invalid", { host: params.host }, technical)
        : buildCause("imap.auth_failed", { host: params.host }, technical);
    case "blocked_address":
      return buildCause("imap.address_blocked", { host: params.host }, technical);
    case "starttls_unavailable":
      return buildCause("imap.starttls_unavailable", { host: params.host }, technical);
    case "timeout":
      return buildCause("network.timeout", params, technical);
    case "dns":
      return buildCause("network.dns", params, technical);
    case "refused":
      return buildCause("network.unreachable", params, technical);
    case "tls":
      return buildCause("network.tls", { ...params, reason: tlsReasonOf(probe.code) }, technical);
    default:
      return buildCause("unknown", {}, technical);
  }
}

function tlsReasonOf(code: string | null): string {
  switch (code) {
    case "CERT_HAS_EXPIRED":
      return "expired";
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
      return "self_signed";
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return "hostname_mismatch";
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
      return "untrusted";
    default:
      return "protocol";
  }
}
