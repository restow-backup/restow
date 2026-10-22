import type { WorkerExtension, WorkerGatedFeature } from "../../../apps/worker/src/extensions.js";
import { type Capability, installationHasCapability } from "../../licensing/src/index.js";
import { createArchiveRetentionTask } from "./archive-retention/archive-retention.js";

/**
 * Which capability opens each gated worker feature; the same mapping as the API's
 * (ee/api/src/license/gate.ts `FEATURE_CAPABILITIES`).
 */
export const WORKER_FEATURE_CAPABILITIES: Readonly<Record<WorkerGatedFeature, Capability>> = {
  "archive.mailboxCapture": "archive.mailboxCapture",
  "archive.smtpCapture": "archive.journalReceiver",
};

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
  // The core's gated work (archive capture from the mailbox), decided by the installed
  // license on the installation pool, read on every check.
  features: ({ providerDb }) => ({
    isEnabled: (feature) =>
      installationHasCapability(providerDb, WORKER_FEATURE_CAPABILITIES[feature]),
  }),
};
