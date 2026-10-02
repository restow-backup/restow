import { DEFAULT_SOURCE_URL } from "@/features/updates/presenters";
import { ApiError, errorMessageKey } from "@/lib/api";
import type { MailTestFailureReason, ReachabilityStatus } from "./api";

/**
 * Pure mapping from API and browser outcomes to what the settings pieces show
 * (the installation sections and the account page): i18n keys and visual
 * variants. No visible text lives here.
 */

// --- About ----------------------------------------------------------------------------------

/** The English text of the core's license (Apache-2.0). */
export const CORE_LICENSE_URL = "https://www.apache.org/licenses/LICENSE-2.0";

/** The third-party notices the web image serves next to the interface (same origin). */
export const LOCAL_THIRD_PARTY_NOTICES_PATH = "/licenses/THIRD_PARTY_NOTICES.txt";

export interface AboutLinks {
  /** The source code of the running release, or the repository for a development build. */
  source: string;
  /** The third-party notices on GitHub, at the release tag (`main` for a development build). */
  thirdParty: string;
}

/**
 * Where the About tab points for the running build: the release tag
 * `v<version>` of a release, the repository itself (and `main`) for a
 * development build without a release version.
 */
export function aboutLinks(running: string | null): AboutLinks {
  const version = running?.trim().replace(/^v/i, "") ?? "";
  if (!version) {
    return {
      source: DEFAULT_SOURCE_URL,
      thirdParty: `${DEFAULT_SOURCE_URL}/blob/main/THIRD_PARTY_NOTICES.md`,
    };
  }
  const tag = encodeURIComponent(`v${version}`);
  return {
    source: `${DEFAULT_SOURCE_URL}/tree/${tag}`,
    thirdParty: `${DEFAULT_SOURCE_URL}/blob/${tag}/THIRD_PARTY_NOTICES.md`,
  };
}

// --- API errors ----------------------------------------------------------------------------

const PROBLEM_KEYS: Record<string, string> = {
  "urn:restow:problem:setup-incomplete": "settings:errors.setupIncomplete",
  "urn:restow:problem:mail-not-configured": "settings:errors.mailNotConfigured",
  "urn:restow:problem:master-key-missing": "settings:errors.masterKey",
  "urn:restow:problem:master-key-invalid": "settings:errors.masterKey",
};

/** The i18n key (with namespace) that explains a failed settings request. */
export function settingsErrorKey(error: unknown): string {
  if (error instanceof ApiError && error.problem) {
    const key = PROBLEM_KEYS[error.problem.type];
    if (key) {
      return key;
    }
  }
  return `common:${errorMessageKey(error)}`;
}

// --- Reachability probe --------------------------------------------------------------------

export type StatusTone = "neutral" | "warning" | "destructive" | "muted";

/**
 * The tone of a reachability probe. A server that answered is in order, which
 * is a state: neutral, never the green of a passed restore check.
 */
export function probeTone(status: ReachabilityStatus): StatusTone {
  switch (status) {
    case "ok":
      return "neutral";
    case "skipped":
      return "muted";
    case "certificate_invalid":
    case "unexpected_response":
      return "destructive";
    case "unreachable":
    case "timeout":
      return "warning";
  }
}

// --- Mail test --------------------------------------------------------------------------------

export function mailTestFailureKey(reason: MailTestFailureReason): string {
  return `mail.test.reasons.${reason}`;
}

/** "1.2 s" / "1,2 s" in the UI language. */
export function formatDuration(milliseconds: number, language: string): string {
  const seconds = Math.max(0, milliseconds) / 1000;
  return new Intl.NumberFormat(language, {
    style: "unit",
    unit: "second",
    unitDisplay: "short",
    maximumFractionDigits: seconds < 10 ? 1 : 0,
  }).format(seconds);
}

// --- Passkeys -----------------------------------------------------------------------------------

export interface PasskeyRow {
  id: string;
  name: string | null;
  createdAt: string | null;
  /** `multiDevice` passkeys sync through a password manager or platform account. */
  synced: boolean;
}

function toIsoString(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/** Normalize the better-auth passkey list (dates may arrive as strings or Dates). */
export function toPasskeyRows(passkeys: readonly unknown[]): PasskeyRow[] {
  const rows: PasskeyRow[] = [];
  for (const entry of passkeys) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== "string") {
      continue;
    }
    const name =
      typeof raw.name === "string" && raw.name.trim().length > 0 ? raw.name.trim() : null;
    rows.push({
      id: raw.id,
      name,
      createdAt: toIsoString(raw.createdAt),
      synced: raw.deviceType === "multiDevice" || raw.backedUp === true,
    });
  }
  // Newest first, unknown dates last.
  return rows.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

export interface AuthClientError {
  code?: string;
  message?: string;
  status: number;
}

