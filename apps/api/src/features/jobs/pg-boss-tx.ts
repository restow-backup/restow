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
 * may repeat (`$5` is used three times in pg-boss' insert); every occurrence
 * binds the same value. That is what lets the API create the pg-boss job and
 * the Restow `jobs` row in one tenant-pinned transaction, exactly like the
 * scheduler does.
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
