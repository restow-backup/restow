/**
 * When a restore test on the machine (`verify_sample`) that could not complete
 * is offered again (docs/AGENT.md, restore test). Such a test rates nothing: no
 * report, no alert, no `job.failed`. The API applies this when it judges what
 * an agent reported (`judgeAgentRestoreTest` said `incomplete`), the worker's
 * monitor when it closes a test whose agent went silent; both offer the same
 * test again, by these rules, as a new task (the agent runs a task id once).
 */

const HOUR_MS = 60 * 60 * 1000;

/** A restore-test task the agent did not pick up expires after this long (a laptop that stayed off). */
export const RESTORE_TEST_TASK_TTL_MS = 7 * 24 * HOUR_MS;

/**
 * A restore test that could not complete is offered again after these waits
 * (1, 2, 4, 8, 16 and 24 hours), as long as its backup is the newest; after
 * that the next backup brings a new test. Never sooner: a machine whose disk is
 * full must not run a test on every heartbeat.
 */
export const RESTORE_TEST_RETRY_DELAYS_MS: readonly number[] = [1, 2, 4, 8, 16, 24].map(
  (hours) => hours * HOUR_MS,
);

/** The `params` of a `verify_sample` task as the server writes them. */
export interface RestoreTestTaskParams {
  snapshotId?: string;
  files?: { path: string; sha256: string }[];
  /** How often this test was offered again after it could not complete (1 to 6). */
  retry?: number;
  /** A test offered again is not handed out before this time (ISO-8601, UTC). */
  notBefore?: string;
}

export interface RestoreTestRetry {
  params: Required<RestoreTestTaskParams>;
  expiresAt: Date;
}

/**
 * The task that offers a test which could not complete again: the same
 * snapshot and files, the next retry number, handed out only from `notBefore`
 * and expiring {@link RESTORE_TEST_TASK_TTL_MS} after it. `null` when it is not
 * offered again: the task names no snapshot or no files, its waits are used up,
 * the machine is no longer active, or the snapshot is no longer the machine's
 * newest backup (a rating of an older one does not count).
 */
export function restoreTestRetry(
  params: RestoreTestTaskParams,
  endpoint: { status: string; lastSnapshotId: string | null },
  now: Date,
): RestoreTestRetry | null {
  const { snapshotId } = params;
  const files = Array.isArray(params.files) ? params.files : [];
  if (typeof snapshotId !== "string" || snapshotId === "" || files.length === 0) {
    return null;
  }
  const done =
    typeof params.retry === "number" && Number.isInteger(params.retry) && params.retry > 0
      ? params.retry
      : 0;
  const retry = done + 1;
  const delay = RESTORE_TEST_RETRY_DELAYS_MS[retry - 1];
  if (
    delay === undefined ||
    endpoint.status !== "active" ||
    endpoint.lastSnapshotId !== snapshotId
  ) {
    return null;
  }
  const notBefore = new Date(now.getTime() + delay);
  return {
    params: { snapshotId, files, retry, notBefore: notBefore.toISOString() },
    expiresAt: new Date(notBefore.getTime() + RESTORE_TEST_TASK_TTL_MS),
  };
}

/**
 * Whether a test of `snapshotId` already waits among `waiting` (the
 * endpoint's pending or delivered `verify_sample` tasks), leaving out the task
 * that could not complete: a test is never offered twice.
 */
export function restoreTestAlreadyWaiting(
  waiting: readonly { id: string; params: unknown }[],
  snapshotId: string,
  exceptTaskId: string,
): boolean {
  return waiting.some(
    (task) =>
      task.id !== exceptTaskId &&
      (task.params as RestoreTestTaskParams | null)?.snapshotId === snapshotId,
  );
}
