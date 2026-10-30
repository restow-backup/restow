/**
 * The state of an IMAP account whose login keeps being refused (core directory/login-refused.ts,
 * docs/IMAP.md), in the columns migration 0070 added to `protected_objects`.
 *
 *   - {@link recordLoginFailure}: one refused password login (backup run, archive capture pass or
 *     probe). Counts under the row lock; after 3 counted failures over 24 h it opens the login
 *     question and raises the notice in the same transaction, exactly once per streak.
 *   - {@link recordLoginSuccess}: a login worked; the streak and an open or dismissed question
 *     are over.
 *   - {@link reactivateAfterLogin}: the weekly probe of a shut-down (`login_refused`) account
 *     worked; the account is active again (the 0070 trigger clears reason, dates, confirmation
 *     and the login columns).
 *   - {@link postponeLoginProbe}: the probe could not tell; try again later.
 *
 * Nothing here ever sets `login_refused`: only the admin's "Yes" does (apps/api directory
 * service), and the 0070 check keeps every other writer from it.
 *
 * Only password logins count. An OAuth2 login the server rejects is an `imap.auth_failed` too,
 * so the source's login is part of the row lookup: `shared` auth with `authKind: "oauth2"` is
 * skipped, `per_mailbox` and `master_user` are always password logins (`imapAccountFor`).
 */
import {
  isSourceWideLoginFailure,
  LOGIN_FAILURE_MIN_SPACING_HOURS,
  LOGIN_PROBE_INTERVAL_HOURS,
  nextLoginFailureState,
  shouldAskLoginQuestion,
} from "@restow/core";
import { protectedObjects, sources, users } from "@restow/db";
import { and, count, eq, gt, inArray, or, sql } from "drizzle-orm";
import { appendAuditEntry } from "./audit.js";
import { type LoginQuestionNoticeRow, raiseLoginQuestionNotices } from "./inactive-notices.js";
import type { TenantTx } from "./progress.js";

const HOUR_MS = 3_600_000;

/** The source logs in with a password (see the file comment). */
const PASSWORD_LOGIN = sql`(coalesce(${sources.config}->>'imapAuthMode', 'shared') <> 'shared' OR coalesce(${sources.config}->>'authKind', 'password') <> 'oauth2')`;

export type LoginFailureOutcome =
  /** Not an IMAP account that counts: other kind, OAuth2 login, excluded, or gone. */
  | "ignored"
  /** An active account: counted as a new run of the streak. */
  | "counted"
  /** An active account: too soon after the last counted failure, folded into it. */
  | "folded"
  /** The weekly probe of a shut-down account was refused: next probe in a week. */
  | "probe_refused";

export interface LoginFailureResult {
  readonly outcome: LoginFailureOutcome;
  /** The login question was opened by this call (and its notice raised). */
  readonly questionRaised: boolean;
}

const IGNORED: LoginFailureResult = { outcome: "ignored", questionRaised: false };

/**
 * One refused password login of an IMAP account at `now`. Call it inside the tenant transaction;
 * everything it writes (counters, the question, its notice, the audit entry) commits together.
 * `spacingHours` is how old the last counted failure must be for this one to count (a backup
 * run: 6 h; an archive capture pass passes its own, longer spacing).
 */
export async function recordLoginFailure(
  tx: TenantTx,
  tenantId: string,
  objectId: string,
  now: Date = new Date(),
  spacingHours: number = LOGIN_FAILURE_MIN_SPACING_HOURS,
): Promise<LoginFailureResult> {
  const [row] = await tx
    .select({
      id: protectedObjects.id,
      sourceId: protectedObjects.sourceId,
      kind: protectedObjects.kind,
      externalId: protectedObjects.externalId,
      displayName: protectedObjects.displayName,
      email: users.email,
      status: protectedObjects.status,
      statusReason: protectedObjects.statusReason,
      inactiveSince: protectedObjects.inactiveSince,
      runs: protectedObjects.loginFailedRuns,
      since: protectedObjects.loginFailedSince,
      lastAt: protectedObjects.loginFailedAt,
      questionAt: protectedObjects.loginQuestionAt,
      dismissedAt: protectedObjects.loginQuestionDismissedAt,
    })
    .from(protectedObjects)
    .innerJoin(sources, eq(sources.id, protectedObjects.sourceId))
    .leftJoin(users, eq(users.id, protectedObjects.userId))
    .where(
      and(
        eq(protectedObjects.tenantId, tenantId),
        eq(protectedObjects.id, objectId),
        eq(protectedObjects.kind, "imap"),
        eq(sources.kind, "imap"),
        inArray(protectedObjects.status, ["active", "orphaned"]),
        PASSWORD_LOGIN,
      ),
    )
    // The counters change under this lock: a backup, an archive pass and a retry at the same
    // time are counted one after the other.
    .for("update", { of: protectedObjects });
  if (!row) {
    return IGNORED;
  }

  if (row.status === "orphaned") {
    if (row.statusReason !== "login_refused") {
      return IGNORED;
    }
    // A refused probe of a shut-down account: nothing to count, the next probe is a week out.
    await tx
      .update(protectedObjects)
      .set({
        loginFailedAt: now,
        loginProbeDueAt: new Date(now.getTime() + LOGIN_PROBE_INTERVAL_HOURS * HOUR_MS),
      })
      .where(eq(protectedObjects.id, row.id));
    return { outcome: "probe_refused", questionRaised: false };
  }

  const next = nextLoginFailureState(
    { runs: row.runs, since: row.since, lastAt: row.lastAt },
    now,
    spacingHours,
  );
  // An open question stays as it is. A dismissed one comes back only after 90 days; a streak
  // without any question asks when it is long enough.
  const questionOpen = row.questionAt !== null && row.dismissedAt === null;
  const ask = !questionOpen && shouldAskLoginQuestion(next, row.dismissedAt, now);

  await tx
    .update(protectedObjects)
    .set({
      loginFailedRuns: next.runs,
      loginFailedSince: next.since,
      loginFailedAt: next.lastAt,
      ...(ask ? { loginQuestionAt: now, loginQuestionDismissedAt: null } : {}),
    })
    .where(eq(protectedObjects.id, row.id));

  if (ask) {
    const sourceWide = await sourceWideFailure(tx, tenantId, row.sourceId);
    await appendAuditEntry(tx, {
      tenantId,
      actor: "system",
      action: "directory.login.question_raised",
      target: row.id,
      targetType: "imap",
      details: {
        protectedObjectId: row.id,
        sourceId: row.sourceId,
        failedSince: (next.since ?? now).toISOString(),
        runs: next.runs,
        sourceWide,
      },
    });
    const noticeRow: LoginQuestionNoticeRow = {
      id: row.id,
      sourceId: row.sourceId,
      kind: row.kind,
      externalId: row.externalId,
      displayName: row.displayName,
      email: row.email,
      statusReason: null,
      inactiveSince: row.inactiveSince,
      failedSince: next.since,
      runs: next.runs,
      sourceWide,
    };
    await raiseLoginQuestionNotices(tx, tenantId, [noticeRow], now);
  }
  return { outcome: next.counted ? "counted" : "folded", questionRaised: ask };
}

