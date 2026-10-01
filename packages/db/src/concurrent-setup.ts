/**
 * Retrying start-up work that races with another process.
 *
 * The worker and the scheduler both create the pg-boss schema and its queues
 * when they start, usually at the same moment on a fresh installation. Postgres
 * then aborts one of the two transactions with a deadlock (40P01), or refuses a
 * concurrent `CREATE` with a unique violation (23505) or a serialization
 * failure (40001). None of these means anything is wrong: the other process
 * already did the work, and running it again succeeds. Retrying here keeps a
 * fresh start free of crashes and error lines instead of relying on the
 * container restart policy.
 */

/** Postgres SQLSTATE codes that a concurrent start can cause and a retry resolves. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set(["40P01", "40001", "23505"]);

/** The SQLSTATE of a Postgres error, also when it is wrapped (e.g. by Drizzle). */
function sqlStateOf(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === "object" && current !== null) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
        return code;
      }
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return null;
}

export function isConcurrentSetupConflict(error: unknown): boolean {
  const code = sqlStateOf(error);
  return code !== null && RETRYABLE_CODES.has(code);
}

export interface ConcurrentSetupOptions {
  /** Attempts in total, including the first one. */
  readonly attempts?: number;
  /** Base delay before the second attempt; later attempts double it, plus jitter. */
  readonly baseDelayMs?: number;
  /** Called before each retry, e.g. to log at info level. */
  readonly onRetry?: (info: { attempt: number; code: string | null; delayMs: number }) => void;
  /** Test seam. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs `work`, and runs it again when it failed only because another process
 * set up the same objects at the same time. Any other error is thrown at once.
 */
export async function retryConcurrentSetup<T>(
  work: () => Promise<T>,
  options: ConcurrentSetupOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= attempts || !isConcurrentSetupConflict(error)) {
        throw error;
      }
      const delayMs = Math.round(baseDelayMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.5));
      options.onRetry?.({ attempt, code: sqlStateOf(error), delayMs });
      await sleep(delayMs);
    }
  }
}
