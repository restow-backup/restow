import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { connect } from "node:tls";

/**
 * The instance check value (docs/BAREMETAL.md 9.2): when a recovery code is issued, the server
 * connects to its own public address the way the recovery ISO will and reads the public key of the
 * certificate it is shown there (the DER of the SubjectPublicKeyInfo). The ISO compares it when it
 * does not trust the certificate (10.3). The connection only reads the certificate, so it does not
 * verify it; nothing is sent. A failure (hairpin NAT, split DNS, plain HTTP) gives no value.
 */

export interface MeasureOptions {
  timeoutMs?: number;
  /**
   * Connect here (`host:port`) instead of the origin's own address, still naming the origin's host
   * (SNI): the TLS edge as the recovery lab's proxy reaches it (`caddy:443`), where the public
   * address is not reachable from inside (hairpin NAT).
   */
  connectTo?: string;
}

/** SHA-256 (hex) of the TLS public key `origin` presents, or null. */
export async function measureInstanceSpki(
  origin: string,
  options: MeasureOptions = {},
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") {
    return null;
  }
  const name = url.hostname.replace(/^\[|\]$/g, "");
  let host = name;
  let port = url.port ? Number(url.port) : 443;
  if (options.connectTo) {
    const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(options.connectTo.trim());
    if (!match) return null;
    host = (match[1] as string).replace(/^\[|\]$/g, "");
    port = Number(match[2]);
  }
  const timeoutMs = options.timeoutMs ?? 5000;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const socket = connect({
      host,
      port,
      // SNI only for a name; an address literal must not be sent as one (RFC 6066).
      ...(isIP(name) === 0 ? { servername: name } : {}),
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.once("secureConnect", () => {
      try {
        // The DER of the SubjectPublicKeyInfo, as the ISO hashes it (Go `RawSubjectPublicKeyInfo`).
        // Not `getPeerCertificate().pubkey`: for an EC key that is the bare point, not the SPKI.
        const spki = socket
          .getPeerX509Certificate()
          ?.publicKey.export({ type: "spki", format: "der" });
        finish(spki ? createHash("sha256").update(spki).digest("hex") : null);
      } catch {
        finish(null);
      }
    });
    socket.once("error", () => finish(null));
    socket.once("close", () => finish(null));
  });
}
