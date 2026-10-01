/**
 * The life cycle shared by every export writer: one place that knows the export
 * is over (cancelled, corrupt, or its consumer went away), so that every wait
 * inside the writer can give up at once instead of hanging on a stream that
 * will never deliver.
 */
import type { Readable } from "node:stream";
import { JobAbortedError } from "./errors.js";

const noop = (): void => undefined;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class ExportScope {
  /** Rejects with the first error that ended the export; never resolves. */
  readonly failure: Promise<never>;
  private reject: (error: unknown) => void = noop;
  private failed: unknown = null;
  private hasFailed = false;
  private readonly tracked = new Set<Readable>();
  private readonly guarded = new WeakSet<Readable>();
  private readonly signal: AbortSignal | undefined;
  private readonly onAbort = (): void => this.raise(new JobAbortedError());

  constructor(signal?: AbortSignal) {
    this.failure = new Promise<never>((_, reject) => {
      this.reject = reject;
    });
    // Whoever awaits `failure` gets the error; nobody else may crash on it.
    this.failure.catch(noop);
    this.signal = signal;
    if (signal?.aborted) {
      this.raise(new JobAbortedError());
    } else {
      signal?.addEventListener("abort", this.onAbort, { once: true });
    }
  }

  get error(): unknown {
    return this.failed;
  }

  get isFailed(): boolean {
    return this.hasFailed;
  }

  /** End the export with `error` (the first call wins) and stop whatever is streaming. */
  raise(error: unknown): void {
    if (this.hasFailed) {
      return;
    }
    this.hasFailed = true;
    this.failed = error;
    this.reject(error);
    const reason = asError(error);
    for (const stream of this.tracked) {
      stream.destroy(reason);
    }
  }

  /** Destroy `streams` too when the export ends. */
  track(...streams: Readable[]): void {
    const reason = this.hasFailed ? asError(this.failed) : null;
    for (const stream of streams) {
      if (!this.guarded.has(stream)) {
        // A destroyed stream emits 'error'; without a listener that would crash the process.
        stream.on("error", noop);
        this.guarded.add(stream);
      }
      this.tracked.add(stream);
      if (reason !== null) {
        stream.destroy(reason);
      }
    }
  }

  /** Stop tracking streams that are finished with. */
  release(...streams: Readable[]): void {
    for (const stream of streams) {
      this.tracked.delete(stream);
    }
  }

  untrack(): void {
    this.tracked.clear();
  }

  /** Throws the error that ended the export, if it has ended. */
  throwIfFailed(): void {
    if (this.hasFailed) {
      throw this.failed;
    }
  }

  /** `promise`, or the error that ends the export first. */
  race<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, this.failure]);
  }

  dispose(): void {
    this.signal?.removeEventListener("abort", this.onAbort);
    this.untrack();
  }
}

/** Iterate a sync or async sequence one step at a time, with a close that never blocks. */
export function messageIterator<T>(input: AsyncIterable<T> | Iterable<T>): {
  next(): Promise<IteratorResult<T>>;
  close(): void;
} {
  const iterator: Iterator<T> | AsyncIterator<T> =
    Symbol.asyncIterator in input
      ? (input as AsyncIterable<T>)[Symbol.asyncIterator]()
      : (input as Iterable<T>)[Symbol.iterator]();
  return {
    next: () => Promise.resolve(iterator.next()),
    close: () => {
      try {
        void Promise.resolve(iterator.return?.()).catch(noop);
      } catch {
        // closing is best effort
      }
    },
  };
}
