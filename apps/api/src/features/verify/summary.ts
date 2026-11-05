import { aggregateReadiness, countReadinessStates } from "@restow/core";
import type { Readiness } from "./details.js";

/**
 * How the readiness overview rates objects and the tenant as a whole. A
 * backup without a verified restore is not proven (docs/TESTING.md), so an
 * object that was never verified, or never backed up, is never shown as fine.
 * The tenant reads as the worst category that has objects (@restow/core
 * `aggregateReadiness`): red when something cannot be restored or has no
 * backup yet, yellow (not proven) when something needs attention or is
 * unverified, green otherwise.
 */

/** Verify runs weekly; a rating older than this is overdue. */
export const VERIFY_OVERDUE_DAYS = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * - `green` / `yellow` / `red`  the rating of the newest backup
 * - `unverified`                 a backup exists, but no check of the newest one ran yet
 * - `no_backup`                  nothing to restore yet
 * - `empty`                      the newest check found nothing to restore (only default folders
 *                                or system pages, 0 bytes) and an admin confirmed that
 *                                (empty.ts): neutral, never counted as needing attention
 */
export type ObjectState = CheckedState | "empty";

/** The states a backup's checks alone decide (an `empty` confirmation comes on top). */
export type CheckedState = Readiness | "unverified" | "no_backup";

/**
 * The state from a rating and whether a backup exists. `readiness` must be
 * the rating of the newest backup, not simply the newest report: a report of
 * an older snapshot says nothing about a newer one. verification-state.ts
 * decides which report that is (`objectVerificationOf`).
 */
export function objectStateOf(readiness: Readiness | null, hasSnapshot: boolean): CheckedState {
  if (readiness) {
    return readiness;
  }
  return hasSnapshot ? "unverified" : "no_backup";
}

export function isOverdue(checkedAt: Date | null, now: Date): boolean {
  return checkedAt !== null && now.getTime() - checkedAt.getTime() > VERIFY_OVERDUE_DAYS * DAY_MS;
}

/** A "no_backup" object gets this long before it counts as a problem. */
export const FIRST_BACKUP_GRACE_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Whether an object that has no backup yet has waited past its grace period.
 * A newly protected object has simply not had its first scheduled backup run
 * yet, which is expected, not a fault; it only becomes one once
 * `FIRST_BACKUP_GRACE_HOURS` after protection started pass without a backup.
 * The single place this rule lives: the readiness overview's `overdue` flag
 * for `no_backup` objects, the "Needs attention" count and the state badge
 * all read it from there instead of re-deriving it.
 */
export function isFirstBackupOverdue(protectedSince: Date, now: Date): boolean {
  return now.getTime() - protectedSince.getTime() > FIRST_BACKUP_GRACE_HOURS * HOUR_MS;
}

export interface RatedObject {
  readonly state: ObjectState;
  readonly overdue: boolean;
  readonly checkedAt: Date | null;
  /**
   * A machine or a mail object in no backup job: nothing backs it up any more, whatever its old
   * backups score. It is counted on its own and listed as a callout; it does not change
   * `overall`.
   */
  readonly withoutJob?: boolean;
  /**
   * A mailbox, OneDrive, site, group or IMAP account (a protected object of a source, backed up
   * by the mail jobs): one in no enabled mail job is counted in `withoutJob` and in
   * `objectsWithoutJob`, so a view can tell it from the machines.
   */
  readonly mail?: boolean;
  /**
   * A VM or container of Proxmox VE (features/pve/protection.ts): rated like any object, but one
   * in no backup job is counted in `guestsWithoutJob`, not with the machines.
   */
  readonly guest?: boolean;
  /**
   * A file share (features/file-shares/protection.ts): rated like any object, but one in no
   * backup job is counted in `sharesWithoutJob`, not with the machines.
   */
  readonly share?: boolean;
  /**
   * An object Restow stopped backing up (removed, disabled, unlicensed, locked at the source)
   * that no admin confirmed yet (@restow/core `inactiveState` `to_confirm`). Its own rating is
   * kept (a red check stays red, and counts as such); it is counted in `toConfirm` and listed as
   * a callout until someone decides, but it does not change `overall` by itself.
   */
  readonly toConfirm?: boolean;
}

