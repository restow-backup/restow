import { DrizzleQueryError } from "drizzle-orm";

/**
 * Reporting database errors without the query.
 *
 * Drizzle wraps every failed query in a `DrizzleQueryError` whose message is
 * `Failed query: <sql>\nparams: <bound values>`. The bound values are whatever
 * the application sent to Postgres: session tokens, verification values, mail
 * addresses, display names, job state. That text must never reach a log line,
 * an error column shown in the UI or a response. The error Drizzle wraps (its
 * `cause`: a Postgres `DatabaseError` or a socket error such as ECONNREFUSED)
 * says what went wrong without repeating the query, so that is what Restow
 * reports.
 */

/** Drizzle starts the message of a failed query with this marker. */
const FAILED_QUERY_MARKER = "Failed query: ";

/** Stands in for the query text, and for a failed query that carries no driver error. */
const QUERY_WITHHELD = "database query failed";

/** A failed query carries at most a short chain of wrappers; the bound avoids cycles. */
const MAX_UNWRAP = 5;

function isFailedQuery(error: unknown): error is Error {
  if (error instanceof DrizzleQueryError) {
    return true;
  }
  // A second copy of drizzle-orm in the dependency tree defeats `instanceof`,
  // so the shape Drizzle gives the error is recognised as well.
  return (
    error instanceof Error &&
    "query" in error &&
    "params" in error &&
    error.message.startsWith(FAILED_QUERY_MARKER)
  );
}

/**
 * The error to report for `error`: the driver error behind a failed Drizzle
 * query, `error` itself for anything else.
 */
export function reportableError(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < MAX_UNWRAP && isFailedQuery(current); depth += 1) {
    current = current.cause ?? new Error(QUERY_WITHHELD);
  }
  return isFailedQuery(current) ? new Error(QUERY_WITHHELD) : current;
}

/**
 * Cut failed-query text out of a message that was built from one, for example
 * `prune failed: ${error.message}` or a library logging `error.message`.
 */
export function withoutQueryText(message: string): string {
  const start = message.indexOf(FAILED_QUERY_MARKER);
  return start === -1 ? message : `${message.slice(0, start)}${QUERY_WITHHELD}`;
}

/**
 * The message of `error` for logs and stored error columns: the driver's
 * message for a failed query, never query text, never bound parameters.
 */
export function safeErrorMessage(error: unknown): string {
  const reportable = reportableError(error);
  const message = reportable instanceof Error ? reportable.message : String(reportable);
  return withoutQueryText(message);
}
