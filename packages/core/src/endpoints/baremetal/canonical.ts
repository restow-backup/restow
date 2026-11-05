/**
 * The canonical encoding of a layout manifest (`restow-layout-v1`, docs/BAREMETAL.md 4.2): the
 * bytes of `layout.json` in the snapshot, the input of its SHA-256 and what the agent sends with
 * the finish of a run. The agent (agent/internal/baremetal/canonical.go) and the server produce
 * the same bytes for the same value; the shared test data under
 * agent/internal/baremetal/testdata/manifests proves it.
 *
 *   - UTF-8, no whitespace, no trailing newline;
 *   - object keys sorted ascending by their UTF-8 bytes (not by UTF-16 code units, which is what
 *     the default sort compares), arrays in their order, `undefined` members left out;
 *   - strings escape only `"` and `\`: a control character (U+0000-001F, U+007F-009F), U+2028,
 *     U+2029 or a lone surrogate makes the value invalid (Go escapes U+2028/2029 always, so the
 *     two encoders could never agree on them);
 *   - numbers are integers from 0 to 2^53-1 (no sign, no fraction, no exponent).
 */
import { createHash } from "node:crypto";

/** What makes a string invalid in a manifest: C0, DEL, C1, U+2028, U+2029. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** A UTF-16 surrogate without its partner (not representable in UTF-8). */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Whether a string is allowed in a manifest (see the module comment). */
export function noControlChars(value: string): boolean {
  return !FORBIDDEN.test(value) && !LONE_SURROGATE.test(value);
}

/** A value that cannot be encoded canonically; `path` says where. */
export class CanonicalEncodingError extends Error {
  constructor(
    readonly reason: string,
    readonly path: string,
  ) {
    super(`${reason} at ${path || "/"}`);
    this.name = "CanonicalEncodingError";
  }
}

function encodeString(value: string, path: string): string {
  if (!noControlChars(value)) {
    throw new CanonicalEncodingError("control character in string", path);
  }
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** Ascending by UTF-8 bytes. */
export function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function encode(value: unknown, path: string, out: string[]): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
        throw new CanonicalEncodingError("number is not an integer from 0 to 2^53-1", path);
      }
      out.push(String(value));
      return;
    case "string":
      out.push(encodeString(value, path));
      return;
    case "object":
      break;
    default:
      throw new CanonicalEncodingError(`unsupported value of type ${typeof value}`, path);
  }
  if (Array.isArray(value)) {
    out.push("[");
    value.forEach((item, index) => {
      if (item === undefined) {
        throw new CanonicalEncodingError("undefined array member", `${path}/${index}`);
      }
      if (index > 0) out.push(",");
      encode(item, `${path}/${index}`, out);
    });
    out.push("]");
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalEncodingError("not a plain object", path);
  }
  const keys = Object.keys(value as Record<string, unknown>)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort(compareUtf8);
  out.push("{");
  keys.forEach((key, index) => {
    if (index > 0) out.push(",");
    out.push(encodeString(key, `${path}/${key}`), ":");
    encode((value as Record<string, unknown>)[key], `${path}/${key}`, out);
  });
  out.push("}");
}

/**
 * The canonical JSON text of `value`. Throws {@link CanonicalEncodingError} on a float, a
 * negative or unsafe integer, a forbidden character or anything JSON has no form for.
 */
export function canonicalLayoutJson(value: unknown): string {
  const out: string[] = [];
  encode(value, "", out);
  return out.join("");
}

/** Lowercase hex SHA-256 of the canonical encoding. */
export function layoutSha256(value: unknown): string {
  return canonicalSha256(canonicalLayoutJson(value));
}

/** Lowercase hex SHA-256 of a canonical text. */
export function canonicalSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