/** A better-auth request that is not a WebAuthn ceremony, explained by its status. */
export function authStatusKey(error: AuthClientError): string {
  if (error.status === 401) return "common:errors.unauthorized";
  if (error.status === 403) return "common:errors.forbidden";
  if (error.status >= 500) return "common:errors.server";
  return "common:errors.generic";
}

/** Explain a failed passkey ceremony or request (`settings:security.passkeys.errors.*`). */
export function passkeyErrorKey(error: AuthClientError): string {
  const code = error.code ?? "";
  if (error.status === 401) {
    return "common:errors.unauthorized";
  }
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") {
    return "settings:security.passkeys.errors.alreadyRegistered";
  }
  if (
    code === "ERROR_CEREMONY_ABORTED" ||
    code === "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY" ||
    code === "AUTH_CANCELLED"
  ) {
    return "settings:security.passkeys.errors.cancelled";
  }
  if (code === "ERROR_INVALID_DOMAIN" || code === "ERROR_INVALID_RP_ID") {
    return "settings:security.passkeys.errors.domain";
  }
  if (code === "ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT") {
    return "settings:security.passkeys.errors.userVerification";
  }
  if (
    code === "FAILED_TO_VERIFY_REGISTRATION" ||
    code === "CHALLENGE_NOT_FOUND" ||
    code === "YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY"
  ) {
    return "settings:security.passkeys.errors.verificationFailed";
  }
  return "settings:security.passkeys.errors.generic";
}

// --- Authenticator (TOTP) ---------------------------------------------------------------

/** What the enrolment shows next to the QR code, read from the `otpauth://` URI. */
export interface TotpSetupKey {
  /** Base32 secret, for typing into an authenticator app by hand. */
  secret: string;
  /** The same secret in groups of four characters, easier to read and compare. */
  groupedSecret: string;
  issuer: string | null;
  account: string | null;
}

function decodeLabelPart(part: string | undefined): string | null {
  if (!part) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(part).trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/** Parse the key-uri format (`otpauth://totp/Issuer:account?secret=...`); null if it is not one. */
export function parseTotpUri(uri: string): TotpSetupKey | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  const secret = url.searchParams.get("secret")?.replace(/\s+/g, "").toUpperCase() ?? "";
  if (url.protocol !== "otpauth:" || !/^[A-Z2-7]+=*$/.test(secret)) {
    return null;
  }
  // The label is `issuer:account`, each part percent-encoded on its own.
  const label = url.pathname.replace(/^\/+/, "");
  const separator = label.indexOf(":");
  const labelIssuer = separator >= 0 ? label.slice(0, separator) : undefined;
  const account = separator >= 0 ? label.slice(separator + 1) : label;
  return {
    secret,
    groupedSecret: secret.match(/.{1,4}/g)?.join(" ") ?? secret,
    issuer: url.searchParams.get("issuer")?.trim() || decodeLabelPart(labelIssuer),
    account: decodeLabelPart(account),
  };
}

/** Recovery codes as a plain-text file the admin can keep offline. */
export function backupCodesDocument(
  codes: readonly string[],
  heading: { title: string; account: string | null; issuer: string | null; note: string },
): string {
  const header = [heading.title, heading.issuer, heading.account].filter(
    (line): line is string => typeof line === "string" && line.length > 0,
  );
  return [...header, "", ...codes, "", heading.note, ""].join("\n");
}

/** Explain a failed authenticator request (`settings:security.authenticator.errors.*`). */
export function twoFactorErrorKey(error: AuthClientError): string {
  const code = error.code ?? "";
  if (
    error.status === 429 ||
    code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE" ||
    code === "ACCOUNT_TEMPORARILY_LOCKED"
  ) {
    return "settings:security.authenticator.errors.tooManyAttempts";
  }
  if (code === "INVALID_PASSWORD") {
    return "settings:security.authenticator.errors.password";
  }
  if (code === "INVALID_CODE" || code === "INVALID_TWO_FACTOR_COOKIE") {
    return "settings:security.authenticator.errors.code";
  }
  if (code === "TOTP_ALREADY_ENABLED") {
    return "settings:security.authenticator.errors.alreadyEnabled";
  }
  if (code === "TOTP_NOT_ENABLED" || code === "TWO_FACTOR_NOT_ENABLED") {
    return "settings:security.authenticator.errors.notEnabled";
  }
  return authStatusKey(error);
}

/** A recognizable device name for a suggested passkey label; null when unknown. */
export function detectDevice(userAgent: string): string | null {
  const agent = userAgent.toLowerCase();
  if (agent.includes("iphone")) return "iPhone";
  if (agent.includes("ipad")) return "iPad";
  if (agent.includes("android")) return "Android";
  if (agent.includes("cros")) return "ChromeOS";
  if (agent.includes("windows")) return "Windows";
  if (agent.includes("mac os") || agent.includes("macintosh")) return "Mac";
  if (agent.includes("linux")) return "Linux";
  return null;
}
