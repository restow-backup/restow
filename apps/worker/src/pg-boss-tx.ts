import { type SQL, type SQLChunk, sql } from "drizzle-orm";
import type PgBoss from "pg-boss";

/**
 * Run pg-boss' SQL inside a Drizzle transaction.
 *
 * pg-boss hands its statements to a `Db.executeSql(text, values)` with
 * node-postgres style `$n` placeholders. Drizzle's `execute` only takes its
 * own `SQL` objects, so the text is split at the placeholders and each one
 * becomes a bound parameter again (`sql.param`, which binds arrays and
 * objects as one value instead of expanding them into a list). Placeholders
 * may repeat; every occurrence binds the same value. That is what lets a
 * handler send a follow-up job and write its `jobs` row (and audit entry) in
 * one tenant-pinned transaction, the same way apps/api's queue does for the
 * API's own enqueues.
 *
 * Kept as apps/worker's own copy of apps/api's `features/jobs/pg-boss-tx.ts`:
 * the worker cannot import from apps/api, and this module has no other home
 * that does not pull `pg-boss` or `drizzle-orm` into a package that should
 * not depend on them (@restow/core never touches the database).
 */

const PLACEHOLDER = /\$(\d+)/g;

export function toDrizzleSql(text: string, values: readonly unknown[]): SQL {
  const parts: SQLChunk[] = [];
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const index = Number(match[1]) - 1;
    if (index < 0 || index >= values.length) {
      throw new RangeError(`placeholder ${match[0]} has no value (${values.length} given)`);
    }
    parts.push(sql.raw(text.slice(last, match.index)));
    parts.push(sql.param(values[index]));
    last = match.index + match[0].length;
  }
  parts.push(sql.raw(text.slice(last)));
  return sql.join(parts);
}

/** Anything that can run a Drizzle `SQL` and answer with rows (a transaction, the database). */
export interface SqlExecutor {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
}

/** A pg-boss `Db` that routes every statement through `executor`. */
export function pgBossExecutor(executor: SqlExecutor): PgBoss.Db {
  return {
    executeSql: async (text, values) => {
      const result = await executor.execute(toDrizzleSql(text, values));
      return { rows: result.rows };
    },
  };
}
