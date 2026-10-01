/**
 * The handler registry: one entry per queue.
 *
 * Each queue's handler lives in ./<queue>.ts and exports `<queue>Handler`
 * built on the framework (./framework.ts). List it here to activate it; the
 * process entrypoint registers every listed handler with pg-boss and refuses
 * to start on a duplicate queue.
 *
 * Not listed, because they are not tenant queue handlers: the webhook
 * dispatcher (./webhooks.ts, a polling service over `webhook_deliveries`) and
 * the nightly audit anchor (./audit-anchor.ts, its own cron queue across all
 * chains). The entrypoint starts both next to the queue workers.
 */
import { backupHandler } from "./backup.js";
import { directoryHandler } from "./directory.js";
import { exportHandler } from "./export.js";
import type { AnyJobHandler } from "./framework.js";
import { importHandler } from "./import.js";
import { restoreHandler } from "./restore.js";
import { retentionHandler } from "./retention.js";
import { scrubHandler } from "./scrub.js";
import { storageMigrationHandler } from "./storage-migration.js";
import { verifyHandler } from "./verify.js";

export const handlers: AnyJobHandler[] = [
  // Restores come first in the list as in priority: they are user requests.
  restoreHandler,
  backupHandler,
  verifyHandler,
  directoryHandler,
  retentionHandler,
  scrubHandler,
  storageMigrationHandler,
  importHandler,
  exportHandler,
];
