import { RUN_SIZE_HELD_PROBLEM, type RunSizeObjectKind, type StorageBackend } from "@restow/core";
import {
  type Database,
  type InstallationZoneInput,
  RunSizeGuard,
  type RunSizeTx,
} from "@restow/db";
import { withTenantTx } from "../../lib/tenant-context.js";

/**
 * The run size guard of the restic runs that upload through the api (#99, docs/STORAGE.md
 * "Unusually large runs"): machines (/agent/restic), file shares (/internal/file-shares/restic)
 * and Proxmox VE containers (/agent/pve/restic). One {@link RunSizeGuard} per run, in this
 * process (the api runs once): asked before every upload but a lock file, told the bytes of every
 * upload that went through. A held run is answered with 403 and the problem
 * {@link RUN_SIZE_HELD_PROBLEM}: restic takes it as final, the run ends.
 *
 * The count starts with the first upload this process sees: after an api restart in the middle
 * of a run it counts from there (the run looks smaller than it is, never larger).
 */
export class RunSizeGuards {
  private readonly guards = new Map<string, RunSizeGuard>();

  constructor(
    private readonly deps: {
      /** The application pool (Row Level Security; every transaction is pinned to the tenant). */
      db: Database;
      installationTimeZone?: InstallationZoneInput;
      /** How many runs are remembered at most (the oldest is forgotten first). */
      limit?: number;
      log?: (level: "info" | "warn", message: string, fields: Record<string, unknown>) => void;
    },
  ) {}

  /** The guard of one run; the same object for every upload of it. */
  forRun(input: {
    tenantId: string;
    kind: RunSizeObjectKind;
    objectId: string;
    runId: string;
    storage: StorageBackend;
  }): RunSizeGuard {
    const key = `${input.kind}:${input.runId}`;
    const known = this.guards.get(key);
    if (known) {
      return known;
    }
    const guard = new RunSizeGuard({
      tenantId: input.tenantId,
      kind: input.kind,
      objectId: input.objectId,
      runId: input.runId,
      transaction: (fn) => withTenantTx(this.deps.db, input.tenantId, (tx) => fn(tx as RunSizeTx)),
      space: input.storage.freeSpace
        ? async () => (await input.storage.freeSpace?.()) ?? null
        : undefined,
      installationTimeZone: this.deps.installationTimeZone,
      log: this.deps.log,
    });
    this.guards.set(key, guard);
    if (this.guards.size > (this.deps.limit ?? 2000)) {
      this.guards.delete(this.guards.keys().next().value as string);
    }
    return guard;
  }
}

/** The answer of the restic REST handler's `admitUpload` for a guard. */
export async function admitUpload(
  guard: RunSizeGuard,
  declaredBytes: number | null,
): Promise<{ type: string; detail: string } | null> {
  const admission = await guard.admit(declaredBytes ?? 0);
  return admission.ok ? null : { type: RUN_SIZE_HELD_PROBLEM, detail: admission.message };
}
