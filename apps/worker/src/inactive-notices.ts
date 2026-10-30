/**
 * `object.inactive` and `object.inactive_many`: Restow stopped backing up an object because the
 * source says it is gone, disabled, unlicensed or locked (core directory/inactive.ts). Until an
 * admin confirms it, the object reads amber and keeps the tenant from green; this tells them
 * once.
 *
 * Exactly once per object and transition into `orphaned`: `protected_objects.inactive_notified_at`
 * marks the notice as raised, in the same transaction as the notification, and the 0069 trigger
 * clears it on the next transition, so an object that comes back and leaves again is told again.
 * Objects orphaned before 0.4.7 were marked by the migration and raise nothing.
 *
 * Many at once (more than 10 objects, or more than 20% of the tenant's active objects within a
 * day, `isManyInactive`): one warning for the tenant instead of a notice per object, since a mass
 * change at the source (licences removed, a wrong sync scope) deserves a look before anyone
 * confirms it; at most one such warning per tenant and day.
 *
 * The same two events also carry the login question of an IMAP account whose login keeps being
 * refused (`details.question = "login"`, core directory/login-refused.ts): see
 * {@link raiseLoginQuestionNotices}. `details.kind` stays the object kind in both.
 *
 * Called after a directory sync committed (handlers/directory.ts) and after a backup marked an
 * object inactive (handlers/backup.ts `markInactive`). Rows another transaction holds are
 * skipped (`SKIP LOCKED`) and picked up by the next call.
 */
import { inactiveState, isManyInactive } from "@restow/core";
import { type NewNotification, notifications, protectedObjects, users } from "@restow/db";
import { and, count, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { TenantTx } from "./progress.js";
import { raiseEvents } from "./reporting.js";

const DAY_MS = 86_400_000;
/** Object ids a mass warning carries; the count says how many there were. */
const MAX_LISTED_OBJECTS = 50;

/** One object to tell about. */
export interface InactiveNoticeRow {
  readonly id: string;
  readonly sourceId: string;
  readonly kind: string;
  readonly externalId: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly statusReason: string | null;
  readonly inactiveSince: Date | null;
}

/** The notice of one object; the bell and mail texts come from the catalog's keys. */
export function inactiveNotification(
  tenantId: string,
  row: InactiveNoticeRow,
  now: Date,
): NewNotification {
  const name = row.email ?? row.displayName ?? row.externalId;
  const reason = row.statusReason ?? "removed";
  const why =
    reason === "account_disabled"
      ? "the account is disabled"
      : reason === "no_license"
        ? "the account has no licence"
        : reason === "locked"
          ? "Microsoft locked it"
          : reason === "login_refused"
            ? "its login was refused and an administrator confirmed it was shut down"
            : "it is no longer in the source";
  return {
    tenantId,
    level: "info",
    event: "object.inactive",
    message: `${name} is not backed up any more because ${why}. Please confirm that this is intended.`,
    details: {
      protectedObjectId: row.id,
      sourceId: row.sourceId,
      kind: row.kind,
      objectName: name,
      reason,
      inactiveSince: (row.inactiveSince ?? now).toISOString(),
    },
  };
}

/** The one warning for many objects of a tenant at once. */
export function inactiveManyNotification(
  tenantId: string,
  rows: readonly InactiveNoticeRow[],
  recent: number,
  now: Date,
): NewNotification {
  const total = Math.max(recent, rows.length);
  return {
    tenantId,
    level: "warning",
    event: "object.inactive_many",
    message: `${total} objects are not backed up any more since today (removed, disabled, unlicensed or locked at the source). Please check and confirm them.`,
    details: {
      tenantId,
      count: total,
      date: now.toISOString().slice(0, 10),
      sourceIds: [...new Set(rows.map((row) => row.sourceId))],
      protectedObjectIds: rows.slice(0, MAX_LISTED_OBJECTS).map((row) => row.id),
    },
  };
}

/**
 * Raise the due notices of one tenant inside `tx` (a tenant transaction) and mark them; returns
 * how many objects were told about. Never touches a confirmed object.
 */
export async function raiseInactiveNotices(
  tx: TenantTx,
  tenantId: string,
  now: Date = new Date(),
): Promise<number> {
  const rows = await tx
    .select({
      id: protectedObjects.id,
      sourceId: protectedObjects.sourceId,
      kind: protectedObjects.kind,
      externalId: protectedObjects.externalId,
      displayName: protectedObjects.displayName,
      email: users.email,
      status: protectedObjects.status,
      statusReason: protectedObjects.statusReason,
      statusConfirmedAt: protectedObjects.statusConfirmedAt,
      inactiveSince: protectedObjects.inactiveSince,
    })
    .from(protectedObjects)
    .leftJoin(users, eq(users.id, protectedObjects.userId))
    .where(
      and(
        eq(protectedObjects.tenantId, tenantId),
        eq(protectedObjects.status, "orphaned"),
        isNull(protectedObjects.statusConfirmedAt),
        isNull(protectedObjects.inactiveNotifiedAt),
      ),
    )
    .orderBy(protectedObjects.inactiveSince, protectedObjects.id)
    .for("update", { of: protectedObjects, skipLocked: true });
  const due = rows.filter((row) => inactiveState(row) === "to_confirm");
  if (due.length === 0) {
    return 0;
  }
  const since = new Date(now.getTime() - DAY_MS);
  const [recentRow] = await tx
    .select({ n: count() })
    .from(protectedObjects)
    .where(
      and(
        eq(protectedObjects.tenantId, tenantId),
        eq(protectedObjects.status, "orphaned"),
        isNull(protectedObjects.statusConfirmedAt),
        gte(protectedObjects.inactiveSince, since),
      ),
    );
  const [activeRow] = await tx
    .select({ n: count() })
    .from(protectedObjects)
    .where(and(eq(protectedObjects.tenantId, tenantId), eq(protectedObjects.status, "active")));
  const recent = Math.max(Number(recentRow?.n ?? 0), due.length);
  const active = Number(activeRow?.n ?? 0);

  if (isManyInactive(recent, active)) {
    // One warning per tenant and day, however many syncs add to it.
    const [already] = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.event, "object.inactive_many"),
          gte(notifications.createdAt, since),
          // A login-question warning of the same day is a different warning.
          sql`${notifications.details}->>'question' IS DISTINCT FROM 'login'`,
        ),
      )
      .limit(1);
    if (!already) {
      await raiseEvents(tx, [inactiveManyNotification(tenantId, due, recent, now)], now);
    }
  } else {
    await raiseEvents(
      tx,
      due.map((row) => inactiveNotification(tenantId, row, now)),
      now,
    );
  }
  await tx
    .update(protectedObjects)
    .set({ inactiveNotifiedAt: sql`now()` })
    .where(
      and(
        eq(protectedObjects.tenantId, tenantId),
        inArray(
          protectedObjects.id,
          due.map((row) => row.id),
        ),
      ),
    );
  return due.length;
}

