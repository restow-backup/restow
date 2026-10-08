import type { ObjectState, RatedObject } from "../verify/summary.js";
import { isOverdue } from "../verify/summary.js";
import type { GuestRestorePoint, GuestRow } from "./guest-facts.js";
import { type RatedSet, emptyReadinessCounts, pushTo } from "./readiness.js";

/**
 * Recovery readiness of the VMs and containers of Proxmox VE at any moment of the period (pure,
 * no I/O), by the rule of the overviews (features/pve/protection.ts) applied to what was known
 * at that moment:
 *
 *   - the newest restore point made before the moment and not pruned before it decides;
 *   - its restore check counts once it ran before the moment: green when the sample read back
 *     matched, red when it did not; otherwise it is unverified;
 *   - a guest without a restore point counts as unverified (the statistics count "no backup"
 *     as unverified for every kind: a backup without a verified restore counts as failed).
 *
 * A guest counts at a moment when it was known then (created before it) and is protected now (in
 * an enabled job), or had a restore point at the moment.
 */

export interface GuestReadinessAt extends RatedSet {
  readonly states: ReadonlyMap<string, ObjectState>;
}

export class GuestTimeline {
  private readonly pointsByGuest = new Map<string, GuestRestorePoint[]>();

  constructor(
    private readonly guests: readonly GuestRow[],
    points: readonly GuestRestorePoint[],
  ) {
    for (const point of points) {
      pushTo(this.pointsByGuest, point.guestId, point);
    }
    for (const list of this.pointsByGuest.values()) {
      list.sort((a, b) => a.backupAt.getTime() - b.backupAt.getTime() || a.sequence - b.sequence);
    }
  }

  /** The newest restore point of a guest made before `moment` and still kept at it. */
  latestAt(guestId: string, moment: Date): GuestRestorePoint | null {
    const list = this.pointsByGuest.get(guestId) ?? [];
    let newest: GuestRestorePoint | null = null;
    for (const point of list) {
      if (point.backupAt.getTime() >= moment.getTime()) {
        break;
      }
      if (point.prunedAt !== null && point.prunedAt.getTime() < moment.getTime()) {
        continue;
      }
      if (!newest || point.sequence > newest.sequence) {
        newest = point;
      }
    }
    return newest;
  }

  at(moment: Date): GuestReadinessAt {
    const counts = emptyReadinessCounts();
    const states = new Map<string, ObjectState>();
    const rated: RatedObject[] = [];
    for (const guest of this.guests) {
      if (guest.createdAt.getTime() >= moment.getTime()) {
        continue;
      }
      const point = this.latestAt(guest.id, moment);
      if (!guest.inJob && !point) {
        continue;
      }
      const check =
        point?.check && point.check.at.getTime() < moment.getTime() ? point.check : null;
      const state: ObjectState = check ? check.readiness : point ? "unverified" : "no_backup";
      states.set(guest.id, state);
      if (state === "no_backup" || state === "unverified") {
        counts.unverified += 1;
      } else {
        counts[state] += 1;
      }
      rated.push({
        state,
        overdue: isOverdue(check?.at ?? null, moment),
        checkedAt: check?.at ?? null,
        withoutJob: !guest.inJob,
        guest: true,
      });
    }
    return { counts, total: rated.length, rated, states };
  }
}
