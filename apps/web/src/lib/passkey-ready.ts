import type { OperatingMode, PasskeyReady, PasskeyReadyReason } from "@/lib/api";

/**
 * Client-side preview of the server's passkey gate (apps/api passkeyReady),
 * so the wizard can say what a chosen mode and URL will mean before anything
 * is saved. The server result after submit is authoritative; this mirrors
 * the same rules: public mode, a valid HTTPS public URL, and the browser
 * origin matching it. `localhost` over HTTP is the documented dev exception.
 */
export interface PasskeyPreviewInput {
  operatingMode: OperatingMode;
  publicUrl: string;
  /** `window.location.origin` in the browser. */
  observedOrigin: string | null;
  allowLocalhost?: boolean;
}

export function previewPasskeyReady(input: PasskeyPreviewInput): PasskeyReady {
  const reasons: PasskeyReadyReason[] = [];
  const allowLocalhost = input.allowLocalhost ?? false;

  if (input.operatingMode !== "public") {
    reasons.push("mode_not_public");
  }

  let parsed: URL | null = null;
  const trimmed = input.publicUrl.trim();
  if (!trimmed) {
    reasons.push("no_public_url");
  } else {
    try {
      parsed = new URL(trimmed);
    } catch {
      reasons.push("no_public_url");
    }
  }

  if (parsed) {
    const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    const httpsOk = parsed.protocol === "https:" || (allowLocalhost && isLocalhost);
    if (!httpsOk) {
      reasons.push("not_https");
    }
    if (input.observedOrigin && input.observedOrigin !== parsed.origin) {
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

/** Hostnames that count as local development, never production. */
export function isLocalhostOrigin(origin: string | null): boolean {
  if (!origin) {
    return false;
  }
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}
