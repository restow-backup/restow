import { ProblemError } from "../../problem.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";

/**
 * Limits the restic processes the API runs for browsing and downloads. Each
 * one is a child process that reads a repository, so a few users clicking
 * through big snapshots must not be able to starve the server: at most
 * `total` at once, at most `perTenant` of them for one tenant. A request over
 * the limit is refused at once (429) instead of queueing without bound.
 */
export class ResticGate {
  private active = 0;
  private readonly perTenantActive = new Map<string, number>();

  constructor(
    private readonly total = 6,
    private readonly perTenant = 3,
  ) {}

  /** Take a slot; the returned function gives it back (call it exactly once). */
  acquire(tenantId: string): () => void {
    const tenantActive = this.perTenantActive.get(tenantId) ?? 0;
    if (this.active >= this.total || tenantActive >= this.perTenant) {
      throw new ProblemError(429, "Server busy", {
        type: ENDPOINT_PROBLEMS.resticBusy,
        detail: "Too many snapshot reads are running. Try again in a moment.",
        extensions: { retryAfterSeconds: 5 },
      });
    }
    this.active += 1;
    this.perTenantActive.set(tenantId, tenantActive + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active -= 1;
      const left = (this.perTenantActive.get(tenantId) ?? 1) - 1;
      if (left <= 0) {
        this.perTenantActive.delete(tenantId);
      } else {
        this.perTenantActive.set(tenantId, left);
      }
    };
  }

  /** Run `work` while holding a slot. */
  async run<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    const release = this.acquire(tenantId);
    try {
      return await work();
    } finally {
      release();
    }
  }
}

export const resticGate = new ResticGate();
