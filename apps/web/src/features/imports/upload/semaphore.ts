import { UploadAborted } from "./errors";

/**
 * Counting semaphore: at most `limit` holders at a time, granted in request
 * order. It bounds the segments in flight, and with them the memory the engine
 * holds (one segment per slot).
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<{ grant: () => void }> = [];

  constructor(limit: number) {
    this.available = Math.max(1, Math.floor(limit));
  }

  /** Wait for a slot; the returned function gives it back (idempotent). Rejects when `signal` fires first. */
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(new UploadAborted());
    }
    return new Promise((resolve, reject) => {
      const release = this.releaser();
      const waiter = {
        grant: () => {
          signal.removeEventListener("abort", onAbort);
          resolve(release);
        },
      };
      const onAbort = () => {
        const position = this.waiters.indexOf(waiter);
        if (position >= 0) {
          this.waiters.splice(position, 1);
        }
        reject(new UploadAborted());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (this.available > 0) {
        this.available -= 1;
        waiter.grant();
      } else {
        this.waiters.push(waiter);
      }
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next.grant();
      } else {
        this.available += 1;
      }
    };
  }
}