export interface ReadinessSummaryDto {
  total: number;
  green: number;
  yellow: number;
  red: number;
  unverified: number;
  noBackup: number;
  /**
   * Objects an admin confirmed as empty (their newest check found nothing to restore): neutral,
   * neither green nor yellow, and they never keep the tenant from green (left out of `overall`).
   */
  empty: number;
  overdue: number;
  /**
   * Machines and protected objects (mailboxes, OneDrives, sites, groups, IMAP accounts) in no
   * backup job: they are rated by their old backups, but nothing backs them up. They are listed
   * as a callout; they do not change `overall`. The guests and shares are counted in their own
   * figures.
   */
  withoutJob: number;
  /**
   * The part of `withoutJob` that are protected objects of a source: Microsoft 365 and IMAP
   * objects that no enabled mail job covers and that keep a restore point (an object without any
   * backup stays "no backup").
   */
  objectsWithoutJob: number;
  /**
   * VMs and containers in no backup job that keep a restore point: rated by it, but nothing backs
   * them up any more. Like `withoutJob`, listed as a callout; it does not change `overall`.
   */
  guestsWithoutJob: number;
  /**
   * File shares in no backup job that keep a restore point: rated by it, but nothing backs them
   * up any more. Like `withoutJob`, listed as a callout; it does not change `overall`.
   */
  sharesWithoutJob: number;
  /**
   * Objects no longer backed up that wait for an admin's "Yes, intended", with or without a
   * backup of their own. Listed as a callout; they do not change `overall`.
   */
  toConfirm: number;
  /**
   * Worst populated readiness category (@restow/core `aggregateReadiness`); null when the tenant
   * protects nothing yet.
   */
  overall: Readiness | null;
  /** Newest rating date across all objects. */
  lastCheckedAt: string | null;
  /** Verify jobs queued or running right now. */
  running: number;
}

/**
 * The worst readiness category that has objects (UI rework, decision 1): red when one cannot be
 * restored or has no backup yet, yellow (not proven) when one needs attention or is unverified,
 * green otherwise; null without objects. An object confirmed as empty (`empty`) counts for
 * neither, and overdue checks, objects in no job and objects waiting for a confirmation do not
 * change it (decision 2): views list them as callouts.
 */
export function overallReadiness(objects: readonly RatedObject[]): Readiness | null {
  return aggregateReadiness(
    countReadinessStates(objects.map((object) => object.state)),
    objects.length,
  );
}

export function summarize(
  objects: readonly RatedObject[],
  running: number,
  /**
   * Unconfirmed objects no longer backed up that have no backup to rate (so they are no
   * {@link RatedObject}): counted in `toConfirm` only.
   */
  unratedToConfirm = 0,
): ReadinessSummaryDto {
  const countOf = (state: ObjectState) => objects.filter((object) => object.state === state).length;
  const newest = objects.reduce<Date | null>(
    (latest, object) =>
      object.checkedAt && (!latest || object.checkedAt > latest) ? object.checkedAt : latest,
    null,
  );
  return {
    total: objects.length,
    green: countOf("green"),
    yellow: countOf("yellow"),
    red: countOf("red"),
    unverified: countOf("unverified"),
    noBackup: countOf("no_backup"),
    empty: countOf("empty"),
    overdue: objects.filter((object) => object.overdue).length,
    withoutJob: objects.filter(
      (object) => object.withoutJob === true && object.guest !== true && object.share !== true,
    ).length,
    objectsWithoutJob: objects.filter(
      (object) => object.withoutJob === true && object.mail === true,
    ).length,
    guestsWithoutJob: objects.filter(
      (object) => object.withoutJob === true && object.guest === true,
    ).length,
    sharesWithoutJob: objects.filter(
      (object) => object.withoutJob === true && object.share === true,
    ).length,
    toConfirm: objects.filter((object) => object.toConfirm === true).length + unratedToConfirm,
    overall: overallReadiness(objects),
    lastCheckedAt: newest?.toISOString() ?? null,
    running,
  };
}

/** Why a "check now" request skipped an object. */
export type SkipReason = "no_backup" | "excluded" | "already_queued";

/**
 * Whether an object can be checked now. Excluded objects are not protected
 * any more; orphaned ones (gone from the source) keep their backups, and
 * those are worth proving too.
 */
export function verifyBlockedReason(input: {
  readonly status: "active" | "excluded" | "orphaned";
  readonly hasSnapshot: boolean;
}): Exclude<SkipReason, "already_queued"> | null {
  if (input.status === "excluded") {
    return "excluded";
  }
  return input.hasSnapshot ? null : "no_backup";
}
