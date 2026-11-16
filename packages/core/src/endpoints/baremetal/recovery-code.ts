/**
 * Recovery codes (docs/BAREMETAL.md 9.1): a one-time code an admin issues for one machine, typed
 * into the recovery ISO, which exchanges it for a recovery session.
 *
 *   - 25 symbols of a 30-symbol alphabet (digits and A to X without I, L, O, U; no Y and no Z,
 *     which swap places on a German keyboard), uniform by rejection sampling, 122.7 bits; shown as
 *     `RC-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`. Typed in without regard to case, hyphens and spaces;
 *     `O` reads as `0`, `I` and `L` as `1`.
 *   - The code never leaves the ISO in clear: it sends `codeProof = SHA-256("restow-recovery-code:"
 *     + origin + ":" + code)` for the origin it actually connects to. The server stores only
 *     `SHA-256(codeProof)` and the origin it issued the code for, so a typo or a phishing domain
 *     with a valid certificate gets a value that opens nothing here, and a reader of the database
 *     cannot redeem a code.
 *   - The ISO makes the session secret itself and sends only its SHA-256; both sides derive the
 *     six-digit match code the admin compares before releasing the session (9.4).
 *   - The instance check value (`spkiCheck`) is the first 80 bits of the SHA-256 of the instance's
 *     TLS public key (SPKI), in Base32, for an ISO that does not trust the certificate (10.3).
 *
 * The Go side (agent/internal/recovery/code.go) computes the same values; both test against the
 * same vectors (agent/internal/recovery/testdata/recovery-code-vectors.json).
 */
import { createHash, randomInt as cryptoRandomInt } from "node:crypto";

/** The symbols of a recovery code. */
export const RECOVERY_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWX";
/** Symbols in a code (without the `RC` prefix). */
export const RECOVERY_CODE_LENGTH = 25;
const GROUP = 5;

/** The oldest `recover` (ISO) version the server serves. */
export const MIN_RECOVERY_VERSION = "0.5.0";

/** Validity of a code: 4 hours unless the admin chose otherwise, at most 48 (CHECK in 0078). */
export const DEFAULT_RECOVERY_VALIDITY_HOURS = 4;
export const MAX_RECOVERY_VALIDITY_HOURS = 48;
/** Codes of one machine that may be open at once (issued and not ended). */
export const RECOVERY_OPEN_LIMIT = 3;
/** A session nobody released within this long after the exchange fails. */
export const RECOVERY_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
/** The exchange answers the same session again (a lost answer) for this long after it. */
export const RECOVERY_IDEMPOTENCY_MS = 15 * 60 * 1000;
/** The credentials are handed out once, and once more within this long (a lost answer). */
export const RECOVERY_CREDENTIALS_RETRY_MS = 5 * 60 * 1000;
/** `rebind` in the ISO is allowed for this long after a successful finish. */
export const RECOVERY_REBIND_AFTER_FINISH_MS = 15 * 60 * 1000;
/** How long the restic route and the session routes may cache a session's state. */
export const RECOVERY_SESSION_CACHE_MS = 5000;
/** A session that has not finished this long after its expiry has failed ("the ISO went silent"). */
export const RECOVERY_SILENCE_AFTER_EXPIRY_MS = 30 * 60 * 1000;
/** The recovery log of one session holds at most this many bytes. */
export const RECOVERY_LOG_MAX_BYTES = 2 * 1024 * 1024;
/** Lines one log call may send. */
export const RECOVERY_LOG_MAX_LINES = 200;
/** Recovery logs are kept this many days. */
export const RECOVERY_LOG_KEEP_DAYS = 90;

/** Rebind tokens (docs/BAREMETAL.md 11): 1 hour unless chosen otherwise, at most 24 (CHECK in 0078). */
export const DEFAULT_REBIND_VALIDITY_HOURS = 1;
export const MAX_REBIND_VALIDITY_HOURS = 24;
/** What a rebind token is for; `mac_setup` comes with macOS (M6). */
export const REBIND_PURPOSES = ["baremetal", "reinstall", "mac_setup"] as const;
export type RebindPurpose = (typeof REBIND_PURPOSES)[number];

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * A new code, normalized (25 symbols, no prefix). `randomInt(n)` must return a uniform integer in
 * `[0, n)`; the default is `crypto.randomInt`, which samples without modulo bias.
 */