// ---------------------------------------------------------------------------
// The login question of an IMAP account (docs/IMAP.md)
// ---------------------------------------------------------------------------

/** One IMAP account that just got its login question. */
export interface LoginQuestionNoticeRow extends InactiveNoticeRow {
  /** First counted refused login of the streak. */
  readonly failedSince: Date | null;
  /** Counted refused logins so far. */
  readonly runs: number;
  /** The login fails for (almost) the whole source: check the source's password first. */
  readonly sourceWide: boolean;
}

/** The notice of one account's login question; the bell and mail texts select on `question`. */
export function loginQuestionNotification(
  tenantId: string,
  row: LoginQuestionNoticeRow,
  now: Date,
): NewNotification {
  const name = row.email ?? row.displayName ?? row.externalId;
  return {
    tenantId,
    level: "info",
    event: "object.inactive",
    message: row.sourceWide
      ? `${name}: the login has been refused for several days, as for most accounts of this source. Check the password of the source first. If the account was shut down, please answer under Protection.`
      : `${name}: the login has been refused for several days. Was this account shut down? Please answer under Protection.`,
    details: {
      protectedObjectId: row.id,
      sourceId: row.sourceId,
      kind: row.kind,
      objectName: name,
      question: "login",
      reason: "login_refused",
      failedSince: (row.failedSince ?? now).toISOString(),
      runs: row.runs,
      ...(row.sourceWide ? { scope: "source" } : {}),
    },
  };
}

/** The one warning for many login questions of a tenant on one day. */
export function loginQuestionManyNotification(
  tenantId: string,
  rows: readonly LoginQuestionNoticeRow[],
  recent: number,
  now: Date,
): NewNotification {
  const total = Math.max(recent, rows.length);
  return {
    tenantId,
    level: "warning",
    event: "object.inactive_many",
    message: `${total} accounts have had their login refused for several days. Check the password of the source first, then answer under Protection whether the accounts were shut down.`,
    details: {
      tenantId,
      count: total,
      question: "login",
      date: now.toISOString().slice(0, 10),
      sourceIds: [...new Set(rows.map((row) => row.sourceId))],
      protectedObjectIds: rows.slice(0, MAX_LISTED_OBJECTS).map((row) => row.id),
    },
  };
}

/**
 * Tell the admins about accounts that just got their login question, inside the transaction
 * that raised it (`recordLoginFailure` in imap-login-state.ts): exactly once per streak, since
 * the question is raised once. Below the mass limit one `object.inactive` per account; above it
 * one `object.inactive_many` warning per tenant and day (counted apart from the 0069 kind by
 * `details.question`).
 */
export async function raiseLoginQuestionNotices(
  tx: TenantTx,
  tenantId: string,
  rows: readonly LoginQuestionNoticeRow[],
  now: Date = new Date(),
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const since = new Date(now.getTime() - DAY_MS);
  const [recentRow] = await tx
    .select({ n: count() })
    .from(protectedObjects)
    .where(
      and(
        eq(protectedObjects.tenantId, tenantId),
        eq(protectedObjects.kind, "imap"),
        eq(protectedObjects.status, "active"),
        isNull(protectedObjects.loginQuestionDismissedAt),
        gte(protectedObjects.loginQuestionAt, since),
      ),
    );
  const [activeRow] = await tx
    .select({ n: count() })
    .from(protectedObjects)
    .where(
      and(
        eq(protectedObjects.tenantId, tenantId),
        eq(protectedObjects.kind, "imap"),
        eq(protectedObjects.status, "active"),
      ),
    );
  const recent = Math.max(Number(recentRow?.n ?? 0), rows.length);
  if (!isManyInactive(recent, Number(activeRow?.n ?? 0))) {
    await raiseEvents(
      tx,
      rows.map((row) => loginQuestionNotification(tenantId, row, now)),
      now,
    );
    return;
  }
  const [already] = await tx
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.tenantId, tenantId),
        eq(notifications.event, "object.inactive_many"),
        gte(notifications.createdAt, since),
        sql`${notifications.details}->>'question' = 'login'`,
      ),
    )
    .limit(1);
  if (!already) {
    await raiseEvents(tx, [loginQuestionManyNotification(tenantId, rows, recent, now)], now);
  }
}
