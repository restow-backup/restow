import { isJobQueue, type JobQueue } from "@restow/core";

/**
 * A worker on a node of another host (docs/SIZING.md, "Several hosts: worker nodes"):
 *
 *   excluded queues  RESTOW_WORKER_EXCLUDE_QUEUES (the join writes @restow/core
 *                    `MAIN_HOST_QUEUES` into the node's .env): queues whose jobs need what only
 *                    the main host has are not consumed here; the main host's worker takes them
 *   hold             the updater updates the main host only: a node whose image is older than
 *                    the database it works on must not touch it, nor work while the main host
 *                    is being updated to another release (packages/db node-guard.ts). At start
 *                    and every 30 seconds the worker asks; when held it stops working and
 *                    reports the reason (`version_mismatch`, `update_announced`) in its
 *                    heartbeat until the hold is gone or `install.sh --update-worker` brings the
 *                    node to the release
 */

/** The queues RESTOW_WORKER_EXCLUDE_QUEUES names (comma or space separated); unknown names throw. */
export function excludedQueues(
  env: Record<string, string | undefined> = process.env,
): Set<JobQueue> {
  const raw = env.RESTOW_WORKER_EXCLUDE_QUEUES?.trim() ?? "";
  const excluded = new Set<JobQueue>();
  for (const name of raw.split(/[\s,]+/).filter((entry) => entry.length > 0)) {
    if (!isJobQueue(name)) {
      throw new Error(`RESTOW_WORKER_EXCLUDE_QUEUES names an unknown queue: ${name}`);
    }
    excluded.add(name);
  }
  return excluded;
}

/** The handlers this worker consumes: every one whose queue is not excluded. */
export function consumedHandlers<H extends { readonly queue: string }>(
  handlers: readonly H[],
  excluded: ReadonlySet<string>,
): H[] {
  return handlers.filter((handler) => !excluded.has(handler.queue));
}

// The hold of a node (schema newer than the image, an update to another release announced) is
// shared with the standby scheduler of a node: packages/db node-guard.ts.
export {
  idleWhileHeld,
  NODE_CHECK_INTERVAL_MS,
  type NodeHold,
  nodeHold,
  type SchemaVersion,
  schemaVersion,
  startNodeWatch,
} from "@restow/db";
