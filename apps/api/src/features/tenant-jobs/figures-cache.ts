/**
 * The figures of each tenant for the "All tenants" view of Jobs, kept for a short while (#63).
 *
 * The page refreshes every few seconds while something runs, and every provider admin who has it
 * open asks again; on an installation with many tenants each refresh would read every tenant's
 * jobs and runs. A tenant's figures are therefore read at most once per {@link FIGURES_TTL_MS}
 * and shared by every viewer and every request meanwhile (one in flight is shared too).
 *
 * Entries are keyed by tenant only: a tenant's figures are the same whoever looks, and which
 * tenants a viewer gets is decided before the cache is asked (service.ts listTenants), so no
 * viewer ever receives a tenant outside their reach. A failed read is not kept.
 */

/** How long a tenant's figures are served before they are read again. */
export const FIGURES_TTL_MS = 30_000;

interface Entry<V> {
  readAt: number;
  value: Promise<V>;
}

export class TenantFiguresCache<V> {
  readonly #entries = new Map<string, Entry<V>>();

  constructor(
    private readonly ttlMs: number = FIGURES_TTL_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  /** The tenant's figures, read with `load` unless a fresh read is kept or under way. */
  get(tenantId: string, load: () => Promise<V>): Promise<V> {
    const kept = this.#entries.get(tenantId);
    if (kept && this.#fresh(kept)) {
      return kept.value;
    }
    const value = load();
    this.#entries.set(tenantId, { readAt: this.clock(), value });
    value.catch(() => {
      if (this.#entries.get(tenantId)?.value === value) {
        this.#entries.delete(tenantId);
      }
    });
    return value;
  }

  /** Forget what is too old to be served (tenants nobody asks for any more included). */
  prune(): void {
    for (const [tenantId, entry] of this.#entries) {
      if (!this.#fresh(entry)) {
        this.#entries.delete(tenantId);
      }
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  #fresh(entry: Entry<V>): boolean {
    return this.clock() - entry.readAt < this.ttlMs;
  }
}
