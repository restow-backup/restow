import { readJobStartPause } from "./job-start-pause.js";
import { appliedMigrationCount, shippedMigrationCount } from "./migrate.js";
import type { Queryable } from "./roles.js";

/**
 * When a process on a worker node of another host (docs/SIZING.md, "Several hosts: worker
 * nodes") must not work: the worker and the standby scheduler of a node ask it at start and every
 * {@link NODE_CHECK_INTERVAL_MS} (apps/worker node-guard.ts, apps/scheduler index.ts). The
 * updater updates the main host only, so a node may run an older image than the database:
 *
 *   version_mismatch  the database has migrations this image does not know (the main host was
 *                     updated, or is migrating right now): no work, and a scheduler gives up its
 *                     leadership, until `install.sh --update-worker` brings the node to the release
 *   update_announced  an update to another release was handed to the updater (`job_start_pause`
 *                     in phase `announced` or `fleet`): the main host stops its worker and
 *                     scheduler and migrates, so a node of the old release stops as well instead
 *                     of taking over the scheduler's leadership in that window
 *
 * A node of the release being installed (updated first) is not held by the second reason.
 */

export interface SchemaVersion {
  readonly applied: number | null;
  readonly shipped: number;
  /** The database has migrations this image does not know: it belongs to a newer release. */
  readonly newer: boolean;
}

export async function schemaVersion(db: Queryable): Promise<SchemaVersion> {
  const applied = await appliedMigrationCount(db);
  const shipped = shippedMigrationCount();
  return { applied, shipped, newer: applied !== null && applied > shipped };
}

export type NodeHoldReason = "version_mismatch" | "update_announced";

export interface NodeHold {
  readonly reason: NodeHoldReason;
  readonly applied: number | null;
  readonly shipped: number;
  /** The release of the announced update (update_announced). */
  readonly updateTo: string | null;
}

/** How often a node asks again: short, so it stops soon after the main host begins to migrate. */
export const NODE_CHECK_INTERVAL_MS = 30_000;

const bare = (version: string) => version.trim().replace(/^v/, "");

/** Why a node process of release `ownVersion` must not work now, or null. */
export async function nodeHold(db: Queryable, ownVersion: string): Promise<NodeHold | null> {
  const version = await schemaVersion(db);
  if (version.newer) {
    return {
      reason: "version_mismatch",
      applied: version.applied,
      shipped: version.shipped,
      updateTo: null,
    };
  }
  const pause = await readJobStartPause(db);
  if (
    pause.paused &&
    (pause.phase === "announced" || pause.phase === "fleet") &&
    pause.version !== null &&
    bare(pause.version) !== bare(ownVersion)
  ) {
    return {
      reason: "update_announced",
      applied: version.applied,
      shipped: version.shipped,
      updateTo: pause.version,
    };
  }
  return null;
}

/**
 * Ask now and then; call `onHold` once when the node must stop. A failed check (the database away
 * for a moment) is retried at the next interval.
 */
export function startNodeWatch(options: {
  readonly check: () => Promise<NodeHold | null>;
  readonly onHold: (hold: NodeHold) => void;
  readonly onError?: (error: unknown) => void;
  readonly intervalMs?: number;
}): () => void {
  let done = false;
  const timer = setInterval(() => {
    void options
      .check()
      .then((hold) => {
        if (hold && !done) {
          done = true;
          clearInterval(timer);
          options.onHold(hold);
        }
      })
      .catch((error: unknown) => options.onError?.(error));
  }, options.intervalMs ?? NODE_CHECK_INTERVAL_MS);
  timer.unref();
  return () => {
    done = true;
    clearInterval(timer);
  };
}

/**
 * Wait without working while the node is held, beating so Installation > Cluster shows why.
 * Resolves when the hold is gone (the update finished without new migrations, or the database
 * was restored to an older release); a node is normally updated (and so restarted) instead.
 */
export async function idleWhileHeld(options: {
  readonly check: () => Promise<NodeHold | null>;
  readonly beat: () => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly intervalMs?: number;
}): Promise<void> {
  for (;;) {
    await options.beat();
    await options.sleep(options.intervalMs ?? NODE_CHECK_INTERVAL_MS);
    try {
      if (!(await options.check())) {
        return;
      }
    } catch {
      // The database is away for a moment: ask again at the next interval.
    }
  }
}
