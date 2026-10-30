import { type Database, protectedObjects, sources } from "@restow/db";
import { and, eq, gt, inArray, isNotNull, not, or, sql } from "drizzle-orm";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { isMissingQueueSchema } from "../jobs/queue.js";
import { enqueueBackup } from "../jobs/service.js";

/**
 * The login state of IMAP accounts as the API changes it (docs/IMAP.md "Anmeldung abgelehnt:
 * Konto abgeschaltet?"); the worker counts the failures (apps/worker imap-login-state.ts).
 *
 * A new password or a changed login of the source starts a new streak: an `active` account loses
 * its refused-login counters and an open or dismissed question, and an account an admin
 * confirmed as shut down (`login_refused`) is probed at once instead of up to a week later.
 */

/** Which accounts a reset reaches: the given objects, or every IMAP account of a source. */
export type LoginResetScope =
  | { readonly objectIds: readonly string[] }
  | { readonly sourceId: string };

/**
 * Start a new login streak for the accounts in `scope` (tenant `tenantId`). Returns the ids of the
 * shut-down accounts that are now due for a probe: the caller queues a backup job for each after
 * the transaction commits ({@link enqueueLoginProbes}); that run is the probe, and the worker
 * reactivates the account when the login works.
 */
export async function resetLoginState(
  tx: Transaction,
  tenantId: string,
  scope: LoginResetScope,
): Promise<string[]> {
  const inScope =
    "objectIds" in scope
      ? scope.objectIds.length > 0
        ? inArray(protectedObjects.id, [...scope.objectIds])
        : sql`false`
      : eq(protectedObjects.sourceId, scope.sourceId);
  const base = and(
    eq(protectedObjects.tenantId, tenantId),
    eq(protectedObjects.kind, "imap"),
    inScope,
  );
  await tx
    .update(protectedObjects)
    .set({
      loginFailedRuns: 0,
      loginFailedSince: null,
      loginFailedAt: null,
      loginQuestionAt: null,
      loginQuestionDismissedAt: null,
    })
    .where(
      and(
        base,
        eq(protectedObjects.status, "active"),
        or(gt(protectedObjects.loginFailedRuns, 0), isNotNull(protectedObjects.loginQuestionAt)),
      ),
    );
  const due = await tx
    .update(protectedObjects)
    .set({ loginProbeDueAt: sql`now()` })
    .where(
      and(
        base,
        eq(protectedObjects.status, "orphaned"),
        eq(protectedObjects.statusReason, "login_refused"),
      ),
    )
    .returning({ id: protectedObjects.id });
  return due.map((row) => row.id);
}

/**
 * Queue a backup job for each account: the login probe of a shut-down account that is due now, or
 * the backup of one an admin included again. Call it after the change committed. A job already
 * queued or running for an account is left as it is (pg-boss' singleton key); a worker that has
 * not created the queue yet queues nothing, the weekly probe or the schedule follows.
 *
 * An account whose source is `pending` or `disabled` is left out: the worker would refuse the job
 * (`config.source_not_connected` / `config.source_disabled`), a failed job row and a `job.failed`
 * webhook per account (the rule of the first-backup candidates in jobs/service.ts). A shut-down
 * account of such a source keeps `login_probe_due_at`; the scheduler's login-probe planner picks
 * it up once the source is `active` or `error`. Accounts that are neither `active` nor shut down
 * by `login_refused` are left out too.
 */
export async function enqueueLoginProbes(
  db: Database,
  tenantId: string,
  objectIds: readonly string[],
): Promise<string[]> {
  if (objectIds.length === 0) {
    return [];
  }
  try {
    return await withTenantTx(db, tenantId, async (tx) => {
      const usable = await tx
        .select({ id: protectedObjects.id })
        .from(protectedObjects)
        .innerJoin(sources, eq(sources.id, protectedObjects.sourceId))
        .where(
          and(
            eq(protectedObjects.tenantId, tenantId),
            eq(protectedObjects.kind, "imap"),
            inArray(protectedObjects.id, [...new Set(objectIds)]),
            not(inArray(sources.status, ["pending", "disabled"])),
            or(
              eq(protectedObjects.status, "active"),
              and(
                eq(protectedObjects.status, "orphaned"),
                eq(protectedObjects.statusReason, "login_refused"),
              ),
            ),
          ),
        );
      const queued: string[] = [];
      for (const { id } of usable) {
        if ((await enqueueBackup(tx, db, tenantId, id, false)) !== null) {
          queued.push(id);
        }
      }
      return queued;
    });
  } catch (error) {
    if (!isMissingQueueSchema(error)) {
      throw error;
    }
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "login probe enqueue skipped: job queue not ready",
        tenantId,
        count: objectIds.length,
      }),
    );
    return [];
  }
}

/**
 * A login of the account worked (an admin's "test login"): an `active` account loses its
 * refused-login streak and question; a shut-down one (`login_refused`) is `active` again, with
 * `active_since` starting now so the overdue clock does not count the months it was shut down
 * (the 0070 trigger clears reason, dates, confirmation and the login columns). Returns whether
 * the account was restored; the caller then queues its backup ({@link enqueueLoginProbes}).
 */
export async function markLoginWorked(
  tx: Transaction,
  tenantId: string,
  objectId: string,
): Promise<{ restored: boolean }> {
  const restored = await tx
    .update(protectedObjects)
    .set({ status: "active", activeSince: new Date(), updatedAt: sql`now()` })
    .where(
      and(
        eq(protectedObjects.tenantId, tenantId),
        eq(protectedObjects.id, objectId),
        eq(protectedObjects.status, "orphaned"),
        eq(protectedObjects.statusReason, "login_refused"),
      ),
    )
    .returning({ id: protectedObjects.id });
  if (restored.length === 0) {
    await resetLoginState(tx, tenantId, { objectIds: [objectId] });
  }
  return { restored: restored.length > 0 };
}
