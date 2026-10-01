import type { RatedReport } from "../verify/verification-state.js";
import type { ReasonCount } from "./causes.js";
import type { TenantRefDto } from "./dto.js";
import type { EndpointFacts } from "./endpoint-facts.js";

/**
 * What the statistics read from one tenant's tables (collect.ts), before
 * anything is bucketed or added up (aggregate.ts). Per-day rows are keyed by
 * the UTC day (`YYYY-MM-DD`) an event happened on.
 */

export type ProtectedObjectKind = "mailbox" | "onedrive" | "imap";
export type ProtectedObjectStatus = "active" | "excluded" | "orphaned";
export type ReadinessRating = "green" | "yellow" | "red";

/** Figures of a moment (the start or the end of the period) read from storage. */
export interface StoredLevels {
  /**
   * The newest backup of every protected object at the moment, added up.
   * Excluded objects are not protected and left out (readiness.ts).
   */
  readonly logicalBytes: number;
  /**
   * Every backup completed before the moment and not yet pruned at it, added
   * up, whatever its object's status: it is what the stored bytes hold.
   */
  readonly retainedBytes: number;
  /** Pack bytes created before the moment that still exist. */
  readonly physicalBytes: number;
}

/** Figures that describe a moment. */
export interface Levels extends StoredLevels {
  /** Objects protected at the moment, counted by the readiness rule (readiness.ts). */
  readonly protectedObjects: number;
}

export interface ReadinessObject {
  readonly id: string;
  readonly name: string;
  readonly kind: ProtectedObjectKind;
  readonly status: ProtectedObjectStatus;
  readonly createdAt: Date;
}

/** A completed backup (snapshot) of an object, as far as readiness needs it. */
export interface ReadinessSnapshot {
  readonly id: string;
  readonly objectId: string;
  readonly sequence: number;
  readonly completedAt: Date;
  /** When retention pruned it; null while it is kept. */
  readonly prunedAt: Date | null;
}

/**
 * A verify report: a restore check of one snapshot, or a storage finding of
 * the object (features/verify/verification-state.ts has the rule).
 */
export interface ReadinessReport extends RatedReport {
  readonly objectId: string;
  /** Orders reports of the same instant, as the verify page does. */
  readonly createdAt: Date;
}

export interface TenantFacts {
  readonly tenant: TenantRefDto;
  /** Protected objects of any status. */
  readonly protectedObjectCount: number;
  readonly hasMicrosoft365: boolean;
  /** A snapshot completed before the end of the period. */
  readonly hasBackups: boolean;
  /** Finished backup runs per day over the previous and the current period. */
  readonly backupRuns: readonly {
    readonly day: string;
    readonly status: "completed" | "failed" | "cancelled";
    readonly count: number;
  }[];
  /** Finished restores per day over the previous and the current period. */
  readonly restoreRuns: readonly {
    readonly day: string;
    readonly status: "completed" | "failed";
    readonly count: number;
  }[];
  /** Graph throttling of finished jobs per day over the previous and the current period. */
  readonly throttling: readonly {
    readonly day: string;
    readonly waitMs: number;
    readonly waits: number;
  }[];
  /** Bytes of the snapshots completed per day in the current period. */
  readonly snapshotBytes: readonly { readonly day: string; readonly bytes: number }[];
  /** Bytes of the packs created per day in the current period. */
  readonly packBytes: readonly { readonly day: string; readonly bytes: number }[];
  /** Run time of every job that completed in the current period. */
  readonly durations: readonly { readonly queue: string; readonly seconds: number }[];
  readonly levels: { readonly start: StoredLevels; readonly end: StoredLevels };
  readonly failedItems: { readonly current: number; readonly previous: number };
  /** Item failures of the current period grouped by their stored reason. */
  readonly failureReasons: readonly ReasonCount[];
  /** Every protected object of the tenant, whatever its status. */
  readonly objects: readonly ReadinessObject[];
  /**
   * The backups that decide readiness at the midnights (UTC) the period is
   * rated at: each object's newest backup when the period starts, and its
   * newest backup of every day in the period.
   */
  readonly snapshots: readonly ReadinessSnapshot[];
  /**
   * Every report of the period, and before it the ones still in effect when
   * it starts: the newest check of each object's backup at that moment, the
   * newest storage finding and the newest check of each object.
   */
  readonly reports: readonly ReadinessReport[];
  /**
   * Servers and clients backed up by the agent (endpoint-facts.ts): they are
   * protected like the objects above, so they count in the readiness series,
   * the protected-objects figures and the backup outcomes, and nowhere else.
   */
  readonly endpoints: EndpointFacts;
  /**
   * The largest newest backups of protected objects at the end of the
   * period, biggest first.
   */
  readonly largestSnapshots: readonly {
    readonly objectId: string;
    readonly bytes: number;
    readonly completedAt: Date;
  }[];
}
