/**
 * Small readers for the SQL Server parts of the agent contract (W2a): every field is checked and
 * bounded where it is read, and a value that does not fit is dropped rather than refused, so a
 * heartbeat or the end of a run always counts (like @restow/core `parseRunConsistency`).
 */
import { redactAgentMessage } from "../run-redact.js";

export type Json = Record<string, unknown>;

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** A plain text without control characters, at most `max` code points; null when not a string. */
export function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return Array.from(value.replace(CONTROL, "")).slice(0, max).join("");
}

/** A non-empty name without control characters, at most `max` code points; null otherwise. */
export function name(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a name with control characters is refused
  if (/[\u0000-\u001f]/.test(value) || Array.from(value).length > max) {
    return null;
  }
  return value;
}

/** An agent message, redacted like run errors (credentials, tokens) and cut to 1000 characters. */
export function message(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? redactAgentMessage(value, 1000) : undefined;
}

export function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** A whole number within the bounds; null otherwise. */
export function int(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

/** An LSN: a decimal string of numeric(25,0) (larger than 2^53, so never a JSON number). */
export function lsn(value: unknown): string | null {
  return typeof value === "string" && /^\d{1,25}$/.test(value)
    ? value.replace(/^0+(?=\d)/, "")
    : null;
}

/** A GUID in lower case with dashes. */
export function guid(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

export function sha256(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
}

/** A full restic snapshot id (the SQL runs always report the whole id). */
export function snapshotId(value: unknown): string | null {
  return sha256(value);
}

/** An RFC 3339 time as an ISO string; null when it is none. */
export function time(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** A path inside a snapshot: absolute, no control characters. */
export function snapshotPath(value: unknown): string | null {
  const path = name(value, 4096);
  return path?.startsWith("/") ? path : null;
}

/** The elements of an array that `read` accepts, at most `max` of them; [] for no array. */
export function list<T>(value: unknown, max: number, read: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: T[] = [];
  for (const item of value.slice(0, max)) {
    const parsed = read(item);
    if (parsed !== null) {
      out.push(parsed);
    }
  }
  return out;
}

/** A lower-case code such as `sql_login_missing`; null otherwise. */
export function code(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : null;
}

/** `{...}` with the keys whose value is not undefined. */
export function compact<T extends Json>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

export function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}
