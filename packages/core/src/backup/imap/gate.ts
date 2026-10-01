/**
 * A shared/exclusive gate that keeps checkpoints consistent with parallel
 * downloads.
 *
 * Folder workers write objects under a shared hold; a checkpoint takes the
 * exclusive hold. Without it a worker could add an object to the manifest
 * after the checkpoint flushed the packs but before it serialized the partial
 * manifest, leaving the partial pointing at chunks that never reached storage;
 * a resumed job would then fail at commit ("chunk not locatable") on every
 * retry. Exclusive requests take precedence over new shared requests so a
 * checkpoint cannot be starved.
 */
export class ReadWriteGate {
  private sharedHolders = 0;
  private exclusiveHeld = false;
  private readonly sharedWaiters: Array<() => void> = [];
  private readonly exclusiveWaiters: Array<() => void> = [];

  async shared<T>(fn: () => Promise<T>): Promise<T> {
    if (this.exclusiveHeld || this.exclusiveWaiters.length > 0) {
      await new Promise<void>((resolve) => this.sharedWaiters.push(resolve));
    } else {
      this.sharedHolders++;
    }
    try {
      return await fn();
    } finally {
      this.sharedHolders--;
      this.dispatch();
    }
  }

  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.exclusiveHeld || this.sharedHolders > 0) {
      await new Promise<void>((resolve) => this.exclusiveWaiters.push(resolve));
    } else {
      this.exclusiveHeld = true;
    }
    try {
      return await fn();
    } finally {
      this.exclusiveHeld = false;
      this.dispatch();
    }
  }

  /** Grants are recorded synchronously here so a waiter never re-checks state after waking. */
  private dispatch(): void {
    if (this.exclusiveHeld) {
      return;
    }
    if (this.exclusiveWaiters.length > 0) {
      if (this.sharedHolders === 0) {
        this.exclusiveHeld = true;
        const next = this.exclusiveWaiters.shift();
        next?.();
      }
      return;
    }
    const waiters = this.sharedWaiters.splice(0);
    this.sharedHolders += waiters.length;
    for (const wake of waiters) {
      wake();
    }
  }
}
