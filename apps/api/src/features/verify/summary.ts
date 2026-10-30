import type { Readiness } from "./details.js";

/**
 * How the readiness overview rates objects and the tenant as a whole. A
 * backup without a verified restore counts as failed (docs/TESTING.md), so an
 * object that was never verified, or never backed up, is never shown as fine.
 */

/** Verify runs weekly; a rating older than this is overdue. */
export const VERIFY_OVERDUE_DAYS = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * - `green` / `yellow` / `red`  the rating of the newest backup
 * - `unverified`                 a backup exists, but no check of the newest one ran yet
 * - `no_backup`                  nothing to restore yet
 */
export type ObjectState = Readiness | "unverified" | "no_backup";

/**
 * The state from a rating and whether a backup exists. `readiness` must be
 * the rating of the newest backup, not simply the newest report: a report of
 * an older snapshot says nothing about a newer one. verification-state.ts
 * decides which report that is (`objectVerificationOf`).
 */
export function objectStateOf(readiness: Readiness | null, hasSnapshot: boolean): ObjectState {
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
   * backups score. It never lets the tenant read as fine (at least yellow) and is counted on its
   * own.
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
   * kept (a red check stays red), but it never lets the tenant read as fine (at least yellow)
   * until someone decides, and it is counted in `toConfirm`.
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
  overdue: number;
  /**
   * Machines and protected objects (mailboxes, OneDrives, sites, groups, IMAP accounts) in no
   * backup job: they are rated by their old backups, but nothing backs them up. Any of them
   * keeps the tenant from green. The guests and shares are counted in their own figures.
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
   * them up any more. Like `withoutJob`, any of them keeps the tenant from green.
   */
  guestsWithoutJob: number;
  /**
   * File shares in no backup job that keep a restore point: rated by it, but nothing backs them
   * up any more. Like `withoutJob`, any of them keeps the tenant from green.
   */
  sharesWithoutJob: number;
  /**
   * Objects no longer backed up that wait for an admin's "Yes, intended", with or without a
   * backup of their own. Any of them keeps the tenant from green (yellow, never red).
   */
  toConfirm: number;
  /** Worst state across all objects; null when the tenant protects nothing yet. */
  overall: Readiness | null;
  /** Newest rating date across all objects. */
  lastCheckedAt: string | null;
  /** Verify jobs queued or running right now. */
  running: number;
}

/**
 * Red if anything cannot be restored or is unproven; yellow if anything needs attention.
 * `unratedToConfirm` counts objects no longer backed up that wait for a confirmation but have no
 * backup to rate (so they are no {@link RatedObject}): they make the tenant yellow as well.
 */
export function overallReadiness(
  objects: readonly RatedObject[],
  unratedToConfirm = 0,
): Readiness | null {
  if (objects.length === 0) {
    return unratedToConfirm > 0 ? "yellow" : null;
  }
  const unproven = new Set<ObjectState>(["red", "unverified", "no_backup"]);
  if (objects.some((object) => unproven.has(object.state))) {
    return "red";
  }
  if (
    unratedToConfirm > 0 ||
    objects.some(
      (object) =>
        object.state === "yellow" || object.overdue || object.withoutJob || object.toConfirm,
    )
  ) {
    return "yellow";
  }
  return "green";
}

export function summarize(
  objects: readonly RatedObject[],
  running: number,
  /** Unconfirmed objects no longer backed up that have no backup (see {@link overallReadiness}). */
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
    overall: overallReadiness(objects, unratedToConfirm),
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
