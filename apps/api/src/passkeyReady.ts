import type { Settings } from "@restow/db";

/**
 * The passkey-ready gate (docs/ARCHITECTURE.md, Setup and operating modes).
 *
 * WebAuthn/passkeys bind to a registrable domain over HTTPS. Restow only offers
 * passkeys once the deployment is verifiably clean: operating mode `public`, a
 * public URL on a registrable domain reachable over HTTPS, and the origin the
 * browser reports matching the configured RP origin. When the check fails
 * (IP-only, self-signed, origin mismatch) the passkey path stays hidden and the
 * emergency password + TOTP path applies instead. `localhost` is a marked
 * development exception, never production.
 */

export type PasskeyReadyReason =
  | "mode_not_public"
  | "no_public_url"
  | "not_https"
  | "origin_mismatch";

export interface PasskeyReadyResult {
  ready: boolean;
  /** Machine-readable reasons the gate is not (yet) open. Empty when ready. */
  reasons: PasskeyReadyReason[];
  /** The derived WebAuthn Relying Party id (registrable host), when known. */
  rpId: string | null;
  /** The derived RP origin, when known. */
  origin: string | null;
}

export interface PasskeyReadyOptions {
  /** The origin the browser/request reports, compared against the configured one. */
  observedOrigin?: string | null;
  /** Treat `localhost`/`127.0.0.1` over HTTP as acceptable (development only). */
  allowLocalhost?: boolean;
}

/** Compute whether passkeys may be offered for the given installation settings. */
export function computePasskeyReady(
  settings: Pick<Settings, "operatingMode" | "publicUrl">,
  options: PasskeyReadyOptions = {},
): PasskeyReadyResult {
  const reasons: PasskeyReadyReason[] = [];
  const allowLocalhost = options.allowLocalhost ?? false;

  if (settings.operatingMode !== "public") {
    reasons.push("mode_not_public");
  }

  let parsed: URL | null = null;
  if (!settings.publicUrl) {
    reasons.push("no_public_url");
  } else {
    try {
      parsed = new URL(settings.publicUrl);
    } catch {
      parsed = null;
      reasons.push("no_public_url");
    }
  }

  if (parsed) {
    const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    const httpsOk = parsed.protocol === "https:" || (allowLocalhost && isLocalhost);
    if (!httpsOk) {
      reasons.push("not_https");
    }
    if (options.observedOrigin && options.observedOrigin !== parsed.origin) {
      reasons.push("origin_mismatch");
    }
  }

  return {
    ready: reasons.length === 0,
    reasons,
    rpId: parsed?.hostname ?? null,
    origin: parsed?.origin ?? null,
  };
}
