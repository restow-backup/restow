/**
 * File shares in the overviews against Postgres (docs/FILESHARES.md 13, Phase D): the counts of
 * the status and the dashboard, Recovery readiness (a row per share, `sharesWithoutJob`), the
 * failures of the provider view, History (share runs in the keyset union, their detail, the
 * scope of a share and a copy job), the warnings page (a share's warning, acknowledged and
 * revoked) and the statistics (readiness, outcomes, restores, volume). One tenant holds shares
 * in every state; the other tenant's share must never show.
 *
 * Needs RESTOW_TEST_DATABASE_URL (a superuser); skipped otherwise.
 */
import {
  backupJobMembers,
  backupJobs,
  fileShareReports,
  fileShareRunItems,
  fileShareRuns,
  fileShareSnapshots,
  fileShares,
  settings,
  warningAcknowledgements,
} from "@restow/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EndpointFixture,
  startFixture,
  testDatabaseAdminUrl,
} from "../endpoints/testing/fixture.js";

const DATABASE = "restow_api_file_shares_overviews_test";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RESTIC = (seed: string) => seed.repeat(64).slice(0, 64);

type Shared = typeof import("../../db.js");

describe.skipIf(!testDatabaseAdminUrl)("file shares in the overviews against Postgres", () => {
  let fixture: EndpointFixture;
  let shared: Shared;
  const now = new Date(Math.floor(Date.now() / HOUR) * HOUR);
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const ids = {
    office: "",
    scans: "",
    old: "",
    fresh: "",
    retired: "",
    foreign: "",
    shareJob: "",
    copyJob: "",
    greenRun: "",
    warningRun: "",
    failedRun: "",
    copyRun: "",
  };

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    shared = await import("../../db.js");
    const db = fixture.db;
    const tenantId = fixture.tenantId;
    await db.insert(settings).values({}).onConflictDoNothing();
    const share = (name: string, overrides: Partial<typeof fileShares.$inferInsert> = {}) => ({
      tenantId,
      name,
      protocol: "smb" as const,
      server: "files.example.test",
      shareName: name.toLowerCase(),
      createdAt: ago(10 * DAY),
      ...overrides,
    });
    const rows = await db
      .insert(fileShares)
      .values([
        share("Office"),
        share("Scans"),
        share("Old", { allowRestore: true }),
        share("Fresh", { createdAt: ago(3 * DAY) }),
        share("Retired", { retiredAt: ago(DAY) }),
        { ...share("Foreign"), tenantId: fixture.otherTenantId },
      ])
      .returning({ id: fileShares.id, name: fileShares.name });
    const byName = new Map(rows.map((row) => [row.name, row.id]));
    ids.office = byName.get("Office") as string;
    ids.scans = byName.get("Scans") as string;
    ids.old = byName.get("Old") as string;
    ids.fresh = byName.get("Fresh") as string;
    ids.retired = byName.get("Retired") as string;
    ids.foreign = byName.get("Foreign") as string;

    const schedule = { kind: "daily" as const, timeOfDay: "02:00", timeZone: "UTC" };
    const [shareJob] = await db
      .insert(backupJobs)
      .values({ tenantId, kind: "share", name: "Shares", schedule, createdAt: ago(5 * DAY) })
      .returning({ id: backupJobs.id });
    ids.shareJob = shareJob?.id as string;
    const [copyJob] = await db
      .insert(backupJobs)
      .values({
        tenantId,
        kind: "copy",
        name: "Office to Old",
        schedule,
        sourceFileShareId: ids.office,
        targetFileShareId: ids.old,
        settings: { mode: "overwrite", targetFolder: "Office copy" },
      })
      .returning({ id: backupJobs.id });
    ids.copyJob = copyJob?.id as string;
    await db.insert(backupJobMembers).values(
      [ids.office, ids.scans, ids.fresh].map((fileShareId) => ({
        tenantId,
        jobId: ids.shareJob,
        fileShareId,
      })),
    );
    // The other tenant's share is in a job of its own and failed: it must never be counted here.
    const [foreignJob] = await db
      .insert(backupJobs)
      .values({ tenantId: fixture.otherTenantId, kind: "share", name: "Theirs", schedule })
      .returning({ id: backupJobs.id });
    await db.insert(backupJobMembers).values({
      tenantId: fixture.otherTenantId,
      jobId: foreignJob?.id as string,
      fileShareId: ids.foreign,
    });

    // Restore points: Office (checked green), Scans (not checked), Old (checked red).
    const point = (
      fileShareId: string,
      sequence: number,
      seed: string,
      at: Date,
      bytes: number,
      bytesAdded: number,
    ) => ({
      tenantId,
      fileShareId,
      sequence,
      resticSnapshotId: RESTIC(seed),
      snapshotTime: at,
      files: 10,
      bytes,
      bytesAdded,
    });
    const points = await db
      .insert(fileShareSnapshots)
      .values([
        point(ids.office, 1, "a", ago(2 * DAY), 5000, 300),
        point(ids.scans, 1, "b", ago(3 * HOUR), 7000, 700),
        point(ids.old, 1, "c", ago(9 * DAY), 900, 900),
      ])
      .returning({ id: fileShareSnapshots.id, fileShareId: fileShareSnapshots.fileShareId });
    const pointOf = new Map(points.map((row) => [row.fileShareId, row.id]));
    await db.insert(fileShareReports).values([
      {
        tenantId,
        fileShareId: ids.office,
        kind: "restore_test",
        readiness: "green",
        snapshotId: RESTIC("a"),
        checkedAt: ago(DAY),
      },
      {
        tenantId,
        fileShareId: ids.old,
        kind: "restore_test",
        readiness: "red",
        snapshotId: RESTIC("c"),
        checkedAt: ago(8 * DAY),
      },
    ]);
    await db
      .update(fileShares)
      .set({ lastSuccessAt: ago(2 * DAY), lastSnapshotId: pointOf.get(ids.office) as string })
      .where(eq(fileShares.id, ids.office));
    await db
      .update(fileShares)
      .set({ lastSuccessAt: ago(3 * HOUR), lastSnapshotId: pointOf.get(ids.scans) as string })
      .where(eq(fileShares.id, ids.scans));
    await db
      .update(fileShares)
      .set({ lastSuccessAt: ago(9 * DAY), lastSnapshotId: pointOf.get(ids.old) as string })
      .where(eq(fileShares.id, ids.old));

    const run = (
      fileShareId: string,
      kind: "backup" | "restore",
      status: "succeeded" | "warning" | "failed",
      finishedAt: Date,
      overrides: Partial<typeof fileShareRuns.$inferInsert> = {},
    ) => ({
      tenantId,
      fileShareId,
      lockShareId: fileShareId,
      kind,
      status,
      trigger: "schedule" as const,
      backupJobId: ids.shareJob,
      queuedAt: new Date(finishedAt.getTime() - HOUR),
      startedAt: new Date(finishedAt.getTime() - HOUR + 60_000),
      finishedAt,
      createdAt: new Date(finishedAt.getTime() - HOUR),
      ...overrides,
    });
    const runs = await db
      .insert(fileShareRuns)
      .values([
        run(ids.office, "backup", "succeeded", ago(2 * DAY), {
          snapshotId: pointOf.get(ids.office) as string,
          stats: { files: 10, bytes: 5000, dataAdded: 300 },
        }),
        run(ids.scans, "backup", "warning", ago(3 * HOUR), {
          snapshotId: pointOf.get(ids.scans) as string,
          stats: { files: 12, bytes: 7000, dataAdded: 700, items: { locked_file: 2 } },
          itemCount: 2,
          itemsStored: 2,
        }),
        run(ids.fresh, "backup", "failed", ago(2 * HOUR), {
          failure: { code: "share.auth_failed" } as never,
          errorMessage: "logon failure",
        }),
        run(ids.office, "restore", "succeeded", ago(HOUR), {
          lockShareId: ids.old,
          targetShareId: ids.old,
          trigger: "copy",
          backupJobId: ids.copyJob,
          stats: { files: 10 },
        }),
      ])
      .returning({ id: fileShareRuns.id });
    ids.greenRun = runs[0]?.id as string;
    ids.warningRun = runs[1]?.id as string;
    ids.failedRun = runs[2]?.id as string;
    ids.copyRun = runs[3]?.id as string;
    await db.insert(fileShareRunItems).values([
      {
        tenantId,
        runId: ids.warningRun,
        path: "/Scans/2026/report.xlsx",
        code: "locked_file",
        phase: "backup",
        message: "sharing violation",
      },
      {
        tenantId,
        runId: ids.warningRun,
        path: "/Scans/2026/budget.xlsx",
        code: "locked_file",
        phase: "backup",
        message: "sharing violation",
      },
    ]);
    await db.insert(fileShareRuns).values({
      ...run(ids.foreign, "backup", "failed", ago(HOUR)),
      tenantId: fixture.otherTenantId,
      backupJobId: foreignJob?.id as string,
    });
  }, 120_000);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  it("counts the shares for the status and the dashboard", async () => {
    const { loadShareCounts } = await import("./protection.js");
    const { counts, staleAfterHours } = await loadShareCounts(shared.db, fixture.tenantId, now);
    expect(counts).toEqual({
      total: 4,
      protected: 3,
      withoutJob: 1,
      failedLastBackup: 1,
      warnings: 1,
      lastSuccessAt: ago(3 * HOUR).toISOString(),
      restorePoints: 3,
    });
    expect(staleAfterHours).toBe(48);
    const other = await loadShareCounts(shared.db, fixture.otherTenantId, now);
    expect(other.counts).toMatchObject({ total: 1, protected: 1, failedLastBackup: 1 });
  });

  it("rates every share in Recovery readiness, and counts the one out of every job", async () => {
    const { readinessOverview } = await import("../verify/service.js");
    const overview = await readinessOverview(shared.db, fixture.tenantId, now);
    const rows = new Map(overview.shares.map((row) => [row.name, row]));
    expect([...rows.keys()].sort()).toEqual(["Fresh", "Office", "Old", "Scans"]);
    expect(rows.get("Office")).toMatchObject({ state: "green", readiness: "green", inJob: true });
    expect(rows.get("Scans")).toMatchObject({ state: "unverified", inJob: true });
    expect(rows.get("Old")).toMatchObject({ state: "red", inJob: false });
    // In a job for three days without a backup: past the first backup's grace.
    expect(rows.get("Fresh")).toMatchObject({ state: "no_backup", overdue: true });
    expect(overview.summary).toMatchObject({
      total: 4,
      green: 1,
      red: 1,
      unverified: 1,
      noBackup: 1,
      sharesWithoutJob: 1,
      withoutJob: 0,
      guestsWithoutJob: 0,
      overall: "red",
    });
  });

  it("shows the shares on the start page and counts their failures for the provider view", async () => {
    const { loadDashboard } = await import("../dashboard/service.js");
    const { loadTenantHealthExtras } = await import("../dashboard/queries.js");
    const [tenant] = await fixture.db
      .select()
      .from((await import("@restow/db")).tenants)
      .where(eq((await import("@restow/db")).tenants.id, fixture.tenantId));
    const dto = await loadDashboard(
      { db: shared.db, providerDb: shared.providerDb, env: process.env, now: () => now },
      {
        tenant: tenant as never,
        role: "tenant_admin",
        isProviderAdmin: false,
      },
      {
        provider: false,
        tenantWidgets: true,
        widgets: ["lastBackup", "protectedObjects", "readiness", "setup"],
      },
    );
    const last = dto.widgets.lastBackup;
    expect(last?.state).toBe("ok");
    if (last?.state === "ok") {
      expect(last.data.fileShares).toEqual({
        protected: 3,
        withoutJob: 1,
        lastSuccessAt: ago(3 * HOUR).toISOString(),
      });
      expect(last.data.staleAfterHours.fileShares).toBe(48);
    }
    const objects = dto.widgets.protectedObjects;
    expect(objects?.state).toBe("ok");
    if (objects?.state === "ok") {
      expect(objects.data.fileShares).toEqual({
        protected: 3,
        withoutJob: 1,
        failedLastBackup: 1,
        warnings: 1,
        restorePoints: 3,
      });
    }
    const readiness = dto.widgets.readiness;
    expect(readiness?.state === "ok" && readiness.data.sharesWithoutJob).toBe(1);
    const setup = dto.widgets.setup;
    expect(setup?.state).toBe("ok");
    if (setup?.state === "ok") {
      const state = (id: string) => setup.data.items.find((item) => item.id === id)?.state;
      // A tenant with only file shares has protected objects, a job and a first backup.
      expect(state("objects")).toBe("done");
      expect(state("schedules")).toBe("done");
      expect(state("firstBackup")).toBe("done");
      expect(state("firstVerification")).toBe("done");
    }
    const extras = await loadTenantHealthExtras(shared.db, fixture.tenantId, now);
    expect(extras.failures24h).toBe(1);
  });

  it("lists share runs in History, newest first, with their job, and filters them", async () => {
    const { listHistory, getRunDetail } = await import("../history/read.js");
    const page = await listHistory(shared.db, fixture.tenantId, { limit: 50 });
    const shareRuns = page.items.filter((run) => run.source === "file_share");
    expect(shareRuns.map((run) => run.id)).toEqual([
      ids.copyRun,
      ids.failedRun,
      ids.warningRun,
      ids.greenRun,
    ]);
    expect(shareRuns[0]).toMatchObject({
      kind: "restore",
      type: "copy",
      state: "succeeded",
      trigger: "scheduled",
      job: { id: ids.copyJob, name: "Office to Old" },
      subject: { kind: "file_share", id: ids.office, name: "Office" },
    });
    expect(shareRuns[0]?.subject?.detail).toBe("\\\\files.example.test\\office");
    expect(shareRuns[1]).toMatchObject({ kind: "backup", state: "failed" });
    expect(shareRuns[1]?.failure?.code).toBe("share.auth_failed");
    expect(shareRuns[2]).toMatchObject({ state: "partial", progress: { itemsFailed: 2 } });
    // The other tenant's run is not here.
    expect(page.items.some((run) => run.subject?.name === "Foreign")).toBe(false);

    const restores = await listHistory(shared.db, fixture.tenantId, {
      limit: 50,
      category: "restore",
    });
    expect(restores.items.map((run) => run.id)).toEqual([ids.copyRun]);
    const checks = await listHistory(shared.db, fixture.tenantId, {
      limit: 50,
      category: "restore_check",
    });
    expect(checks.items.filter((run) => run.source === "file_share")).toEqual([]);

    // The scope of a job: the share job's backups, the copy job's runs.
    const ofShareJob = await listHistory(shared.db, fixture.tenantId, {
      limit: 50,
      jobId: ids.shareJob,
    });
    expect(ofShareJob.items.map((run) => run.id)).toEqual([
      ids.failedRun,
      ids.warningRun,
      ids.greenRun,
    ]);
    const ofCopyJob = await listHistory(shared.db, fixture.tenantId, {
      limit: 50,
      jobId: ids.copyJob,
    });
    expect(ofCopyJob.items.map((run) => run.id)).toEqual([ids.copyRun]);

    // Keyset paging across the union keeps every run once.
    const first = await listHistory(shared.db, fixture.tenantId, { limit: 2 });
    const second = await listHistory(shared.db, fixture.tenantId, {
      limit: 50,
      cursor: first.next ?? undefined,
    });
    expect([...first.items, ...second.items].map((run) => run.id)).toEqual(
      page.items.map((run) => run.id),
    );

    const detail = await getRunDetail(shared.db, fixture.tenantId, ids.greenRun);
    expect(detail).toMatchObject({
      source: "file_share",
      restoreCheck: { state: "passed" },
      summary: { snapshot: { sequence: 1 }, bytesNew: 300 },
    });
    const warning = await getRunDetail(shared.db, fixture.tenantId, ids.warningRun);
    expect(warning.restoreCheck.state).toBe("unverified");
    expect(warning.errorCount).toBe(2);
    expect(warning.errors.map((error) => error.path).sort()).toEqual([
      "/Scans/2026/budget.xlsx",
      "/Scans/2026/report.xlsx",
    ]);
    expect(warning.errors[0]).toMatchObject({ code: "locked_file", cause: "share.locked_files" });
    expect(warning.events.map((event) => event.type)).toContain("item_failed");
  });

  it("follows running share runs in the live window", async () => {
    const { liveRuns } = await import("../history/read.js");
    const { withTenantTx } = await import("../../lib/tenant-context.js");
    const live = await withTenantTx(shared.db, fixture.tenantId, (tx) =>
      liveRuns(tx, fixture.tenantId, ago(150 * 60_000)),
    );
    expect(live.runs.map((run) => run.id)).toEqual(
      expect.arrayContaining([ids.copyRun, ids.failedRun]),
    );
    expect(live.runs.some((run) => run.id === ids.greenRun)).toBe(false);
  });

  it("lists a share's warning, explains it, and lets an administrator acknowledge it", async () => {
    const warnings = await import("../warnings/service.js");
    const list = await warnings.listWarnings(shared.db, fixture.tenantId);
    const scans = list.items.find((item) => item.target.id === ids.scans);
    expect(scans).toMatchObject({
      target: { kind: "share", subjectKind: "file_share", name: "Scans" },
      state: "open",
      causes: [{ code: "share.locked_files", count: 2 }],
    });
    // Fresh's newest backup failed outright: counted as failed, not listed as a warning.
    expect(list.counts.failed).toBeGreaterThanOrEqual(1);
    expect(list.items.some((item) => item.target.id === ids.fresh)).toBe(false);

    const detail = await warnings.getWarning(shared.db, fixture.tenantId, "share", ids.scans);
    expect(detail.focusRunId).toBe(ids.warningRun);
    expect(detail.items).toHaveLength(2);
    expect(detail.groups[0]).toMatchObject({ count: 2, failure: { code: "share.locked_files" } });
    expect(detail.runs[0]).toMatchObject({ id: ids.warningRun, outcome: "partial" });
    expect(detail.acknowledge.allowed).toBe(true);

    const actor = { userId: fixture.adminId, label: "admin@contoso.example", ip: null };
    const result = await warnings.acknowledgeWarnings(
      shared.db,
      fixture.tenantId,
      {
        targets: [
          { kind: "share", id: ids.scans },
          { kind: "share", id: ids.fresh },
        ],
        note: "Excel was open",
      },
      actor,
    );
    expect(result.acknowledged.map((item) => item.target.id)).toEqual([ids.scans]);
    expect(result.skipped).toEqual([{ kind: "share", id: ids.fresh, reason: "failed" }]);
    const [ack] = await fixture.db
      .select()
      .from(warningAcknowledgements)
      .where(eq(warningAcknowledgements.fileShareId, ids.scans));
    expect(ack).toMatchObject({ causes: ["share.locked_files"], runId: ids.warningRun });
    const after = await warnings.listWarnings(shared.db, fixture.tenantId);
    expect(after.items.find((item) => item.target.id === ids.scans)?.state).toBe("acknowledged");

    await warnings.revokeAcknowledgement(
      shared.db,
      fixture.tenantId,
      { kind: "share", id: ids.scans },
      actor,
    );
    const revoked = await warnings.listWarnings(shared.db, fixture.tenantId);
    expect(revoked.items.find((item) => item.target.id === ids.scans)?.state).toBe("open");
    // The other tenant's share is not reachable from here.
    await expect(
      warnings.getWarning(shared.db, fixture.tenantId, "share", ids.foreign),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("adds the shares to the statistics", async () => {
    const { loadStats } = await import("../stats/service.js");
    const today = now.toISOString().slice(0, 10);
    const from = ago(6 * DAY)
      .toISOString()
      .slice(0, 10);
    const { stats } = await loadStats(
      { db: shared.db, providerDb: shared.providerDb, now: () => now },
      {
        kind: "tenant",
        tenant: { id: fixture.tenantId, name: "Contoso", slug: "contoso-gmbh" },
      },
      { from, to: today },
    );
    // Office, Scans, Fresh and Old (out of every job, with a restore point).
    expect(stats.kpis.protectedObjects.value).toBe(4);
    expect(Array.isArray(stats.series.readiness)).toBe(true);
    if (Array.isArray(stats.series.readiness)) {
      expect(stats.series.readiness.at(-1)).toMatchObject({ green: 1, red: 1, unverified: 2 });
    }
    if (Array.isArray(stats.series.backups)) {
      const total = stats.series.backups.reduce(
        (sum, point) => ({ ok: sum.ok + point.succeeded, failed: sum.failed + point.failed }),
        { ok: 0, failed: 0 },
      );
      expect(total).toEqual({ ok: 2, failed: 1 });
    } else {
      throw new Error("backups unavailable");
    }
    if (Array.isArray(stats.series.restores)) {
      expect(stats.series.restores.reduce((sum, point) => sum + point.completed, 0)).toBe(1);
    } else {
      throw new Error("restores unavailable");
    }
    if (Array.isArray(stats.series.volume)) {
      const added = stats.series.volume.reduce((sum, point) => sum + point.physicalBytes, 0);
      // Office's and Scans' restore points fall in the period; Old's is older.
      expect(added).toBe(1000);
    } else {
      throw new Error("volume unavailable");
    }
  });
});
