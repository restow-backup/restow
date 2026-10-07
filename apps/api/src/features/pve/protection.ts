import {
  pveGuestBackable,
  pveJobOfGuest,
  pveRestorePointReadiness,
  pveStaleBackupHours,
} from "@restow/core";
import {
  type Database,
  type PveVerifyResult,
  pveGuests,
  pveJobs,
  pveRuns,
  pveSnapshots,
  pveTasks,
} from "@restow/db";
import { and, asc, count, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import {
  type ObjectState,
  type RatedObject,
  isFirstBackupOverdue,
  isOverdue,
  objectStateOf,
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
 *   - Rated (readiness): every protected guest, and a guest in no job that still has a restore
 *     point (flagged `withoutJob`, like a machine in no job). A guest the inventory found that
 *     nobody ever put into a job is listed as "in no job", never as "no backup": the inventory
 *     reports every guest of a cluster, and many are not meant to be backed up.
 *   - Readiness: the restore check (verify) of the newest restore point: green when the sample
 *     read back matched, red when it did not, unverified while no check of it ran; no backup
 *     without a restore point (overdue once the first backup's grace period is over).
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
  readiness: "green" | "red" | null;
  checkedAt: string | null;
  overdue: boolean;
  latestBackupAt: string | null;
  latestSnapshotId: string | null;
  /** The guest is in an enabled PVE job; false: nothing backs it up any more. */
  inJob: boolean;
}

/** The tenant's guests in figures (zeros for a tenant without Proxmox VE). */
export interface GuestCountsDto {
  /** Guests PVE can back up (present on their node, no VM template), in a job or not. */
  total: number;
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

  // A first backup already under way is being worked on, not neglected.
  const busy = new Set<string>();
  for (const row of await tx
    .select({ guestId: pveRuns.guestId })
    .from(pveRuns)
    .where(
      and(
        eq(pveRuns.tenantId, tenantId),
        eq(pveRuns.kind, "backup"),
        eq(pveRuns.status, "running"),
      ),
    )) {
    busy.add(row.guestId);
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
    const backable = pveGuestBackable(guest);
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
    const readiness = snapshot ? pveRestorePointReadiness(verify) : null;
    const state = objectStateOf(readiness, snapshot !== null);
    const checkedAt = readiness && verify ? new Date(verify.checkedAt) : null;
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
      checkedAt: checkedAt?.toISOString() ?? null,
      overdue,
      latestBackupAt: snapshot?.backupAt.toISOString() ?? null,
      latestSnapshotId: snapshot?.id ?? null,
      inJob,
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
