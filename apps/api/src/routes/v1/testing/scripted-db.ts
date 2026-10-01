import type { Database } from "@restow/db";

/**
 * A scripted stand-in for the Drizzle database in route tests. Every query
 * builder chain (`select().from().where()...`) resolves, when awaited, to the
 * next queued result, in the order the code under test awaits its queries.
 * Transactions run their callback directly; `execute` (the tenant pin) always
 * succeeds without consuming a result. Nothing here knows SQL: a test states
 * what each query returns, and `pending()` proves every result was consumed.
 */

export interface ScriptedDb {
  db: Database;
  /** Results queued but not consumed yet. */
  pending(): number;
  /** Statements run through `execute` (e.g. the tenant pin). */
  executed: number;
}

export function scriptedDb(results: readonly unknown[][]): ScriptedDb {
  const queue = [...results];

  const chain = (): unknown =>
    new Proxy(() => undefined, {
      get(_target, property) {
        if (property === "then") {
          const next = queue.shift();
          return (resolve: (value: unknown) => void, reject: (reason: unknown) => void) =>
            next === undefined
              ? reject(new Error("scripted db: a query ran with no result queued"))
              : resolve(next);
        }
        return () => chain();
      },
    });

  const state = { executed: 0 };
  const builders = {
    select: chain,
    selectDistinctOn: chain,
    insert: chain,
    update: chain,
    delete: chain,
    execute: async () => {
      state.executed += 1;
      return { rows: [] };
    },
  };
  const tx: Record<string, unknown> = {
    ...builders,
    rollback: () => {
      throw new Error("scripted db: rollback");
    },
  };
  tx.transaction = (fn: (inner: unknown) => Promise<unknown>) => fn(tx);
  const db = { ...builders, transaction: (fn: (inner: unknown) => Promise<unknown>) => fn(tx) };

  return {
    db: db as unknown as Database,
    pending: () => queue.length,
    get executed() {
      return state.executed;
    },
  };
}