export function generateRecoveryCode(
  randomInt: (max: number) => number = (max) => cryptoRandomInt(max),
): string {
  let code = "";
  while (code.length < RECOVERY_CODE_LENGTH) {
    const index = randomInt(RECOVERY_CODE_ALPHABET.length);
    // Rejection: a source that answers out of range is asked again, never folded into range.
    if (Number.isInteger(index) && index >= 0 && index < RECOVERY_CODE_ALPHABET.length) {
      code += RECOVERY_CODE_ALPHABET[index];
    }
  }
  return code;
}

/** A normalized code as it is shown: `RC-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`. */
export function formatRecoveryCode(normalized: string): string {
  const groups: string[] = [];
  for (let at = 0; at < normalized.length; at += GROUP) {
    groups.push(normalized.slice(at, at + GROUP));
  }
  return `RC-${groups.join("-")}`;
}

/**
 * A code as typed, normalized: upper case, without spaces and hyphens, `O` as `0`, `I` and `L` as
 * `1`, without the `RC` prefix; null when it is not 25 symbols of the alphabet.
 */
export function normalizeRecoveryCode(input: string): string | null {
  let value = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (value.length === RECOVERY_CODE_LENGTH + 2 && value.startsWith("RC")) {
    value = value.slice(2);
  }
  if (value.length !== RECOVERY_CODE_LENGTH) {
    return null;
  }
  for (const symbol of value) {
    if (!RECOVERY_CODE_ALPHABET.includes(symbol)) {
      return null;
    }
  }
  return value;
}

/**
 * The canonical origin of an instance address (9.1): `https` (`http` only with `allowHttp`, for a
 * lab), host in lower case and Punycode, no trailing dot, no default port, IPv6 in brackets in its
 * short form; no user info, path, query or fragment. Without a scheme `https://` is assumed. Null
 * when the address is none of that.
 */
export function canonicalOrigin(raw: string, options: { allowHttp?: boolean } = {}): string | null {
  let text = raw.trim();
  if (text === "") {
    return null;
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    text = `https://${text}`;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(options.allowHttp && url.protocol === "http:")) {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    return null;
  }
  // An empty query or fragment ("…?", "…#") leaves no trace in `URL`.
  if (text.includes("?") || text.includes("#")) {
    return null;
  }
  const host = url.hostname.replace(/\.$/, "");
  if (host === "" || host.endsWith(".")) {
    return null;
  }
  return `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`;
}

/** What the ISO sends for a code it typed in, bound to the origin it connects to (hex). */
export function recoveryCodeProof(origin: string, normalizedCode: string): string {
  return sha256Hex(`restow-recovery-code:${origin}:${normalizedCode}`);
}

/** What the server stores and looks a code up by: SHA-256 of the proof's hex text. */
export function hashRecoveryCodeProof(codeProof: string): string {
  return sha256Hex(codeProof.toLowerCase());
}

/** The six digits both sides show before the admin releases a session (9.3, 9.4). */
export function recoveryMatchCode(sessionSecretSha256: string): string {
  const digest = createHash("sha256")
    .update(`restow-recovery-match:${sessionSecretSha256.toLowerCase()}`, "utf8")
    .digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

/** A match code as shown: `483 914`. */
export function formatMatchCode(matchCode: string): string {
  return matchCode.length === 6 ? `${matchCode.slice(0, 3)} ${matchCode.slice(3)}` : matchCode;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * The instance check value (9.2): RFC 4648 Base32 of the first 10 bytes of the SPKI SHA-256,
 * grouped `XXXX-XXXX-XXXX-XXXX`; null for anything that is not 64 hex digits.
 */
export function spkiCheckOf(spkiSha256: string | null | undefined): string | null {
  if (!spkiSha256 || !/^[0-9a-fA-F]{64}$/.test(spkiSha256)) {
    return null;
  }
  const bytes = Buffer.from(spkiSha256, "hex").subarray(0, 10);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return (out.match(/.{4}/g) ?? []).join("-");
}
