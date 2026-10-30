/**
 * The login state of IMAP accounts against Postgres (imap-login-state.ts, migration 0070): the
 * counter with its 6 h spacing under concurrency, the question after 3 counted failures over
 * 24 h with its notice in the same transaction and exactly once per streak, the mass warning,
 * success and dismissal, the 90-day re-ask, the password-only rule (shared OAuth2 sources are
 * skipped), and the probe of a shut-down account (refused, postponed, reactivated).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database named
 * `restow_worker_imap_login_state_test` is recreated there and dropped after).
 */
import { randomUUID } from "node:crypto";
import { LOGIN_ARCHIVE_FAILURE_MIN_SPACING_HOURS } from "@restow/core";
import {
  auditLog,
  createDb,
  type Database,
  notifications,
  protectedObjects,
  providers,
  type Source,
  sources,
  tenants,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTenantTx } from "./handlers/framework.js";
import {
  postponeLoginProbe,
  reactivateAfterLogin,
  recordLoginFailure,
  recordLoginSuccess,
} from "./imap-login-state.js";
import { dropTestDatabase } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_imap_login_state_test";
const HOUR = 3_600_000;
const T0 = new Date("2026-10-01T02:00:00Z");
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

describe.skipIf(!adminUrl)("IMAP login state (Postgres)", () => {
  let db: Database;
  let tenantId: string;
  let shared: string;
  let oauth: string;
  let perMailbox: string;
  let master: string;
  let providerId: string;
  let sourceCounter = 0;

  /** A tenant of its own per test: notices and mass limits do not leak between tests. */
  beforeEach(async () => {
    const [tenant] = await db
      .insert(tenants)
      .values({ providerId, name: "Contoso", slug: `contoso-${randomUUID().slice(0, 8)}` })
      .returning();
    tenantId = tenant?.id as string;
    shared = await source({});
    oauth = await source({ authKind: "oauth2" });
    perMailbox = await source({ imapAuthMode: "per_mailbox" });
    master = await source({ imapAuthMode: "master_user" });
  });

  beforeAll(async () => {
    const admin = createDb(adminUrl as string);
    try {
      await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    } finally {
      await admin.$client.end();
    }
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    await runMigrations(url.toString());
    db = createDb(url.toString());
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    providerId = provider?.id as string;
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    if (adminUrl) {
      await dropTestDatabase(adminUrl, TEST_DB);
    }
  });

  async function source(config: Source["config"]): Promise<string> {
    const [row] = await db
      .insert(sources)
      .values({
        tenantId,
        kind: "imap",
        name: `Mail ${++sourceCounter}`,
        host: "imap.example.net",
        status: "active",
        config,
      })
      .returning();
    return row?.id as string;
  }

  async function account(sourceId = shared, status: "active" | "excluded" = "active") {
    const [row] = await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId,
        kind: "imap",
        status,
        externalId: `${randomUUID().slice(0, 8)}@example.net`,
      })
      .returning();
    return row?.id as string;
  }

  const fail = (id: string, now: Date) =>
    withTenantTx(db, tenantId, (tx) => recordLoginFailure(tx, tenantId, id, now));
  const succeed = (id: string) =>
    withTenantTx(db, tenantId, (tx) => recordLoginSuccess(tx, tenantId, id));

  async function row(id: string) {
    const [found] = await db.select().from(protectedObjects).where(eq(protectedObjects.id, id));
    return found;
  }

  async function notices(id: string) {
    return db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          sql`${notifications.details}->>'protectedObjectId' = ${id}`,
        ),
      )
      .orderBy(asc(notifications.createdAt));
  }

  /** Three counted failures over 48 hours: the third raises the question. */
  async function askQuestion(id: string, base = 0) {
    await fail(id, at(base));
    await fail(id, at(base + 24));
    return fail(id, at(base + 48));
  }

  it("counts a refused login, folds failures closer than 6 h and counts again after", async () => {
    const id = await account();
    expect(await fail(id, at(0))).toEqual({ outcome: "counted", questionRaised: false });
    expect(await fail(id, at(1))).toEqual({ outcome: "folded", questionRaised: false });
    expect(await fail(id, at(5.9))).toEqual({ outcome: "folded", questionRaised: false });
    let current = await row(id);
    expect(current).toMatchObject({ loginFailedRuns: 1, loginQuestionAt: null });
    expect(current?.loginFailedSince?.toISOString()).toBe(at(0).toISOString());
    expect(current?.loginFailedAt?.toISOString()).toBe(at(0).toISOString());
    expect(await fail(id, at(6))).toEqual({ outcome: "counted", questionRaised: false });
    current = await row(id);
    expect(current?.loginFailedRuns).toBe(2);
    expect(current?.loginFailedSince?.toISOString()).toBe(at(0).toISOString());
  });

  it("counts failed archive passes with the wider spacing", async () => {
    const id = await account();
    const archivePass = (now: Date) =>
      withTenantTx(db, tenantId, (tx) =>
        recordLoginFailure(tx, tenantId, id, now, LOGIN_ARCHIVE_FAILURE_MIN_SPACING_HOURS),
      );
    expect((await archivePass(at(0))).outcome).toBe("counted");
    // A pass every 4 hours: folded until 20 h are over.
    for (const hours of [4, 8, 12, 16]) {
      expect((await archivePass(at(hours))).outcome).toBe("folded");
    }
    expect((await archivePass(at(20))).outcome).toBe("counted");
    expect((await row(id))?.loginFailedRuns).toBe(2);
    // The backup's own 6 h spacing counts from the last counted failure, whoever it was.
    expect((await fail(id, at(23))).outcome).toBe("folded");
    expect((await fail(id, at(26))).outcome).toBe("counted");
  });

  it("folds simultaneous failures of a backup, an archive pass and a retry into one count", async () => {
    const id = await account();
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map((minutes) => fail(id, new Date(T0.getTime() + minutes * 60_000))),
    );
    expect(results.filter((result) => result.outcome === "counted")).toHaveLength(1);
    expect((await row(id))?.loginFailedRuns).toBe(1);
  });

  it("asks after 3 counted failures over 24 h, with the notice, exactly once per streak", async () => {
    const id = await account();
    await fail(id, at(0));
    await fail(id, at(7));
    // Three counted failures, but not yet 24 hours since the first.
    expect(await fail(id, at(14))).toMatchObject({ outcome: "counted", questionRaised: false });
    expect((await row(id))?.loginQuestionAt).toBeNull();
    expect(await notices(id)).toHaveLength(0);

    expect(await fail(id, at(25))).toEqual({ outcome: "counted", questionRaised: true });
    const asked = await row(id);
    expect(asked).toMatchObject({ status: "active", loginFailedRuns: 4 });
    expect(asked?.loginQuestionAt?.toISOString()).toBe(at(25).toISOString());
    const [notice] = await notices(id);
    expect(notice).toMatchObject({ event: "object.inactive", level: "info" });
    expect(notice?.details).toMatchObject({
      protectedObjectId: id,
      kind: "imap",
      question: "login",
      reason: "login_refused",
      runs: 4,
    });
    expect(notice?.details).not.toHaveProperty("scope");
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.target, id)));
    expect(audit.map((entry) => entry.action)).toEqual(["directory.login.question_raised"]);

    // More failures of the same streak raise nothing again.
    expect(await fail(id, at(50))).toEqual({ outcome: "counted", questionRaised: false });
    expect(await notices(id)).toHaveLength(1);
  });

  it("rolls the question back with the transaction: no notice without it", async () => {
    const id = await account();
    await fail(id, at(0));
    await fail(id, at(24));
    await expect(
      withTenantTx(db, tenantId, async (tx) => {
        await recordLoginFailure(tx, tenantId, id, at(48));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await row(id)).toMatchObject({ loginFailedRuns: 2, loginQuestionAt: null });
    expect(await notices(id)).toHaveLength(0);
    // The next failure still counts as the third and raises the question and the notice.
    expect(await fail(id, at(49))).toMatchObject({ questionRaised: true });
    expect(await notices(id)).toHaveLength(1);
  });

  it("counts password logins only: shared OAuth2 sources are skipped, per_mailbox and master_user count", async () => {
    const skipped = await account(oauth);
    expect(await fail(skipped, at(0))).toEqual({ outcome: "ignored", questionRaised: false });
    expect((await row(skipped))?.loginFailedRuns).toBe(0);
    for (const sourceId of [perMailbox, master, shared]) {
      const id = await account(sourceId);
      expect((await fail(id, at(0))).outcome).toBe("counted");
      expect((await row(id))?.loginFailedRuns).toBe(1);
    }
  });

  it("ignores excluded accounts, other kinds and unknown ids", async () => {
    const excluded = await account(shared, "excluded");
    expect((await fail(excluded, at(0))).outcome).toBe("ignored");
    expect((await fail(randomUUID(), at(0))).outcome).toBe("ignored");
    const [mailbox] = await db
      .insert(protectedObjects)
      .values({ tenantId, sourceId: shared, kind: "mailbox", externalId: "m@example.net" })
      .returning();
    expect((await fail(mailbox?.id as string, at(0))).outcome).toBe("ignored");
  });

  it("ends the streak and the question when a login works", async () => {
    const id = await account();
    await fail(id, at(0));
    expect(await succeed(id)).toBe(true);
    expect(await row(id)).toMatchObject({ loginFailedRuns: 0, loginFailedSince: null });
    // Nothing to reset in the normal case: no write.
    expect(await succeed(id)).toBe(false);

    const asked = await account();
    await askQuestion(asked);
    expect((await row(asked))?.loginQuestionAt).not.toBeNull();
    expect(await succeed(asked)).toBe(true);
    expect(await row(asked)).toMatchObject({
      loginFailedRuns: 0,
      loginFailedAt: null,
      loginQuestionAt: null,
      loginQuestionDismissedAt: null,
    });
    // The next streak asks again from zero.
    expect(await askQuestion(asked, 100)).toMatchObject({ questionRaised: true });
  });

  it("does not ask again after a No for 90 days, and asks again after", async () => {
    const id = await account();
    await askQuestion(id);
    await db
      .update(protectedObjects)
      .set({ loginQuestionDismissedAt: at(60) })
      .where(eq(protectedObjects.id, id));
    // Day 80: still within 90 days of the answer.
    expect(await fail(id, at(24 * 80))).toMatchObject({ questionRaised: false });
    expect(await notices(id)).toHaveLength(1);
    // Day 152 is more than 90 days after the answer (day 2.5) and the account still fails.
    expect(await fail(id, at(24 * 152))).toMatchObject({ questionRaised: true });
    const again = await row(id);
    expect(again?.loginQuestionDismissedAt).toBeNull();
    expect(again?.loginQuestionAt?.toISOString()).toBe(at(24 * 152).toISOString());
    expect(await notices(id)).toHaveLength(2);
  });

  it("names a source-wide failure in the notice", async () => {
    const wide = await source({});
    const ids: string[] = [];
    for (let n = 0; n < 10; n++) {
      ids.push(await account(wide));
    }
    // Five of the ten accounts have a streak; the first one to reach the question asks alone.
    for (const id of ids.slice(0, 5)) {
      await fail(id, at(0));
      await fail(id, at(24));
    }
    expect(await fail(ids[0] as string, at(48))).toMatchObject({ questionRaised: true });
    const [notice] = await notices(ids[0] as string);
    expect(notice?.details).toMatchObject({ question: "login", scope: "source" });
    expect(notice?.message).toMatch(/Check the password of the source first/);
  });

  it("raises one mass warning instead of a notice per account above the limit", async () => {
    const mass = await source({});
    const ids: string[] = [];
    for (let n = 0; n < 13; n++) {
      ids.push(await account(mass));
    }
    // Real time: "one warning per day" reads the notifications' own creation dates.
    const start = Date.now() - 100 * HOUR;
    for (const id of ids) {
      for (const hours of [0, 24, 48]) {
        await fail(id, new Date(start + hours * HOUR));
      }
    }
    const events = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          sql`${notifications.details}->>'sourceId' = ${mass} OR ${notifications.details}->'sourceIds' ? ${mass}`,
        ),
      );
    const single = events.filter((event) => event.event === "object.inactive");
    const many = events.filter((event) => event.event === "object.inactive_many");
    // isManyInactive: the fourth of 13 accounts asked within a day is more than 20%.
    expect(single).toHaveLength(3);
    expect(many).toHaveLength(1);
    expect(many[0]).toMatchObject({ level: "warning" });
    expect(many[0]?.details).toMatchObject({ question: "login" });
    // Every account still has its question, the warning replaced only the notices.
    const asked = await db
      .select({ id: protectedObjects.id })
      .from(protectedObjects)
      .where(
        and(
          eq(protectedObjects.sourceId, mass),
          sql`${protectedObjects.loginQuestionAt} IS NOT NULL`,
        ),
      );
    expect(asked).toHaveLength(13);
  });

  describe("a shut-down account", () => {
    async function shutDown(id: string) {
      await db
        .update(protectedObjects)
        .set({
          status: "orphaned",
          statusReason: "login_refused",
          statusConfirmedAt: new Date(),
          statusConfirmedBy: "admin@example.net",
        })
        .where(eq(protectedObjects.id, id));
    }

    it("sets the next probe a week out when the probe is refused again", async () => {
      const id = await account();
      await shutDown(id);
      const result = await fail(id, at(0));
      expect(result).toEqual({ outcome: "probe_refused", questionRaised: false });
      const current = await row(id);
      expect(current?.loginProbeDueAt?.toISOString()).toBe(at(168).toISOString());
      expect(current?.loginFailedAt?.toISOString()).toBe(at(0).toISOString());
      expect(current).toMatchObject({ status: "orphaned", statusReason: "login_refused" });
    });

    it("postpones the next probe by days", async () => {
      const id = await account();
      await shutDown(id);
      await withTenantTx(db, tenantId, (tx) => postponeLoginProbe(tx, tenantId, id, 1, at(0)));
      expect((await row(id))?.loginProbeDueAt?.toISOString()).toBe(at(24).toISOString());
    });

    it("becomes active again with active_since, clean columns and an audit entry", async () => {
      const id = await account();
      await askQuestion(id);
      await shutDown(id);
      const now = at(500);
      expect(
        await withTenantTx(db, tenantId, (tx) => reactivateAfterLogin(tx, tenantId, id, now)),
      ).toBe(true);
      const back = await row(id);
      expect(back).toMatchObject({
        status: "active",
        statusReason: null,
        statusConfirmedAt: null,
        statusConfirmedBy: null,
        inactiveSince: null,
        loginFailedRuns: 0,
        loginFailedSince: null,
        loginFailedAt: null,
        loginQuestionAt: null,
        loginProbeDueAt: null,
      });
      expect(back?.activeSince?.toISOString()).toBe(now.toISOString());
      const audit = await db
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, "directory.login.restored")),
        );
      expect(audit.some((entry) => entry.target === id && entry.actor === "system")).toBe(true);
      // Nothing left to reactivate.
      expect(
        await withTenantTx(db, tenantId, (tx) => reactivateAfterLogin(tx, tenantId, id, now)),
      ).toBe(false);
    });

    it("never touches an account that is not shut down", async () => {
      const id = await account();
      expect(await withTenantTx(db, tenantId, (tx) => reactivateAfterLogin(tx, tenantId, id))).toBe(
        false,
      );
      await withTenantTx(db, tenantId, (tx) => postponeLoginProbe(tx, tenantId, id, 1));
      expect((await row(id))?.loginProbeDueAt).toBeNull();
    });
  });
});
