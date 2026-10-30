/**
 * IMAP accounts whose login keeps being refused, against Postgres (docs/IMAP.md "Anmeldung
 * abgelehnt: Konto abgeschaltet?"): the answers "Yes, shut down" (one, bulk by ids with Microsoft
 * 365 objects mixed in, bulk by filter) and "No, fix the login", the DTO and the counts, the
 * resets a new password or a changed source login causes (a shut-down account is probed at once),
 * the test login that restores a shut-down account, and include/exclude of a shut-down account.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_api_login_refused_test` is recreated there and dropped after). Without it the suite is
 * skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  auditLog,
  createDb,
  type Database,
  jobs,
  protectedObjects,
  providers,
  sources,
  tenants,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

vi.mock("../sources/imap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sources/imap.js")>();
  return { ...actual, probeImapConnection: vi.fn(actual.probeImapConnection) };
});

const DATABASE = "restow_api_login_refused_test";

type Service = typeof import("./service.js");
type SourcesService = typeof import("../sources/service.js");
type LoginState = typeof import("./login-state.js");

const actor = (label = "admin@contoso.example") => ({
  userId: randomUUID(),
  label,
  ip: "192.0.2.10",
});

const DAY = 24 * 3_600_000;

describe.skipIf(!testDatabaseAdminUrl)("IMAP login question against Postgres", () => {
  let db: Database;
  let service: Service;
  let sourcesService: SourcesService;
  let loginState: LoginState;
  let probe: ReturnType<typeof vi.fn>;
  let tenantId: string;
  let counter = 0;

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    const boss = new PgBoss({ connectionString: url });
    await boss.start();
    await boss.createQueue("directory");
    // As in production: one queued backup per object (the singleton key).
    await boss.createQueue("backup", { name: "backup", policy: "stately" });
    await boss.stop({ graceful: false, wait: true });
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    db = createDb(url);
    service = await import("./service.js");
    sourcesService = await import("../sources/service.js");
    loginState = await import("./login-state.js");
    probe = vi.mocked((await import("../sources/imap.js")).probeImapConnection);
    const secretStore = await import("../../lib/secrets.js");
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({
        providerId: provider?.id as string,
        name: "Contoso",
        slug: `contoso-${randomUUID().slice(0, 8)}`,
      })
      .returning();
    tenantId = tenant?.id as string;
    await db.transaction((tx) => secretStore.createTenantKey(tx, tenantId));
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  async function imapSource(config: Record<string, unknown> = {}) {
    const [source] = await db
      .insert(sources)
      .values({
        tenantId,
        kind: "imap",
        name: `Mail ${++counter}`,
        status: "active",
        host: "imap.hoster.test",
        port: 993,
        security: "tls",
        config,
      })
      .returning();
    return source?.id as string;
  }

  /** An active IMAP account with a refused-login streak and (by default) an open question. */
  async function failingAccount(
    sourceId: string,
    options: { question?: boolean; dismissed?: boolean } = {},
  ) {
    const question = options.question ?? true;
    const [object] = await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId,
        kind: "imap",
        origin: "manual",
        status: "active",
        externalId: `acct${++counter}@hoster.test`,
        loginFailedRuns: 3,
        loginFailedSince: new Date(Date.now() - 3 * DAY),
        loginFailedAt: new Date(Date.now() - DAY),
        loginQuestionAt: question ? new Date(Date.now() - 3_600_000) : null,
        loginQuestionDismissedAt: options.dismissed ? new Date(Date.now() - 1_800_000) : null,
      })
      .returning();
    return object?.id as string;
  }

  async function shutDownAccount(sourceId: string, dueIn = 7 * DAY) {
    const id = await failingAccount(sourceId);
    await service.confirmInactiveObject(db, tenantId, id, {}, actor());
    await db
      .update(protectedObjects)
      .set({ loginProbeDueAt: new Date(Date.now() + dueIn) })
      .where(eq(protectedObjects.id, id));
    return id;
  }

  const row = async (id: string) =>
    (await db.select().from(protectedObjects).where(eq(protectedObjects.id, id)))[0];
  const jobsOf = async (id: string) =>
    db
      .select()
      .from(jobs)
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.protectedObjectId, id)));
  const query = (extra: Record<string, unknown> = {}) => ({
    page: 1,
    pageSize: 50,
    sort: "name" as const,
    order: "asc" as const,
    ...extra,
  });

  describe("the DTO and the counts", () => {
    it("names the question, the streak and a whole-source failure, and counts questions apart from to-confirm", async () => {
      const sourceId = await imapSource();
      const asked = await failingAccount(sourceId);
      const second = await failingAccount(sourceId, { question: false });
      const page = await service.listObjects(db, tenantId, query({ sourceId }));
      const dto = page.items.find((item) => item.id === asked);
      expect(dto?.loginQuestion).toMatchObject({ runs: 3, dismissedAt: null, sourceWide: true });
      expect(typeof dto?.loginQuestion?.askedAt).toBe("string");
      expect(page.items.find((item) => item.id === second)?.loginQuestion).toBeNull();

      const listed = await service.listObjects(
        db,
        tenantId,
        query({ sourceId, status: "login_question" }),
      );
      expect(listed.items.map((item) => item.id)).toEqual([asked]);
      const source = (await service.listSources(db, tenantId)).find((item) => item.id === sourceId);
      expect(source?.counts).toMatchObject({ loginQuestions: 1, toConfirm: 0, orphaned: 0 });
    });

    it("keeps a question the admin answered with No out of the filter and the count", async () => {
      const sourceId = await imapSource();
      const id = await failingAccount(sourceId, { dismissed: true });
      const listed = await service.listObjects(
        db,
        tenantId,
        query({ sourceId, status: "login_question" }),
      );
      expect(listed.items).toEqual([]);
      const source = (await service.listSources(db, tenantId)).find((item) => item.id === sourceId);
      expect(source?.counts.loginQuestions).toBe(0);
      const dto = (await service.listObjects(db, tenantId, query({ sourceId }))).items.find(
        (item) => item.id === id,
      );
      expect(dto?.loginQuestion?.dismissedAt).not.toBeNull();
    });
  });

  describe('"Yes, shut down"', () => {
    it("sets the state in one step, confirmed by the admin, probe due in a week, audited, no job queued", async () => {
      const sourceId = await imapSource();
      const id = await failingAccount(sourceId);
      const result = await service.confirmInactiveObject(
        db,
        tenantId,
        id,
        { note: "Hoster closed the account" },
        actor("lead@contoso.example"),
      );
      expect(result).toMatchObject({ confirmed: 1, skipped: 0 });
      expect(result.objects[0]).toMatchObject({
        status: "orphaned",
        statusReason: "login_refused",
        inactiveState: "confirmed",
        statusConfirmedBy: "lead@contoso.example",
        loginQuestion: null,
      });
      const after = await row(id);
      expect(after).toMatchObject({
        status: "orphaned",
        statusReason: "login_refused",
        loginQuestionAt: null,
        loginQuestionDismissedAt: null,
      });
      expect(after?.statusConfirmedAt).toBeInstanceOf(Date);
      const due = ((after?.loginProbeDueAt ?? new Date(0)) as Date).getTime() - Date.now();
      expect(due).toBeGreaterThan(6.9 * DAY);
      expect(due).toBeLessThan(7.1 * DAY);
      const audits = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.target, id), eq(auditLog.action, "directory.inactive.confirmed")));
      expect(audits).toHaveLength(1);
      expect(audits[0]?.details).toMatchObject({
        reason: "login_refused",
        via: "login_question",
        runs: 3,
        note: "Hoster closed the account",
      });
      // The first probe is due in a week: nothing is queued now.
      expect(await jobsOf(id)).toEqual([]);

      const again = await service.confirmInactiveObject(db, tenantId, id, {}, actor());
      expect(again).toMatchObject({ confirmed: 0, skipped: 1 });
    });

    it("is accepted after a No as well, and refused without a question or for another active object", async () => {
      const sourceId = await imapSource();
      const dismissed = await failingAccount(sourceId, { dismissed: true });
      expect(
        await service.confirmInactiveObject(db, tenantId, dismissed, {}, actor()),
      ).toMatchObject({ confirmed: 1 });

      const quiet = await failingAccount(sourceId, { question: false });
      await expect(
        service.confirmInactiveObject(db, tenantId, quiet, {}, actor()),
      ).rejects.toMatchObject({ status: 409, type: "urn:restow:problem:login-not-refused" });

      const [mailbox] = await db
        .insert(protectedObjects)
        .values({
          tenantId,
          sourceId: await imapSource(),
          kind: "mailbox",
          status: "active",
          externalId: "mbx@hoster.test",
        })
        .returning();
      await expect(
        service.confirmInactiveObject(db, tenantId, mailbox?.id as string, {}, actor()),
      ).rejects.toMatchObject({ status: 409, type: "urn:restow:problem:object-not-inactive" });
    });

    it("answers several by id, mixed with a Microsoft 365 object that waits for its confirmation", async () => {
      const sourceId = await imapSource();
      const [a, b] = [await failingAccount(sourceId), await failingAccount(sourceId)];
      const recovered = await failingAccount(sourceId);
      const excluded = await failingAccount(sourceId);
      // The login worked meanwhile, and an admin excluded another account.
      await db
        .update(protectedObjects)
        .set({ loginQuestionAt: null, loginFailedRuns: 0, loginFailedSince: null })
        .where(eq(protectedObjects.id, recovered));
      await db
        .update(protectedObjects)
        .set({ status: "excluded" })
        .where(eq(protectedObjects.id, excluded));
      const [m365] = await db
        .insert(sources)
        .values({ tenantId, kind: "m365", name: `M365 ${++counter}`, status: "active" })
        .returning();
      const [gone] = await db
        .insert(protectedObjects)
        .values({
          tenantId,
          sourceId: m365?.id as string,
          kind: "mailbox",
          status: "active",
          externalId: `gone${counter}@contoso.example`,
        })
        .returning();
      await db
        .update(protectedObjects)
        .set({ status: "orphaned", statusReason: "no_license" })
        .where(eq(protectedObjects.id, gone?.id as string));

      const result = await service.bulkConfirmInactive(
        db,
        tenantId,
        { objectIds: [a, b, recovered, excluded, gone?.id as string] },
        actor("bulk@contoso.example"),
      );
      expect(result.confirmed).toBe(3);
      expect(result.objects.map((object) => object.id).sort()).toEqual(
        [a, b, gone?.id as string].sort(),
      );
      expect(await row(a)).toMatchObject({ status: "orphaned", statusReason: "login_refused" });
      expect(await row(recovered)).toMatchObject({ status: "active", loginFailedRuns: 0 });
      expect(await row(excluded)).toMatchObject({ status: "excluded" });
      expect(await row(gone?.id as string)).toMatchObject({
        statusReason: "no_license",
        statusConfirmedBy: "bulk@contoso.example",
      });
      const audits = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenantId),
            eq(auditLog.action, "directory.inactive.bulk_confirmed"),
          ),
        );
      const details = audits.at(-1)?.details as Record<string, unknown>;
      expect(details).toMatchObject({
        confirmed: 3,
        loginRefused: 2,
      });
      expect([...(details.loginRefusedObjectIds as string[])].sort()).toEqual([a, b].sort());
      // Mixed with a Microsoft 365 object: nothing says the whole entry was a login question.
      expect(details).not.toHaveProperty("reason");
      expect(details).not.toHaveProperty("via");
      expect(details.loginRefusedRuns).toHaveLength(2);
      expect(details.loginRefusedFailedSince).toHaveLength(2);
    });

    it("answers every open question a filter matches, and nothing else", async () => {
      const sourceId = await imapSource();
      const open = [await failingAccount(sourceId), await failingAccount(sourceId)];
      const dismissed = await failingAccount(sourceId, { dismissed: true });
      const result = await service.bulkConfirmInactive(
        db,
        tenantId,
        { filter: { sourceId, status: "login_question" } },
        actor(),
      );
      expect(result.confirmed).toBe(2);
      expect(result.objects.map((object) => object.id).sort()).toEqual([...open].sort());
      // A "No" stays a No: only the single answer reopens it.
      expect(await row(dismissed)).toMatchObject({ status: "active" });
    });
  });

  describe('"No, fix the login"', () => {
    it("marks the question answered, audits it, and refuses a second answer or a missing question", async () => {
      const sourceId = await imapSource();
      const id = await failingAccount(sourceId);
      const dto = await service.dismissLoginQuestion(db, tenantId, id, {}, actor("lead@x.example"));
      expect(dto.loginQuestion?.dismissedAt).not.toBeNull();
      expect(await row(id)).toMatchObject({ status: "active" });
      const audits = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.target, id), eq(auditLog.action, "directory.login.dismissed")));
      expect(audits).toHaveLength(1);
      await expect(
        service.dismissLoginQuestion(db, tenantId, id, {}, actor()),
      ).rejects.toMatchObject({ status: 409, type: "urn:restow:problem:no-login-question" });
      const quiet = await failingAccount(sourceId, { question: false });
      await expect(
        service.dismissLoginQuestion(db, tenantId, quiet, {}, actor()),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  describe("a new password or login", () => {
    it("starts a new streak of an active account and lets a shut-down one resume at once", async () => {
      const sourceId = await imapSource({ imapAuthMode: "per_mailbox" });
      const active = await failingAccount(sourceId);
      const shutDown = await shutDownAccount(sourceId);

      await service.setObjectCredential(db, tenantId, active, { password: "new-1" }, actor());
      expect(await row(active)).toMatchObject({
        status: "active",
        loginFailedRuns: 0,
        loginFailedSince: null,
        loginQuestionAt: null,
      });

      await service.setObjectCredential(db, tenantId, shutDown, { password: "new-2" }, actor());
      const after = await row(shutDown);
      expect(after).toMatchObject({ status: "orphaned", statusReason: "login_refused" });
      expect(((after?.loginProbeDueAt ?? new Date(0)) as Date).getTime()).toBeLessThanOrEqual(
        Date.now(),
      );
      // The probe is a normal backup job.
      const queued = await jobsOf(shutDown);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ queue: "backup", status: "queued" });
    });

    it("does the same for a re-imported account that gets a password in the CSV", async () => {
      const sourceId = await imapSource({ imapAuthMode: "per_mailbox" });
      const shutDown = await shutDownAccount(sourceId);
      const login = (await row(shutDown))?.externalId as string;
      await service.importAccounts(
        db,
        tenantId,
        sourceId,
        [{ line: null, login, password: "from-csv" }],
        actor(),
        { dryRun: false },
      );
      expect((await row(shutDown))?.loginProbeDueAt?.getTime()).toBeLessThanOrEqual(Date.now());
      expect(await jobsOf(shutDown)).toHaveLength(1);
    });

    it("resets every account of a source whose shared password changed", async () => {
      const sourceId = await imapSource();
      const active = await failingAccount(sourceId);
      const shutDown = await shutDownAccount(sourceId);
      const other = await failingAccount(await imapSource());
      await sourcesService.updateSource(
        db,
        tenantId,
        sourceId,
        { password: "rotated" },
        { id: randomUUID(), email: "admin@contoso.example", ip: null, isProviderAdmin: false },
      );
      expect(await row(active)).toMatchObject({ loginFailedRuns: 0, loginQuestionAt: null });
      expect((await row(shutDown))?.loginProbeDueAt?.getTime()).toBeLessThanOrEqual(Date.now());
      // The changed login put the source back to `pending` (it needs a new test): a job now
      // would only be refused by the worker (config.source_not_connected, job.failed). The
      // scheduler's login-probe planner takes the due account once the source is usable.
      expect(await jobsOf(shutDown)).toEqual([]);
      // Another source is none of its business.
      expect(await row(other)).toMatchObject({ loginFailedRuns: 3 });
    });

    it("queues a probe only for accounts of a usable source", async () => {
      const pending = await imapSource();
      const disabled = await imapSource();
      const usable = await imapSource();
      await db.update(sources).set({ status: "pending" }).where(eq(sources.id, pending));
      await db.update(sources).set({ status: "disabled" }).where(eq(sources.id, disabled));
      const accounts = {
        pending: await shutDownAccount(pending),
        disabled: await shutDownAccount(disabled),
        usable: await shutDownAccount(usable),
        active: await failingAccount(usable),
        plainActive: await failingAccount(pending),
      };
      const queued = await loginState.enqueueLoginProbes(db, tenantId, Object.values(accounts));
      expect(queued.sort()).toEqual([accounts.usable, accounts.active].sort());
      expect(await jobsOf(accounts.pending)).toEqual([]);
      expect(await jobsOf(accounts.disabled)).toEqual([]);
      expect(await jobsOf(accounts.plainActive)).toEqual([]);
      expect(await jobsOf(accounts.usable)).toHaveLength(1);
      // The error state of a source is still attempted: the engine's own failure is the diagnosis.
      await db.update(sources).set({ status: "error" }).where(eq(sources.id, pending));
      expect(await loginState.enqueueLoginProbes(db, tenantId, [accounts.pending])).toEqual([
        accounts.pending,
      ]);
    });

    it("leaves the streaks alone when a source is only renamed", async () => {
      const sourceId = await imapSource({ imapAuthMode: "per_mailbox" });
      const active = await failingAccount(sourceId);
      await sourcesService.updateSource(
        db,
        tenantId,
        sourceId,
        { name: `Renamed ${++counter}` },
        { id: randomUUID(), email: "admin@contoso.example", ip: null, isProviderAdmin: false },
      );
      expect(await row(active)).toMatchObject({ loginFailedRuns: 3 });
    });
  });

  describe("test login", () => {
    const ok = {
      ok: true,
      checkedAt: new Date().toISOString(),
      secure: true,
      server: null,
      mailboxes: 3,
      specialUse: [],
      capabilities: [],
    } as const;

    /** A shared-login source that has its password stored, as a test login needs. */
    async function sourceWithPassword() {
      const sourceId = await imapSource();
      await sourcesService.updateSource(
        db,
        tenantId,
        sourceId,
        { password: "stored" },
        { id: randomUUID(), email: "admin@contoso.example", ip: null, isProviderAdmin: false },
      );
      // A new password sets the source back to `pending`; this one has been tested since.
      await db.update(sources).set({ status: "active" }).where(eq(sources.id, sourceId));
      return sourceId;
    }
    const refused = {
      ok: false,
      checkedAt: new Date().toISOString(),
      reason: "auth",
      code: null,
      message: "denied",
    } as const;

    it("restores a shut-down account with active_since, audits it and queues its backup", async () => {
      const id = await shutDownAccount(await sourceWithPassword());
      probe.mockResolvedValueOnce(ok);
      const before = Date.now();
      const result = await service.testObjectCredential(db, tenantId, id, actor("lead@x.example"));
      expect(result.probe.ok).toBe(true);
      expect(result.object).toMatchObject({
        status: "active",
        statusReason: null,
        inactiveState: null,
        loginQuestion: null,
      });
      const after = await row(id);
      expect(after).toMatchObject({
        status: "active",
        statusReason: null,
        statusConfirmedAt: null,
        loginFailedRuns: 0,
        loginProbeDueAt: null,
      });
      expect(((after?.activeSince ?? new Date(0)) as Date).getTime()).toBeGreaterThanOrEqual(
        before - 1000,
      );
      const audits = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.target, id), eq(auditLog.action, "directory.login.restored")));
      expect(audits).toHaveLength(1);
      expect(audits[0]?.details).toMatchObject({ via: "test_login" });
      expect(await jobsOf(id)).toHaveLength(1);
    });

    it("ends the streak and the question of an active account, and counts a failed test for nothing", async () => {
      const failing = await failingAccount(await sourceWithPassword());
      probe.mockResolvedValueOnce(refused);
      await service.testObjectCredential(db, tenantId, failing, actor());
      expect(await row(failing)).toMatchObject({ loginFailedRuns: 3 });
      expect((await row(failing))?.loginQuestionAt).not.toBeNull();

      probe.mockResolvedValueOnce(ok);
      await service.testObjectCredential(db, tenantId, failing, actor());
      expect(await row(failing)).toMatchObject({
        status: "active",
        loginFailedRuns: 0,
        loginQuestionAt: null,
      });
      // An account that was only failing is not restored: no backup is queued for it.
      expect(await jobsOf(failing)).toEqual([]);
    });

    it("leaves a shut-down account shut down when the test fails", async () => {
      const id = await shutDownAccount(await sourceWithPassword());
      probe.mockResolvedValueOnce(refused);
      await service.testObjectCredential(db, tenantId, id, actor());
      expect(await row(id)).toMatchObject({ status: "orphaned", statusReason: "login_refused" });
    });
  });

  describe("what the readers say about a shut-down account", () => {
    it("is not a failure, not waiting for a confirmation, and counted as orphaned in the status", async () => {
      const { loadTenantSummary } = await import("../../routes/v1/status.js");
      const own = await db
        .insert(tenants)
        .values({
          providerId: (await db.select().from(tenants).limit(1))[0]?.providerId as string,
          name: "Readers",
          slug: `readers-${randomUUID().slice(0, 8)}`,
        })
        .returning();
      const readersTenant = own[0]?.id as string;
      const [source] = await db
        .insert(sources)
        .values({
          tenantId: readersTenant,
          kind: "imap",
          name: "Readers mail",
          status: "active",
          host: "imap.hoster.test",
          port: 993,
          security: "tls",
        })
        .returning();
      const [object] = await db
        .insert(protectedObjects)
        .values({
          tenantId: readersTenant,
          sourceId: source?.id as string,
          kind: "imap",
          origin: "manual",
          status: "active",
          externalId: "old@hoster.test",
          loginFailedRuns: 3,
          loginFailedSince: new Date(Date.now() - 3 * DAY),
          loginFailedAt: new Date(Date.now() - DAY),
          loginQuestionAt: new Date(Date.now() - 3_600_000),
        })
        .returning();
      const id = object?.id as string;
      // Its newest run failed on the refused login, as every night before the answer.
      await db.insert(jobs).values({
        tenantId: readersTenant,
        queue: "backup",
        status: "failed",
        protectedObjectId: id,
        startedAt: new Date(Date.now() - 2 * 3_600_000),
        completedAt: new Date(Date.now() - 2 * 3_600_000),
        createdAt: new Date(Date.now() - 2 * 3_600_000),
        errorMessage: "The server refused the login.",
      });
      const before = await loadTenantSummary(db, readersTenant, new Date());
      expect(before.objects).toMatchObject({ active: 1, failed: 1, orphaned: 0 });

      await service.confirmInactiveObject(db, readersTenant, id, {}, actor());
      const after = await loadTenantSummary(db, readersTenant, new Date());
      // Orphaned and confirmed: out of the failures, nothing waits for a confirmation.
      expect(after.objects).toMatchObject({ active: 0, failed: 0, orphaned: 1 });
      expect(after.readiness.toConfirm ?? 0).toBe(0);
      expect(after.readiness.red).toBe(0);
    });
  });

  describe("include and exclude of a shut-down account", () => {
    it("excludes it (the probes stop, the columns are gone) and includes it again with a backup", async () => {
      const sourceId = await imapSource();
      const id = await shutDownAccount(sourceId);
      await service.setObjectProtection(db, tenantId, id, { action: "exclude" }, actor());
      expect(await row(id)).toMatchObject({
        status: "excluded",
        statusReason: null,
        statusConfirmedAt: null,
        loginProbeDueAt: null,
        loginFailedRuns: 0,
      });
      await service.setObjectProtection(db, tenantId, id, { action: "include" }, actor());
      expect(await row(id)).toMatchObject({ status: "active" });
    });

    it("includes a shut-down account at once and queues its backup, even though it has snapshots", async () => {
      const sourceId = await imapSource();
      const id = await shutDownAccount(sourceId);
      await db.delete(jobs).where(eq(jobs.protectedObjectId, id));
      const result = await service.setObjectProtection(
        db,
        tenantId,
        id,
        { action: "include" },
        actor(),
      );
      expect(result.object).toMatchObject({ status: "active", statusReason: null });
      const after = await row(id);
      expect(after?.activeSince).toBeInstanceOf(Date);
      expect(after?.statusConfirmedAt).toBeNull();
      expect(await jobsOf(id)).toHaveLength(1);
    });

    it("still keeps any other orphaned IMAP account as it is", async () => {
      const sourceId = await imapSource();
      const id = await failingAccount(sourceId, { question: false });
      await db
        .update(protectedObjects)
        .set({ status: "orphaned", statusReason: null })
        .where(eq(protectedObjects.id, id));
      await service.setObjectProtection(db, tenantId, id, { action: "include" }, actor());
      expect(await row(id)).toMatchObject({ status: "orphaned" });
    });
  });
});
