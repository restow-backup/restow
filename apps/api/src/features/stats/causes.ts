/**
 * Grouping item failures by cause (pure, no I/O).
 *
 * The worker stores one `item_failures.reason` per failed item, written by
 * the engines as a one-line message: Graph errors as
 * `Graph <status> <code>: <message>` (packages/core describeError), anything
 * else as the error's own words. Raw reasons differ in ids and counters, so
 * a table of them would list the same problem a hundred times. A cause keeps
 * what identifies the problem and drops what identifies the item:
 *
 *   - a Graph error is its status and code ("Graph 404 ErrorItemNotFound"),
 *   - any other reason is its first line with UUIDs, long hex digests and
 *     long numbers replaced by "…", cut to {@link MAX_CAUSE_LENGTH} characters.
 */

export const MAX_CAUSE_LENGTH = 160;

/** Causes listed in the table; the rest is summed up by the totals (KPI failedItems). */
export const MAX_CAUSES = 20;

/** Stands in for a reason the worker left empty. */
export const UNKNOWN_CAUSE = "unknown";

const GRAPH_PATTERN = /^Graph (\d{3})(?: ([A-Za-z][\w.-]*))?:/;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Hex-looking words of eight or more characters; replaced only when they contain a digit. */
const HEX_PATTERN = /\b[0-9a-f]{8,}\b/gi;
const LONG_NUMBER_PATTERN = /\d{5,}/g;
const ELLIPSIS = "…";

/** The cause a stored failure reason belongs to (see the module comment). */
export function failureCause(reason: string): string {
  const firstLine = reason.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) {
    return UNKNOWN_CAUSE;
  }
  const graph = GRAPH_PATTERN.exec(firstLine);
  if (graph) {
    const [, status, code] = graph;
    return code ? `Graph ${status} ${code}` : `Graph ${status}`;
  }
  const normalized = firstLine
    .replace(UUID_PATTERN, ELLIPSIS)
    .replace(HEX_PATTERN, (token) => (/\d/.test(token) ? ELLIPSIS : token))
    .replace(LONG_NUMBER_PATTERN, ELLIPSIS)
    .replace(/\s+/g, " ");
  return normalized.length > MAX_CAUSE_LENGTH
    ? `${normalized.slice(0, MAX_CAUSE_LENGTH - 1)}${ELLIPSIS}`
    : normalized;
}

export interface ReasonCount {
  readonly reason: string;
  readonly count: number;
  readonly lastAt: Date;
}

export interface CauseCount {
  readonly cause: string;
  readonly count: number;
  readonly lastAt: Date;
}

/**
 * Fold reason counts into cause counts, most frequent first (the most recent
 * breaks a tie, then the cause text so the order is stable).
 */
export function groupByCause(rows: readonly ReasonCount[]): CauseCount[] {
  const byCause = new Map<string, { count: number; lastAt: Date }>();
  for (const row of rows) {
    const cause = failureCause(row.reason);
    const entry = byCause.get(cause);
    if (entry) {
      entry.count += row.count;
      if (row.lastAt.getTime() > entry.lastAt.getTime()) {
        entry.lastAt = row.lastAt;
      }
    } else {
      byCause.set(cause, { count: row.count, lastAt: row.lastAt });
    }
  }
  return sortCauses([...byCause].map(([cause, entry]) => ({ cause, ...entry })));
}

/** Most frequent first, then the most recent, then the cause text. */
export function sortCauses(causes: readonly CauseCount[]): CauseCount[] {
  return [...causes].sort(
    (a, b) =>
      b.count - a.count ||
      b.lastAt.getTime() - a.lastAt.getTime() ||
      (a.cause < b.cause ? -1 : a.cause > b.cause ? 1 : 0),
  );
}
