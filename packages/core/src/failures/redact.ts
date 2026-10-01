/**
 * Redaction of text that ends up in a stored or displayed failure.
 *
 * The rule of the product is that no secret or token ever reaches an error
 * text, a log line or the UI; the callers already avoid passing secrets. This
 * is the defensive layer on top (like the logger's field redaction, which
 * works on field names; this one works on free text): bearer tokens, JWTs,
 * credentials in `key=value` pairs and JSON, query strings and user info of
 * URLs, key material, the text of a failed SQL query, and the arguments of
 * IMAP LOGIN / AUTHENTICATE lines.
 */

/** Longest single value kept in a failure record. */
export const MAX_FAILURE_TEXT = 500;

const REDACTED = "[redacted]";

/** Drizzle starts the message of a failed query with this marker (see @restow/db reportableError). */
const FAILED_QUERY_MARKER = "Failed query: ";

const SECRET_KEYS =
  "client_secret|client_assertion|password|passwd|pwd|passphrase|secret|token|access_token|refresh_token|id_token|api[-_]?key|apikey|authorization|x-amz-signature|x-amz-credential|signature|tempauth";

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is stripped
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

const PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  // The product's own credentials, bare: endpoint enrollment tokens (rset_), agent
  // secrets (rsea_) and integration API keys (rsk_<tag>_<secret>).
  [/\brse(?:t|a)_[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\brsk_[A-Za-z0-9]{1,16}_[A-Za-z0-9]{8,}/g, REDACTED],
  // "password": "value" and 'token': 'value'
  [
    new RegExp(`(["'](?:${SECRET_KEYS})["']\\s*:\\s*)(["'])(?:\\\\.|(?!\\2).)*\\2`, "gi"),
    `$1"${REDACTED}"`,
  ],
  // password=value, token: value (until a separator)
  [
    new RegExp(`\\b((?:${SECRET_KEYS})\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s&;,)"']+)`, "gi"),
    `$1${REDACTED}`,
  ],
  // PGPASSWORD=value, RESTIC_PASSWORD=value, MY_API_KEY: value (a credential-named variable)
  [
    /\b([A-Za-z0-9_]*(?:password|passwd|secret|token|api[-_]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;,)"']+)/gi,
    `$1${REDACTED}`,
  ],
  // user:password@host in any URL or connection string
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]*@/gi, `$1${REDACTED}@`],
  // query string and fragment of any URL
  [/(\bhttps?:\/\/[^\s?#"')]+)[?#][^\s"')]*/gi, "$1?…"],
  // IMAP: LOGIN user pass, AUTHENTICATE MECH base64
  [/\b(LOGIN)\s+("[^"]*"|\S+)\s+("[^"]*"|\S+)/g, `$1 ${REDACTED}`],
  [/\b(AUTHENTICATE)\s+(\S+)\s+[A-Za-z0-9+/=]{8,}/g, `$1 $2 ${REDACTED}`],
];

/**
 * `text` without secrets, on one line, bounded to `maxLength` characters.
 * Idempotent: redacting redacted text changes nothing.
 */
export function redactSensitiveText(text: string, maxLength = MAX_FAILURE_TEXT): string {
  let cleaned = text;
  const query = cleaned.indexOf(FAILED_QUERY_MARKER);
  if (query !== -1) {
    // The bound parameters of a failed query are session tokens, addresses, job state.
    cleaned = `${cleaned.slice(0, query)}database query failed`;
  }
  for (const [pattern, replacement] of PATTERNS) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  cleaned = cleaned
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

/** A URL reduced to origin-less path: no query, no fragment, no user info. */
export function redactedPath(url: string, maxLength = 300): string {
  let path = url;
  try {
    const parsed = new URL(url);
    path = parsed.pathname;
  } catch {
    // A relative Graph path such as "/users/x/messages?$select=id".
    const cut = url.search(/[?#]/);
    path = cut === -1 ? url : url.slice(0, cut);
  }
  return redactSensitiveText(path, maxLength);
}
