import {
  type Logger,
  listBackupTargets,
  postJobWhenIdle,
  triggerBackup,
  triggerVerify,
  waitForJobs,
} from "./api-seed.js";
import type { ApiClient } from "./http-client.js";

/**
 * The demo's simulated history (deploy/demo/README.md, "History"): after the
 * first backup, one round per simulated day — the day's new mail lands in
 * the mailboxes, then every mailbox is backed up and every tenant verified,
 * and every few days one mailbox folder is restored as a download. All of it
 * runs for real; backdate.ts afterwards moves each round to its day.
 */

export interface HistoryTenant {
  id: string;
  name: string;
}

export interface RoundOutcome {
  backupsCompleted: number;
  backupsFailed: number;
  verificationsCompleted: number;
  verificationsFailed: number;
  restoresCompleted: number;
  restoresFailed: number;
}

/** Every how many rounds a download restore is part of the round. */
export const RESTORE_EVERY = 6;

/** Pure: whether round `round` restores, and for which tenant (by index). */
export function restorePlanFor(round: number, tenantCount: number): number | null {
  if (tenantCount === 0 || round === 0 || round % RESTORE_EVERY !== 0) {
    return null;
  }
  return (round / RESTORE_EVERY - 1) % tenantCount;
}

interface RestoreCreated {
  jobId: string;
}

/** Restore one mailbox's INBOX from its newest snapshot as a ZIP download. */
async function restoreInbox(
  client: ApiClient,
  tenantId: string,
  timeoutMs: number,
  log: Logger,
): Promise<{ completed: number; failed: number }> {
  const [object] = (await listBackupTargets(client, tenantId)).filter((o) => o.lastSnapshot);
  if (!object?.lastSnapshot) {
    return { completed: 0, failed: 0 };
  }
  const created = await postJobWhenIdle<RestoreCreated>(
    client,
    "/api/v1/restore",
    {
      snapshotId: object.lastSnapshot.id,
      selection: [{ path: "mail/INBOX", kind: "folder" }],
      target: { type: "download" },
      reason: "Demo history: restore test of the inbox",
    },
    tenantId,
    timeoutMs,
    log,
  );
  return waitForJobs(client, tenantId, [created.jobId], timeoutMs);
}

/** One simulated day: back up every mailbox, verify, sometimes restore. */
export async function runRound(
  client: ApiClient,
  tenants: readonly HistoryTenant[],
  round: number,
  timeoutMs: number,
  log: Logger,
): Promise<RoundOutcome> {
  const outcome: RoundOutcome = {
    backupsCompleted: 0,
    backupsFailed: 0,
    verificationsCompleted: 0,
    verificationsFailed: 0,
    restoresCompleted: 0,
    restoresFailed: 0,
  };
  for (const tenant of tenants) {
    for (const object of await listBackupTargets(client, tenant.id)) {
      if (object.status !== "active") {
        continue;
      }
      const jobIds = await triggerBackup(client, tenant.id, object.id, timeoutMs, log);
      const done = await waitForJobs(client, tenant.id, jobIds, timeoutMs);
      outcome.backupsCompleted += done.completed;
      outcome.backupsFailed += done.failed;
    }
    // The worker follows a backup with a verify of its own when a verify
    // schedule exists; triggering one more waits that one out
    // (postJobWhenIdle), so nothing of this round is still running when the
    // round's window closes.
    const verifyIds = await triggerVerify(client, tenant.id, timeoutMs, log);
    const verified = await waitForJobs(client, tenant.id, verifyIds, timeoutMs);
    outcome.verificationsCompleted += verified.completed;
    outcome.verificationsFailed += verified.failed;
  }
  const restoreTenant = restorePlanFor(round, tenants.length);
  if (restoreTenant !== null) {
    const tenant = tenants[restoreTenant] as HistoryTenant;
    log(`round ${round}: restoring an inbox of ${tenant.name} as a download...`);
    const restored = await restoreInbox(client, tenant.id, timeoutMs, log);
    outcome.restoresCompleted += restored.completed;
    outcome.restoresFailed += restored.failed;
  }
  return outcome;
}
