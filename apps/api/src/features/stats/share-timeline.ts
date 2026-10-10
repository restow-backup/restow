import type { ObjectState, RatedObject } from "../verify/summary.js";
import { isOverdue } from "../verify/summary.js";
import { type RatedSet, emptyReadinessCounts, pushTo } from "./readiness.js";
import type { ShareCheck, ShareRestorePoint, ShareRow } from "./share-facts.js";

/**
 * Recovery readiness of the file shares at any moment of the period (pure, no I/O), by the rule
 * of the overviews (features/file-shares/protection.ts) applied to what was known at that
 * moment:
 *
 *   - the newest restore point made before the moment and not pruned before it decides;
 *   - its newest restore check that ran before the moment counts (green, yellow or red as the
 *     check rated it); otherwise it is unverified;
 *   - a share without a restore point counts as unverified (the statistics count "no backup" as
 *     unverified for every kind: a backup without a verified restore counts as failed).
 *
 * A share counts at a moment when it was known then (created before it) and is protected now (in
 * an enabled share job), or had a restore point at the moment.
 */

export interface ShareReadinessAt extends RatedSet {
  readonly states: ReadonlyMap<string, ObjectState>;
}

export class ShareTimeline {
  private readonly pointsByShare = new Map<string, ShareRestorePoint[]>();

  constructor(
    private readonly shares: readonly ShareRow[],
    points: readonly ShareRestorePoint[],
  ) {
    for (const point of points) {
      pushTo(this.pointsByShare, point.shareId, point);
    }
    for (const list of this.pointsByShare.values()) {
      list.sort((a, b) => a.at.getTime() - b.at.getTime() || a.sequence - b.sequence);
    }
  }

  /** The newest restore point of a share made before `moment` and still kept at it. */
  latestAt(shareId: string, moment: Date): ShareRestorePoint | null {
    const list = this.pointsByShare.get(shareId) ?? [];
    let newest: ShareRestorePoint | null = null;
    for (const point of list) {
      if (point.at.getTime() >= moment.getTime()) {
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

  /** The newest check of a restore point that ran before `moment`. */
  static checkAt(point: ShareRestorePoint | null, moment: Date): ShareCheck | null {
    let found: ShareCheck | null = null;
    for (const check of point?.checks ?? []) {
      if (check.at.getTime() < moment.getTime() && (!found || check.at >= found.at)) {
        found = check;
      }
    }
    return found;
  }

  at(moment: Date): ShareReadinessAt {
    const counts = emptyReadinessCounts();
    const states = new Map<string, ObjectState>();
    const rated: RatedObject[] = [];
    for (const share of this.shares) {
      if (share.createdAt.getTime() >= moment.getTime()) {
        continue;
      }
      const point = this.latestAt(share.id, moment);
      if (!share.inJob && !point) {
        continue;
      }
      const check = ShareTimeline.checkAt(point, moment);
      const state: ObjectState = check ? check.readiness : point ? "unverified" : "no_backup";
      states.set(share.id, state);
      if (state === "no_backup" || state === "unverified") {
        counts.unverified += 1;
      } else {
        counts[state] += 1;
      }
      rated.push({
        state,
        overdue: isOverdue(check?.at ?? null, moment),
        checkedAt: check?.at ?? null,
        withoutJob: !share.inJob,
        share: true,
      });
    }
    return { counts, total: rated.length, rated, states };
  }
}
