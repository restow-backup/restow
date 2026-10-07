/**
 * When a Proxmox VE guest counts as protected, how its newest restore point is rated and after
 * how long without a successful backup it reads as overdue (docs/PVE.md). Pure, shared by the
 * API (overview, readiness, statistics, warnings) and the worker (`backup.overdue`), so every
 * view counts a guest the same way.
 */
import { staleBackupHours } from "../backup-jobs/schedule.js";
import type { PveSchedule } from "./model.js";

/** The guest fields the rule reads (a subset of the `pve_guests` row). */
export interface PveGuestMembership {
  readonly jobId: string | null;
  readonly kind: "vm" | "ct";
  readonly template: boolean;
  readonly present: boolean;
}

/** The job fields the rule reads (a subset of the `pve_jobs` row). */
export interface PveJobMembership {
  readonly id: string;
  readonly enabled: boolean;
  readonly scopeAll: boolean;
}

/**
 * Whether a guest is backed up at all: it is still reported by its node, it is no VM template
 * (PVE cannot back those up through a provider) and it is in an enabled job. That is its own
 * job, or, while it has none, the tenant's job for "all guests". A guest whose own job is
 * paused is not covered by the "all guests" job either (the worker plans it the same way,
 * apps/worker pve/maintenance.ts `coveredBy`).
 */
export function pveJobOfGuest<J extends PveJobMembership>(
  guest: PveGuestMembership,
  jobs: readonly J[],
): J | null {
  if (!pveGuestBackable(guest)) {
    return null;
  }
  if (guest.jobId !== null) {
    const own = jobs.find((job) => job.id === guest.jobId);
    return own?.enabled ? own : null;
  }
  return jobs.find((job) => job.scopeAll && job.enabled) ?? null;
}

/** A guest PVE can back up: present on its node and no VM template. */
export function pveGuestBackable(guest: Pick<PveGuestMembership, "kind" | "template" | "present">) {
  return guest.present && !(guest.kind === "vm" && guest.template);
}

/** The result of the weekly read-back of a restore point (`pve_snapshots.verify`). */
export interface PveVerifyFact {
  readonly checkedAt: string;
  readonly mismatched: number;
  readonly errors: readonly string[];
}

/**
 * The rating of a restore point by its restore check: green when the sample read back matched,
 * red when a block did not match or could not be read; null while no check of it ran (the
 * restore point is unverified, never fine).
 */
export function pveRestorePointReadiness(
  verify: PveVerifyFact | null | undefined,
): "green" | "red" | null {
  if (!verify || typeof verify.checkedAt !== "string") {
    return null;
  }
  return verify.mismatched > 0 || (verify.errors?.length ?? 0) > 0 ? "red" : "green";
}

/**
 * After how many hours without a successful backup a guest reads as overdue: twice the longest
 * planned gap of the most relaxed enabled PVE job (`staleBackupHours`), two days without any.
 * A job without a schedule is never planned (it only runs by hand) and says nothing.
 */
export function pveStaleBackupHours(
  schedules: readonly (PveSchedule | null | undefined)[],
  now: Date,
): number {
  return staleBackupHours(
    schedules.map((schedule) =>
      schedule
        ? {
            kind: schedule.kind,
            timeZone: schedule.timeZone,
            timeOfDay: schedule.timeOfDay,
            // pveNextRunAt plans an interval without minutes as a day.
            intervalMinutes:
              schedule.kind === "interval" ? (schedule.intervalMinutes ?? 24 * 60) : undefined,
          }
        : null,
    ),
    now,
  );
}
