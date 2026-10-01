import type { WorkerExtension } from "../../../apps/worker/src/extensions.js";
import { createArchiveRetentionTask } from "./archive-retention/archive-retention.js";

/**
 * Entry of the Business and Service Provider worker modules (ee/README.md),
 * loaded by apps/worker/src/ee.ts.
 */
export const eeWorkerExtension: WorkerExtension = {
  name: "ee",
  // The archive deletion run (docs/ARCHIVE.md, `archive.retentionEnforcement`)
  // on the shared `retention` queue. It always runs on the installation pool,
  // never the per-job tenant pool: only that role may delete archive items.
  retentionTasks: ({ providerDb }) => [createArchiveRetentionTask(providerDb)],
};
