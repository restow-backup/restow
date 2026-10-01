import { redactFields } from "@restow/core";
import { reportableError, withoutQueryText } from "@restow/db";
import type { BetterAuthOptions } from "better-auth";

/**
 * better-auth's log output, without query text or bound parameters.
 *
 * better-auth logs the raw error of a failed database call, for example when
 * `getSession` runs during a Postgres outage. Drizzle throws that error as a
 * `DrizzleQueryError` whose message carries the SQL and its bound values: the
 * session token, a verification value, a mail address. better-auth's default
 * logger would print it for every request until the database is back.
 *
 * This logger writes one JSON line per entry instead, like the other API logs:
 * every error is reduced to the driver error behind it (name, message, code),
 * failed-query text is cut out of plain strings, and fields named like a
 * secret are redacted. Which entries are written is still decided by
 * better-auth's log level (its default, `warn`).
 */

type AuthLoggerOptions = NonNullable<BetterAuthOptions["logger"]>;
type AuthLogLevel = Parameters<NonNullable<AuthLoggerOptions["log"]>>[0];

/** Nested log arguments are followed this deep; anything deeper is summarised. */
const MAX_DEPTH = 4;

function describeError(error: Error, depth: number): Record<string, unknown> {
  const reportable = reportableError(error);
  if (!(reportable instanceof Error)) {
    return { message: String(loggable(reportable, depth + 1)) };
  }
  const described: Record<string, unknown> = {
    name: reportable.name,
    message: withoutQueryText(reportable.message),
  };
  const code = (reportable as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") {
    described.code = code;
  }
  if (reportable.cause !== undefined) {
    described.cause = loggable(reportable.cause, depth + 1);
  }
  return described;
}

/**
 * One log argument in a form that is safe to write: errors reduced to the
 * driver error behind them, failed-query text removed, secret-named fields
 * redacted, and nothing that `JSON.stringify` cannot serialise.
 */
export function loggable(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return withoutQueryText(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return "[nested too deep]";
  }
  if (value instanceof Error) {
    return describeError(value, depth);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (ArrayBuffer.isView(value)) {
    return `<${value.byteLength} bytes>`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => loggable(item, depth + 1));
  }
  const entries = Object.entries(value).map(([key, item]) => [key, loggable(item, depth + 1)]);
  return redactFields(Object.fromEntries(entries));
}

/** The line's message: the text better-auth logged, or the message of what it logged instead. */
function headlineOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value !== null && typeof value === "object" && "message" in value) {
    return String(value.message);
  }
  return "better-auth log entry";
}

/** better-auth's `logger.log`: one JSON line, warn and error on stderr, the rest on stdout. */
export function writeAuthLog(level: AuthLogLevel, message: unknown, ...args: unknown[]): void {
  const headline = loggable(message);
  const details = args.map((arg) => loggable(arg));
  if (typeof headline !== "string") {
    // better-auth sometimes logs an error object in place of the message.
    details.unshift(headline);
  }
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    component: "better-auth",
    message: headlineOf(headline),
  };
  if (details.length > 0) {
    record.details = details;
  }
  const line = JSON.stringify(record);
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

/** The `logger` option for better-auth (apps/api/src/auth.ts). */
export const authLogger = { log: writeAuthLog } satisfies AuthLoggerOptions;
