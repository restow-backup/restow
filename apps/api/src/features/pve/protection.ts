import {
  pveGuestBackable,
  pveGuestCounted,
  pveGuestExcluded,
  pveJobOfGuest,
  pveRestorePointRating,
  pveStaleBackupHours,
} from "@restow/core";
import {
  type Database,
  type PveBootTestResult,
  type PveVerifyResult,
  pveGuests,
  pveJobs,
  pveNodes,
  pveRuns,
  pveSnapshots,
  pveTasks,
} from "@restow/db";
import { and, asc, count, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import {
  isFirstBackupOverdue,
  isOverdue,
  type ObjectState,
  objectStateOf,
  type RatedObject,
} from "../verify/summary.js";

/**
 * VMs and containers of Proxmox VE in the overviews (docs/PVE.md), next to the mailboxes,
 * OneDrives, IMAP accounts and the servers and clients: the dashboard's Status tab, the
 * recovery-readiness summary, GET /status, the provider view, the warnings and the statistics
 * all read a guest's standing from here, so they never disagree.
 *
 *   - Protected: present on its node, no VM template, and in an enabled PVE job (its own, or the
 *     job for all guests while it has none; `pveJobOfGuest` in @restow/core). A guest in no job
 *     is not backed up and counts as `withoutJob`.
 *   - Excluded: an administrator took the guest out of backup on purpose (`pveGuestExcluded`).
 *     It counts as `excluded` only: neither in `total` nor as `withoutJob`, and it is not rated,
 *     so it never reads as unprotected. Its restore points stay restorable.
 *   - Rated (readiness): every protected guest, and a guest in no job that still has a restore
 *     point (flagged `withoutJob`, like a machine in no job). A guest the inventory found that
 *     nobody ever put into a job is listed as "in no job", never as "no backup": the inventory
 *     reports every guest of a cluster, and many are not meant to be backed up.
 *   - Readiness: the restore check (verify) and the boot test of the newest restore point
 *     (`pveRestorePointRating`): red when either failed; a boot test is green only when the
 *     restored VM's guest agent answered, yellow when the VM only started; without a boot test
 *     the read-back decides (green when the sample matched); unverified while neither ran; no
 *     backup without a restore point (overdue once the first backup's grace period is over).
 *   - Failed: the newest finished backup run of a protected guest failed.
 *   - Overdue (`backup.overdue`, the last-backup card): no successful backup for longer than the
 *     enabled PVE jobs' schedules allow (`pveStaleBackupHours`).
 *
 * Every read runs in the tenant's pinned transaction (Row Level Security) and names the tenant.
 * PVE is part of every edition (core, Apache-2.0); nothing here is gated.
 */

export interface GuestReadinessRowDto {
  id: string;
  vmid: number;
  kind: "vm" | "ct";
  name: string | null;
  node: string | null;
  state: ObjectState;
  /** The rating of the newest restore point; null while it is unverified or without one. */
  readiness: "green" | "yellow" | "red" | null;
  /** What decided the rating: the read-back of blocks, or the boot test. */
  basis: "verify" | "boot_test" | null;
  /** The newest rated boot test of the newest restore point. */
  bootTest: { outcome: string; reason: string; message: string; checkedAt: string } | null;
  checkedAt: string | null;
  overdue: boolean;
  latestBackupAt: string | null;
  latestSnapshotId: string | null;
  /** The guest is in an enabled PVE job; false: nothing backs it up any more. */
  inJob: boolean;
  /** A restore check of the newest restore point waits for the worker's next PVE pass. */
  checkRequested: boolean;
  /** When that check was due (it waits since); null without one. */
  checkRequestedAt: string | null;
  /**
   * The check has been due for longer than {@link PVE_CHECK_OVERDUE_MS} and has not run: the
   * worker's pass did not get to it (held up, or no worker), or a run of the guest that shows
   * no sign of going on any more holds it back (`checkBlockedBy`). Time spent waiting behind a
   * run that is going (`checkWaitsFor`) does not count: that is the expected order.
   */
  checkOverdue: boolean;
  /**
   * A run of the guest still recorded as running but without a sign of life for
   * {@link PVE_RUN_SILENT_MS} (no progress report, not listed by its node): it keeps the waiting
   * check back (the worker checks no guest while one of its runs goes); the oldest such run,
   * else null.
   */
  checkBlockedBy: { kind: string; since: string } | null;
  /**
   * A run of the guest that is going (a backup that reports progress, a boot test that started
   * lately): the waiting check follows it, nothing is wrong; the oldest such run, else null.
   * Null when `checkBlockedBy` is set.
   */
  checkWaitsFor: { kind: string; since: string } | null;
  /** What the restore check of the newest restore point found (the real error, when red). */
  verifyErrors: string[];
  /**
   * Why the restore check of the newest restore point could not run, when the worker gave up
   * (yellow, `basis` verify): what restic said, e.g. who holds the repository's lock; else null.
   */
  verifyNotChecked: { reason: "locked" | "interrupted" | "error"; detail: string } | null;
}

/**
 * A restore check that has been due this long without running waits longer than expected (a
 * pass every five minutes checks up to 20 restore points): the row says so, with the reason
 * when one is known.
 */
export const PVE_CHECK_OVERDUE_MS = 30 * 60 * 1000;

/**
 * A running run whose last sign of life is older than this is not taken to be going any more:
 * its start, a backup's last progress report (every few seconds while it reads), or a fresh
 * heartbeat of its node that lists it. Longer than a restore or boot test usually takes; a run
 * nothing will close holds the guest's checks back (see `checkBlockedBy`).
 */
export const PVE_RUN_SILENT_MS = 2 * 60 * 60 * 1000;

/** A node's list of the backups it works on counts while it is this fresh (as the worker's). */
const ACTIVE_RUNS_FRESH_MS = 15 * 60 * 1000;

/** The tenant's guests in figures (zeros for a tenant without Proxmox VE). */
export interface GuestCountsDto {
  /** Guests PVE can back up (present on their node, no VM template), in a job or not, not excluded. */
  total: number;
  /** Backable guests an administrator excluded from backup; counted nowhere else. */
  excluded: number;
  /** Guests in an enabled PVE job. */
  protected: number;
  /** Guests in no enabled job: nothing backs them up. */
  withoutJob: number;
  /** Protected guests whose newest finished backup run failed. */
  failedLastBackup: number;
  /** Newest successful backup of a rated guest; null when none exists. */
  lastSuccessAt: string | null;
  /** Restore points ("Sicherungsstände") kept for the tenant's guests. */
  restorePoints: number;
}

export interface GuestProtection {
  rows: GuestReadinessRowDto[];
  /** The rated guests, as the readiness summary counts them. */
  rated: RatedObject[];
  counts: GuestCountsDto;
  /** Hours without a successful backup after which a guest reads as overdue (by the PVE jobs). */
  staleAfterHours: number;
  /** Per guest, what `backup.overdue` and the warnings need. */
  guests: GuestFact[];
}

export interface GuestFact {
  id: string;
  name: string;
  inJob: boolean;
  backable: boolean;
  /** Newest successful backup, or the newest restore point; null when there is none. */
  lastSuccessAt: Date | null;
  /** When protection started, as far as it is known: the later of the guest and its job. */
  protectedSince: Date;
  /** The newest finished backup run (null when none finished yet). */
  lastRun: {
    id: string;
    status: "succeeded" | "failed";
    finishedAt: Date;
    errorMessage: string | null;
  } | null;
  rated: boolean;
}

export const NO_GUEST_COUNTS: GuestCountsDto = {
  total: 0,
  excluded: 0,
  protected: 0,
  withoutJob: 0,
  failedLastBackup: 0,
  lastSuccessAt: null,
  restorePoints: 0,
};

/** The name a guest goes by in a list or an alert: its PVE name, else "VM 101" / "CT 101". */
export function guestName(guest: { name: string | null; kind: "vm" | "ct"; vmid: number }) {
  return guest.name?.trim() || `${guest.kind === "vm" ? "VM" : "CT"} ${guest.vmid}`;
}

function latest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Whether a running run shows a sign of life within {@link PVE_RUN_SILENT_MS}: it started
 * lately, a backup reported progress lately, or its node lists it in a fresh heartbeat.
 */
function runIsLive(
  run: {
    id: string;
    kind: string;
    startedAt: Date;
    progress: { at: string } | null;
    nodeFacts: { activeRuns?: string[]; activeRunsAt?: string } | null;
  },
  now: Date,
): boolean {
  const since = now.getTime() - PVE_RUN_SILENT_MS;
  if (run.startedAt.getTime() > since) {
    return true;
  }
  const progressAt = run.progress ? Date.parse(run.progress.at) : Number.NaN;
  if (Number.isFinite(progressAt) && progressAt > since) {
    return true;
  }
  const listedAt = run.nodeFacts?.activeRunsAt
    ? Date.parse(run.nodeFacts.activeRunsAt)
    : Number.NaN;
  return (
    run.kind === "backup" &&
    Number.isFinite(listedAt) &&
    now.getTime() - listedAt < ACTIVE_RUNS_FRESH_MS &&
    (run.nodeFacts?.activeRuns ?? []).includes(run.id)
  );
}

/**
 * How the waiting check of a guest's newest restore point stands: overdue after
 * {@link PVE_CHECK_OVERDUE_MS}, held back by a run without a sign of life (named), or waiting
 * behind a run that is going (named, and that wait is not counted: the check follows the run).
 */
export function checkWait(
  requestedAt: Date | null,
  silent: { kind: string; since: string } | null,
  live: { kind: string; since: string } | null,
  now: Date,
): Pick<GuestReadinessRowDto, "checkOverdue" | "checkBlockedBy" | "checkWaitsFor"> {
  if (requestedAt === null) {
    return { checkOverdue: false, checkBlockedBy: null, checkWaitsFor: null };
  }
  if (silent) {
    return {
      checkOverdue: now.getTime() - requestedAt.getTime() > PVE_CHECK_OVERDUE_MS,
      checkBlockedBy: silent,
      checkWaitsFor: null,
    };
  }
  // Behind a run that is going, only the wait before it started counts: a check that was due
  // for long before that run began was not got to either.
  const waitedUntil = live ? Math.min(Date.parse(live.since), now.getTime()) : now.getTime();
  return {
    checkOverdue: waitedUntil - requestedAt.getTime() > PVE_CHECK_OVERDUE_MS,
    checkBlockedBy: null,
    checkWaitsFor: live,
  };
}

/** Everything the overviews need about the tenant's guests, in its pinned transaction. */
export async function loadGuestProtection(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<GuestProtection> {
  const guests = await tx
    .select()
    .from(pveGuests)
    .where(eq(pveGuests.tenantId, tenantId))
    .orderBy(asc(pveGuests.vmid));
  const jobs = await tx
    .select({
      id: pveJobs.id,
      enabled: pveJobs.enabled,
      scopeAll: pveJobs.scopeAll,
      schedule: pveJobs.schedule,
      createdAt: pveJobs.createdAt,
    })
    .from(pveJobs)
    .where(eq(pveJobs.tenantId, tenantId));
  const staleAfterHours = pveStaleBackupHours(
    jobs.filter((job) => job.enabled).map((job) => job.schedule),
    now,
  );
  if (guests.length === 0) {
    return { rows: [], rated: [], counts: { ...NO_GUEST_COUNTS }, staleAfterHours, guests: [] };
  }

  // The newest restore point of each guest and how many each keeps.
  const newest = await tx
    .selectDistinctOn([pveSnapshots.guestId], {
      guestId: pveSnapshots.guestId,
      id: pveSnapshots.id,
      backupAt: pveSnapshots.backupAt,
      verify: pveSnapshots.verify,
      bootTest: pveSnapshots.bootTest,
      verifyRequestedAt: pveSnapshots.verifyRequestedAt,
    })
    .from(pveSnapshots)
    .where(and(eq(pveSnapshots.tenantId, tenantId), eq(pveSnapshots.status, "active")))
    .orderBy(pveSnapshots.guestId, desc(pveSnapshots.sequence));
  const newestBy = new Map(newest.map((row) => [row.guestId, row]));
  const [points] = await tx
    .select({ n: count() })
    .from(pveSnapshots)
    .where(and(eq(pveSnapshots.tenantId, tenantId), eq(pveSnapshots.status, "active")));

  // The newest finished backup run of each guest.
  const lastRuns = await tx
    .selectDistinctOn([pveRuns.guestId], {
      guestId: pveRuns.guestId,
      id: pveRuns.id,
      status: pveRuns.status,
      finishedAt: pveRuns.finishedAt,
      startedAt: pveRuns.startedAt,
      errorMessage: pveRuns.errorMessage,
    })
    .from(pveRuns)
    .where(
      and(
        eq(pveRuns.tenantId, tenantId),
        eq(pveRuns.kind, "backup"),
        ne(pveRuns.status, "running"),
      ),
    )
    .orderBy(pveRuns.guestId, desc(pveRuns.startedAt), desc(pveRuns.id));
  const lastRunBy = new Map(lastRuns.map((row) => [row.guestId, row]));

  // A first backup already under way is being worked on, not neglected. Any running run holds
  // a waiting restore check back: one that is going (`liveRunBy`, the oldest of each guest) is
  // the expected wait, one without a sign of life (`silentRunBy`) is named as the reason.
  const busy = new Set<string>();
  const liveRunBy = new Map<string, { kind: string; since: string }>();
  const silentRunBy = new Map<string, { kind: string; since: string }>();
  for (const row of await tx
    .select({
      id: pveRuns.id,
      guestId: pveRuns.guestId,
      kind: pveRuns.kind,
      startedAt: pveRuns.startedAt,
      progress: pveRuns.progress,
      nodeFacts: pveNodes.facts,
    })
    .from(pveRuns)
    .leftJoin(pveNodes, eq(pveNodes.id, pveRuns.nodeId))
    .where(and(eq(pveRuns.tenantId, tenantId), eq(pveRuns.status, "running")))
    .orderBy(asc(pveRuns.startedAt))) {
    if (row.kind === "backup") {
      busy.add(row.guestId);
    }
    const into = runIsLive(row, now) ? liveRunBy : silentRunBy;
    if (!into.has(row.guestId)) {
      into.set(row.guestId, { kind: row.kind, since: row.startedAt.toISOString() });
    }
  }
  for (const row of await tx
    .select({ guestId: pveTasks.guestId })
    .from(pveTasks)
    .where(
      and(
        eq(pveTasks.tenantId, tenantId),
        eq(pveTasks.kind, "backup"),
        inArray(pveTasks.status, ["pending", "delivered"]),
        isNotNull(pveTasks.guestId),
      ),
    )) {
    if (row.guestId) busy.add(row.guestId);
  }

  const rows: GuestReadinessRowDto[] = [];
  const rated: RatedObject[] = [];
  const facts: GuestFact[] = [];
  const counts: GuestCountsDto = { ...NO_GUEST_COUNTS };
  let lastSuccess: Date | null = null;
  counts.restorePoints = points?.n ?? 0;

  for (const guest of guests) {
    const excluded = pveGuestBackable(guest) && pveGuestExcluded(guest);
    // A guest to protect: not excluded, and no restored copy or temporary guest in no job.
    const backable = pveGuestCounted(guest);
    const job = pveJobOfGuest(guest, jobs);
    const inJob = job !== null;
    const snapshot = newestBy.get(guest.id) ?? null;
    const run = lastRunBy.get(guest.id);
    const lastRun =
      run && (run.status === "succeeded" || run.status === "failed")
        ? {
            id: run.id,
            status: run.status,
            finishedAt: run.finishedAt ?? run.startedAt,
            errorMessage: run.errorMessage,
          }
        : null;
    const guestLastSuccess = latest(guest.lastSuccessAt, snapshot?.backupAt ?? null);
    const protectedSince = job
      ? (latest(guest.createdAt, job.createdAt) ?? guest.createdAt)
      : guest.createdAt;
    // Rated: protected, or out of every job but still holding a restore point.
    const isRated = inJob || (backable && snapshot !== null);
    facts.push({
      id: guest.id,
      name: guestName(guest),
      inJob,
      backable,
      lastSuccessAt: guestLastSuccess,
      protectedSince,
      lastRun,
      rated: isRated,
    });
    if (excluded) {
      counts.excluded += 1;
    }
    if (!backable) {
      continue;
    }
    counts.total += 1;
    if (inJob) {
      counts.protected += 1;
      if (lastRun?.status === "failed") {
        counts.failedLastBackup += 1;
      }
    } else {
      counts.withoutJob += 1;
    }
    if (!isRated) {
      continue;
    }
    lastSuccess = latest(lastSuccess, guestLastSuccess);
    const verify = (snapshot?.verify ?? null) as PveVerifyResult | null;
    const bootTest = (snapshot?.bootTest ?? null) as PveBootTestResult | null;
    const rating = snapshot
      ? pveRestorePointRating(verify, bootTest)
      : { readiness: null, checkedAt: null, basis: null };
    const readiness = rating.readiness;
    const state = objectStateOf(readiness, snapshot !== null);
    const checkedAt = readiness && rating.checkedAt ? new Date(rating.checkedAt) : null;
    const requestedAt = snapshot?.verifyRequestedAt ?? null;
    const check = checkWait(
      requestedAt,
      silentRunBy.get(guest.id) ?? null,
      liveRunBy.get(guest.id) ?? null,
      now,
    );
    const overdue =
      state === "no_backup"
        ? isFirstBackupOverdue(protectedSince, now) && !busy.has(guest.id)
        : isOverdue(checkedAt, now);
    rows.push({
      id: guest.id,
      vmid: guest.vmid,
      kind: guest.kind,
      name: guest.name,
      node: guest.node,
      state,
      readiness,
      basis: readiness ? rating.basis : null,
      bootTest: bootTest
        ? {
            outcome: bootTest.outcome,
            reason: bootTest.reason,
            message: (bootTest.message ?? "").slice(0, 500),
            checkedAt: bootTest.checkedAt,
          }
        : null,
      checkedAt: checkedAt?.toISOString() ?? null,
      overdue,
      latestBackupAt: snapshot?.backupAt.toISOString() ?? null,
      latestSnapshotId: snapshot?.id ?? null,
      inJob,
      checkRequested: requestedAt !== null,
      checkRequestedAt: requestedAt?.toISOString() ?? null,
      ...check,
      verifyErrors: (verify?.errors ?? []).slice(0, 5).map((e) => String(e).slice(0, 1000)),
      verifyNotChecked: verify?.notChecked?.gaveUpAt
        ? {
            reason: verify.notChecked.reason,
            detail: String(verify.notChecked.detail ?? "").slice(0, 1000),
          }
        : null,
    });
    rated.push({ state, overdue, checkedAt, withoutJob: !inJob, guest: true });
  }
  counts.lastSuccessAt = lastSuccess?.toISOString() ?? null;
  return { rows, rated, counts, staleAfterHours, guests: facts };
}

/** The guests of a tenant on their own (the dashboard and the provider view). */
export async function loadGuestCounts(
  db: Database,
  tenantId: string,
  now: Date,
): Promise<Pick<GuestProtection, "counts" | "staleAfterHours">> {
  return withTenantTx(db, tenantId, async (tx) => {
    const { counts, staleAfterHours } = await loadGuestProtection(tx, tenantId, now);
    return { counts, staleAfterHours };
  });
}