/** Whether (almost) every active account of the source has a failing login streak. */
async function sourceWideFailure(
  tx: TenantTx,
  tenantId: string,
  sourceId: string,
): Promise<boolean> {
  const [totals] = await tx
    .select({
      active: count(),
      failing: count(sql`CASE WHEN ${protectedObjects.loginFailedRuns} > 0 THEN 1 END`),
    })
    .from(protectedObjects)
    .where(
      and(
        eq(protectedObjects.tenantId, tenantId),
        eq(protectedObjects.sourceId, sourceId),
        eq(protectedObjects.status, "active"),
      ),
    );
  return isSourceWideLoginFailure(Number(totals?.failing ?? 0), Number(totals?.active ?? 0));
}

/**
 * A password login of an active account worked: the streak, an open question and a dismissed one
 * are over. A primary-key lookup that writes nothing in the normal case. Returns whether a row
 * changed.
 */
export async function recordLoginSuccess(
  tx: TenantTx,
  tenantId: string,
  objectId: string,
): Promise<boolean> {
  const rows = await tx
    .update(protectedObjects)
    .set({
      loginFailedRuns: 0,
      loginFailedSince: null,
      loginFailedAt: null,
      loginQuestionAt: null,
      loginQuestionDismissedAt: null,
    })
    .where(
      and(
        eq(protectedObjects.tenantId, tenantId),
        eq(protectedObjects.id, objectId),
        eq(protectedObjects.status, "active"),
        or(
          gt(protectedObjects.loginFailedRuns, 0),
          sql`${protectedObjects.loginQuestionAt} IS NOT NULL`,
        ),
      ),
    )
    .returning({ id: protectedObjects.id });
  return rows.length > 0;
}

/**
 * The login of a shut-down account (`orphaned` + `login_refused`) works again: it is `active`
 * from now on. `active_since` starts now (the overdue clock must not count the months it was
 * shut down, core overdue rules); the 0070 trigger clears the reason, the dates, the
 * confirmation and the login columns. Writes the audit entry `directory.login.restored`.
 * Returns whether a row changed.
 */
export async function reactivateAfterLogin(
  tx: TenantTx,
  tenantId: string,
  objectId: string,
  now: Date = new Date(),
  via: "probe" | "test_login" = "probe",
): Promise<boolean> {
  const rows = await tx
    .update(protectedObjects)
    .set({ status: "active", activeSince: now, updatedAt: now })
    .where(
      and(
        eq(protectedObjects.tenantId, tenantId),
        eq(protectedObjects.id, objectId),
        eq(protectedObjects.status, "orphaned"),
        eq(protectedObjects.statusReason, "login_refused"),
      ),
    )
    .returning({ id: protectedObjects.id, sourceId: protectedObjects.sourceId });
  const [restored] = rows;
  if (!restored) {
    return false;
  }
  await appendAuditEntry(tx, {
    tenantId,
    actor: "system",
    action: "directory.login.restored",
    target: restored.id,
    targetType: "imap",
    details: { protectedObjectId: restored.id, sourceId: restored.sourceId, via },
  });
  return true;
}

/**
 * The probe of a shut-down account could not tell (network, server limit, configuration): the
 * next one is due in `days` days, so an outage does not make the planner queue it every pass.
 */
export async function postponeLoginProbe(
  tx: TenantTx,
  tenantId: string,
  objectId: string,
  days: number,
  now: Date = new Date(),
): Promise<void> {
  await tx
    .update(protectedObjects)
    .set({ loginProbeDueAt: new Date(now.getTime() + days * 24 * HOUR_MS) })
    .where(
      and(
        eq(protectedObjects.tenantId, tenantId),
        eq(protectedObjects.id, objectId),
        eq(protectedObjects.status, "orphaned"),
        eq(protectedObjects.statusReason, "login_refused"),
      ),
    );
}
