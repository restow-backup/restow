/**
 * The worker's side of file share backup against Postgres (docs/FILESHARES.md 16.2), with a
 * stand-in mounter that records what it is asked: queueing (one queued backup per share, the
 * skipped tick, copy runs), the dispatcher (the runner limit, one run per share mount, restores
 * first, the mounter unreachable, its refusals, the address rule, the budget, the copy rules and
 * the restore point a copy takes), the monitor (every stale state, cancellations, unprocessed
 * finishes, the budget alerts), finish processing and its alerts and webhooks, and the overdue
 * alert. Retention against a real repository (never the newest restore point with files) runs
 * when restic is available.
 *
 * Needs RESTOW_TEST_DATABASE_URL (a superuser); skipped otherwise.
 */
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GIB,
  RunnerRefusedError,
  RunnerUnavailableError,
  hashSecret,
  resticBinary,
  resticSnapshots,
  runRestic,
  withRepository,
} from "@restow/core";
import {
  type FileShare,
  type FileShareRun,
  type NewFileShareRun,
  backupJobs,
  fileShareReports,
  fileShareRuns,
  fileShareSnapshots,
  fileShares,
  notifications,
  settings,
  webhookDeliveries,
  webhooks,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alertOverdueBackups } from "../overdue.js";
import { shareRepositoryAccess } from "./common.js";
import { dispatchPass, ensureShareRepository } from "./dispatch.js";
import { endRun, processFinish } from "./finish.js";
import { shareRetention } from "./maintenance.js";
import { fileShareMonitor } from "./monitor.js";
import { SKIPPED_NOTE, queueShareBackup, queueShareCopy } from "./queue.js";
import {
  type ShareFixture,
  addShare,
  addShareJob,
  adminUrl,
  startShareFixture,
  storeTenantSecret,
} from "./testing/fixture.js";

const MINUTE = 60_000;
const resticAvailable = spawnSync(resticBinary(), ["version"]).status === 0;

describe.skipIf(!adminUrl)("file share jobs of the worker against Postgres", () => {
  let fixture: ShareFixture;
  let tenant: string;

  beforeAll(async () => {
    fixture = await startShareFixture("restow_worker_file_shares_test");
    tenant = fixture.contoso;
  }, 90_000);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  beforeEach(async () => {
    // Every test starts with an empty queue and an idle mounter.
    await fixture.owner.delete(fileShareRuns);
    fixture.runner.started.length = 0;
    fixture.runner.stopped.length = 0;
    fixture.runner.runs.clear();
    fixture.runner.failStart = null;
    fixture.runner.failGet = null;
    fixture.runner.onStart = () => undefined;
    fixture.clock.now = new Date();
    await fixture.owner.update(settings).set({ fileShareSettings: { maxConcurrentRunners: 2 } });
  });

  /** A share with a repository password and a ready repository (no restic needed). */
  async function readyShare(values: Partial<FileShare> = {}): Promise<FileShare> {
    const secretId = await storeTenantSecret(fixture, tenant, "file_share_repository", "repo-pw");
    return addShare(fixture, tenant, {
      repositorySecretId: secretId,
      repositoryReadyAt: new Date(),
      ...values,
    });
  }

  async function insertRun(values: Partial<NewFileShareRun> & { fileShareId: string }) {
    const [row] = await fixture.owner
      .insert(fileShareRuns)
      .values({
        tenantId: tenant,
        lockShareId: values.fileShareId,
        kind: "backup",
        status: "queued",
        ...values,
      })
      .returning();
    return row as FileShareRun;
  }

  async function run(id: string): Promise<FileShareRun> {
    const [row] = await fixture.owner.select().from(fileShareRuns).where(eq(fileShareRuns.id, id));
    return row as FileShareRun;
  }

  async function share(id: string): Promise<FileShare> {
    const [row] = await fixture.owner.select().from(fileShares).where(eq(fileShares.id, id));
    return row as FileShare;
  }

  async function snapshot(shareId: string, sequence: number, files = 3) {
    const [row] = await fixture.owner
      .insert(fileShareSnapshots)
      .values({
        tenantId: tenant,
        fileShareId: shareId,
        sequence,
        resticSnapshotId: `${sequence}`.padStart(64, "a"),
        snapshotTime: new Date(),
        files,
      })
      .returning();
    return row as typeof fileShareSnapshots.$inferSelect;
  }

  async function events(event: string): Promise<{ details: Record<string, unknown> | null }[]> {
    return fixture.owner
      .select({ details: notifications.details })
      .from(notifications)
      .where(and(eq(notifications.tenantId, tenant), eq(notifications.event, event)));
  }

  describe("queueing", () => {
    it("keeps one queued backup per share and records a skipped tick", async () => {
      const s = await readyShare();
      const job = await addShareJob(fixture, tenant, [s.id]);
      const payload = {
        tenantId: tenant,
        fileShareId: s.id,
        backupJobId: job,
        trigger: "schedule" as const,
      };
      expect(await queueShareBackup(fixture.deps, payload)).toBe("queued");
      expect(await queueShareBackup(fixture.deps, { ...payload, trigger: "manual" })).toBe(
        "already_queued",
      );
      expect(await queueShareBackup(fixture.deps, payload)).toBe("skipped");
      const runs = await fixture.owner
        .select()
        .from(fileShareRuns)
        .where(eq(fileShareRuns.fileShareId, s.id));
      expect(runs.map((r) => r.status).sort()).toEqual(["cancelled", "queued"]);
      expect(runs.find((r) => r.status === "cancelled")?.params.note).toBe(SKIPPED_NOTE);
    });

    it("queues nothing for a retired share or a switched-off job", async () => {
      const retired = await readyShare({ retiredAt: new Date() });
      expect(
        await queueShareBackup(fixture.deps, {
          tenantId: tenant,
          fileShareId: retired.id,
          backupJobId: null,
          trigger: "manual",
        }),
      ).toBe("not_due");
      const s = await readyShare();
      const job = await addShareJob(fixture, tenant, [s.id], { enabled: false });
      expect(
        await queueShareBackup(fixture.deps, {
          tenantId: tenant,
          fileShareId: s.id,
          backupJobId: job,
          trigger: "schedule",
        }),
      ).toBe("not_due");
    });

    it("queues one restore run per copy job, holding the target's mount", async () => {
      const source = await readyShare();
      const target = await readyShare({ allowRestore: true, exportPath: "/srv/replica" });
      const [job] = await fixture.owner
        .insert(backupJobs)
        .values({
          tenantId: tenant,
          kind: "copy",
          name: "Replica",
          sourceFileShareId: source.id,
          targetFileShareId: target.id,
          settings: { mode: "mirror", targetFolder: "Replica" },
        })
        .returning();
      const payload = { tenantId: tenant, backupJobId: job?.id as string };
      expect(await queueShareCopy(fixture.deps, payload)).toBe("queued");
      expect(await queueShareCopy(fixture.deps, payload)).toBe("already_queued");
      const [copy] = await fixture.owner
        .select()
        .from(fileShareRuns)
        .where(eq(fileShareRuns.backupJobId, job?.id as string));
      expect(copy).toMatchObject({
        kind: "restore",
        trigger: "copy",
        fileShareId: source.id,
        lockShareId: target.id,
        params: { mode: "mirror", targetFolder: "Replica" },
      });
    });
  });

  describe("the dispatcher", () => {
    it("starts restores first, at most the runner limit, never two on one share", async () => {
      const a = await readyShare({ allowRestore: true });
      const b = await readyShare();
      const c = await readyShare();
      const snap = await snapshot(a.id, 1);
      const backupA = await insertRun({
        fileShareId: a.id,
        queuedAt: new Date(Date.now() - 3 * MINUTE),
      });
      const backupB = await insertRun({
        fileShareId: b.id,
        queuedAt: new Date(Date.now() - 2 * MINUTE),
      });
      const backupC = await insertRun({
        fileShareId: c.id,
        queuedAt: new Date(Date.now() - MINUTE),
      });
      const restore = await insertRun({
        fileShareId: a.id,
        kind: "restore",
        sourceSnapshotId: snap.id,
        params: { destination: "new_folder" },
      });
      const summary = await dispatchPass(fixture.deps);
      expect(summary.started).toBe(2);
      expect(fixture.runner.started.map((request) => request.runId)).toEqual([
        restore.id,
        backupB.id,
      ]);
      expect((await run(backupA.id)).status).toBe("queued");
      expect((await run(backupC.id)).status).toBe("queued");
      const started = await run(restore.id);
      expect(started.status).toBe("starting");
      const request = fixture.runner.started[0];
      expect(request?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(started.tokenHash).toBe(hashSecret(request?.token as string));
      expect(request).toMatchObject({
        kind: "restore",
        mounts: [
          { role: "target", readOnly: false, share: { protocol: "nfs", address: "10.20.30.40" } },
        ],
        limits: { memoryMiB: 2048, goMemLimitMiB: 1638, cacheKey: a.id },
      });
      expect(Date.parse(request?.limits.deadline as string) - fixture.clock.now.getTime()).toBe(
        72 * 60 * MINUTE,
      );
      expect(fixture.runner.started[1]?.mounts[0]).toMatchObject({
        role: "source",
        readOnly: true,
      });
      // Nothing more fits while both run.
      expect((await dispatchPass(fixture.deps)).started).toBe(0);
    });

    it("puts the run back when the mounter is not there, and fails it when the mounter refuses", async () => {
      const s = await readyShare({
        protocol: "smb",
        shareName: "data",
        exportPath: null,
        nfsVersion: null,
        username: "backup",
        credentialSecretId: await storeTenantSecret(
          fixture,
          tenant,
          "file_share_password",
          "S3cr3t,pw",
        ),
      });
      const queued = await insertRun({ fileShareId: s.id });
      fixture.runner.failStart = new RunnerUnavailableError("unreachable");
      expect((await dispatchPass(fixture.deps)).requeued).toBe(1);
      const back = await run(queued.id);
      expect(back).toMatchObject({ status: "queued", tokenHash: null, startedAt: null });
      expect(back.params.note).toBe("Waiting for the mounter");

      fixture.runner.failStart = new RunnerRefusedError(
        422,
        "mount.auth_failed",
        "failed to mount local volume: mount //files/data: permission denied (password=S3cr3t,pw)",
      );
      expect((await dispatchPass(fixture.deps)).failed).toBe(1);
      const failed = await run(queued.id);
      expect(failed.status).toBe("failed");
      expect(failed.failure?.code).toBe("share.auth_failed");
      expect(JSON.stringify(failed)).not.toContain("S3cr3t");
      expect((await share(s.id)).credentialFailedAt).not.toBeNull();
      const raised = await events("backup.failed");
      expect(raised.some((e) => e.details?.fileShareId === s.id)).toBe(true);
    });

    it("hands the mounter the SMB account, password and pinned address", async () => {
      const s = await readyShare({
        protocol: "smb",
        shareName: "data",
        exportPath: null,
        nfsVersion: null,
        username: "backup",
        smbDomain: "CONTOSO",
        smbEncryption: true,
        credentialSecretId: await storeTenantSecret(fixture, tenant, "file_share_password", "pw-1"),
      });
      await insertRun({ fileShareId: s.id });
      expect((await dispatchPass(fixture.deps)).started).toBe(1);
      expect(fixture.runner.started[0]?.mounts[0]?.share).toEqual({
        protocol: "smb",
        server: "nfs.example.test",
        address: "10.20.30.40",
        share: "data",
        subfolder: "",
        username: "backup",
        password: "pw-1",
        domain: "CONTOSO",
        smbVersion: "3.1.1",
        seal: true,
      });
    });

    it("refuses an unapproved private address, a used-up budget and a target that allows no restore", async () => {
      const unapproved = await readyShare({ privateNetworkApproval: null });
      const blocked = await insertRun({ fileShareId: unapproved.id });
      const full = await readyShare({ quotaGib: 1, repositoryBytes: 2 * GIB });
      const overBudget = await insertRun({ fileShareId: full.id });
      const closed = await readyShare({ allowRestore: false });
      const snap = await snapshot(closed.id, 1);
      const restore = await insertRun({
        fileShareId: closed.id,
        kind: "restore",
        sourceSnapshotId: snap.id,
      });
      await fixture.owner.update(settings).set({ fileShareSettings: { maxConcurrentRunners: 5 } });
      expect((await dispatchPass(fixture.deps)).failed).toBe(3);
      expect((await run(blocked.id)).failure).toMatchObject({
        code: "share.address_blocked",
        params: { reason: "private_network" },
      });
      expect((await run(overBudget.id)).failure?.code).toBe("share.quota_exceeded");
      expect((await run(restore.id)).failure?.code).toBe("share.restore_not_allowed");
      expect(fixture.runner.started).toEqual([]);
      // The installation switch lets every tenant use private networks.
      await fixture.owner
        .update(settings)
        .set({ fileShareSettings: { tenantsMayUsePrivateNetworks: true } });
      const later = await insertRun({ fileShareId: unapproved.id });
      expect((await dispatchPass(fixture.deps)).started).toBe(1);
      expect((await run(later.id)).status).toBe("starting");
    });

    it("copies the newest verified restore point, once, and checks the rules again", async () => {
      const source = await readyShare();
      const target = await readyShare({ allowRestore: true, exportPath: "/srv/replica" });
      const [job] = await fixture.owner
        .insert(backupJobs)
        .values({
          tenantId: tenant,
          kind: "copy",
          name: "Copy",
          sourceFileShareId: source.id,
          targetFileShareId: target.id,
          settings: { mode: "mirror", targetFolder: "Replica" },
        })
        .returning();
      const jobId = job?.id as string;
      const copyRun = () =>
        insertRun({
          fileShareId: source.id,
          lockShareId: target.id,
          targetShareId: target.id,
          kind: "restore",
          trigger: "copy",
          backupJobId: jobId,
          params: { mode: "mirror", targetFolder: "Replica" },
        });

      // No restore point has passed its restore check yet.
      const first = await copyRun();
      await dispatchPass(fixture.deps);
      expect((await run(first.id)).failure?.code).toBe("share.copy_no_verified_point");

      const one = await snapshot(source.id, 1, 10);
      const two = await snapshot(source.id, 2, 12);
      await fixture.owner.insert(fileShareReports).values([
        {
          tenantId: tenant,
          fileShareId: source.id,
          kind: "restore_test",
          readiness: "green",
          snapshotId: one.resticSnapshotId,
        },
        {
          tenantId: tenant,
          fileShareId: source.id,
          kind: "restore_test",
          readiness: "red",
          snapshotId: two.resticSnapshotId,
        },
      ]);
      const second = await copyRun();
      expect((await dispatchPass(fixture.deps)).started).toBe(1);
      const started = await run(second.id);
      expect(started.sourceSnapshotId).toBe(one.id);
      expect(started.params).toMatchObject({
        mode: "mirror",
        targetFolder: "Replica",
        lastCopiedFileCount: 0,
      });
      expect(fixture.runner.started[0]?.limits.cacheKey).toBe(source.id);
      await endRun(fixture.deps, started, {
        status: "succeeded",
        stats: { restore: { restored: 10 } },
      });
      expect((await events("restore.completed")).some((e) => e.details?.runId === second.id)).toBe(
        true,
      );

      // The same restore point again: already up to date, no alert.
      const third = await copyRun();
      expect((await dispatchPass(fixture.deps)).upToDate).toBe(1);
      const upToDate = await run(third.id);
      expect(upToDate).toMatchObject({ status: "succeeded", stats: { upToDate: true } });
      expect((await events("restore.completed")).some((e) => e.details?.runId === third.id)).toBe(
        false,
      );

      // A newer verified point with far fewer files: refused for a mirror.
      const three = await snapshot(source.id, 3, 4);
      await fixture.owner.insert(fileShareReports).values({
        tenantId: tenant,
        fileShareId: source.id,
        kind: "restore_test",
        readiness: "green",
        snapshotId: three.resticSnapshotId,
      });
      const fourth = await copyRun();
      await dispatchPass(fixture.deps);
      expect((await run(fourth.id)).failure).toMatchObject({
        code: "share.copy_empty_source",
        params: { reason: "halved" },
      });

      // A mirror into the target's root is never allowed.
      await fixture.owner
        .update(backupJobs)
        .set({ settings: { mode: "mirror", targetFolder: "" } })
        .where(eq(backupJobs.id, jobId));
      const fifth = await copyRun();
      await dispatchPass(fixture.deps);
      expect((await run(fifth.id)).failure).toMatchObject({
        code: "share.copy_unsafe_target",
        params: { reason: "share_root" },
      });
    });
  });

  describe("the monitor", () => {
    async function started(
      values: Partial<NewFileShareRun> & { status: "starting" | "running" },
    ): Promise<FileShareRun> {
      const s = await readyShare();
      const now = fixture.clock.now.getTime();
      return insertRun({
        fileShareId: s.id,
        startedAt: new Date(now - 60 * MINUTE),
        tokenHash: "x",
        tokenExpiresAt: new Date(now + 60 * MINUTE),
        ...values,
      });
    }

    function alive(runId: string): void {
      fixture.runner.runs.set(runId, {
        runId,
        kind: "backup",
        state: "running",
        startedAt: new Date().toISOString(),
        deadline: new Date().toISOString(),
        exitCode: null,
        finishedAt: null,
        stopReason: null,
        stderrTail: null,
      });
    }

    it("ends every kind of stale run with its cause", async () => {
      const now = fixture.clock.now.getTime();
      const lost = await started({ status: "starting", startedAt: new Date(now - 6 * MINUTE) });
      const neverAsked = await started({
        status: "starting",
        startedAt: new Date(now - 6 * MINUTE),
      });
      alive(neverAsked.id);
      const oom = await started({ status: "running", lastProgressAt: new Date(now - 11 * MINUTE) });
      alive(oom.id);
      fixture.runner.exit(oom.id, 137, new Date(now - 5 * MINUTE), "killed");
      const stalled = await started({
        status: "running",
        lastProgressAt: new Date(now - 31 * MINUTE),
      });
      alive(stalled.id);
      const quiet = await started({
        status: "running",
        lastProgressAt: new Date(now - 11 * MINUTE),
      });
      alive(quiet.id);
      const late = await started({
        status: "running",
        lastProgressAt: new Date(now),
        tokenExpiresAt: new Date(now - MINUTE),
      });
      const cancelled = await started({
        status: "running",
        lastProgressAt: new Date(now),
        cancelRequestedAt: new Date(now - 3 * MINUTE),
      });
      const summary = await fileShareMonitor(fixture.deps);
      expect((await run(lost.id)).failure?.code).toBe("share.runner_lost");
      expect((await run(neverAsked.id)).failure?.code).toBe("share.runner_failed");
      expect((await run(oom.id)).failure?.code).toBe("share.out_of_memory");
      expect((await run(stalled.id)).failure?.code).toBe("share.runner_stalled");
      expect((await run(quiet.id)).status).toBe("running");
      expect((await run(late.id)).failure?.code).toBe("share.timeout");
      expect((await run(cancelled.id)).status).toBe("cancelled");
      expect(fixture.runner.stopped.sort()).toEqual(
        [neverAsked.id, stalled.id, late.id, cancelled.id].sort(),
      );
      expect(summary).toMatchObject({ failed: 5, cancelled: 1 });
      // Ended runs hold no credential any more.
      expect((await run(late.id)).tokenHash).toBeNull();
    });

    it("leaves runs alone while the mounter cannot be asked", async () => {
      const now = fixture.clock.now.getTime();
      const quiet = await started({
        status: "running",
        lastProgressAt: new Date(now - 40 * MINUTE),
      });
      fixture.runner.failGet = new RunnerUnavailableError("unreachable");
      await fileShareMonitor(fixture.deps);
      expect((await run(quiet.id)).status).toBe("running");
    });

    it("processes a finish nobody queued, once", async () => {
      const s = await readyShare({ allowEmptyOnce: true, credentialFailedAt: new Date() });
      const now = fixture.clock.now.getTime();
      const finished = await insertRun({
        fileShareId: s.id,
        status: "succeeded",
        startedAt: new Date(now - 10 * MINUTE),
        finishedAt: new Date(now - 3 * MINUTE),
        stats: { resticSnapshotId: "b".repeat(64), files: 7, dirs: 2, bytes: 100, dataAdded: 50 },
      });
      expect((await fileShareMonitor(fixture.deps)).processed).toBe(1);
      expect(await processFinish(fixture.deps, tenant, finished.id)).toBe(false);
      const [snap] = await fixture.owner
        .select()
        .from(fileShareSnapshots)
        .where(eq(fileShareSnapshots.fileShareId, s.id));
      expect(snap).toMatchObject({ sequence: 1, files: 7, dirs: 2, bytes: 100, bytesAdded: 50 });
      const after = await share(s.id);
      expect(after).toMatchObject({
        lastSnapshotId: snap?.id,
        allowEmptyOnce: false,
        credentialFailedAt: null,
      });
      expect((await run(finished.id)).snapshotId).toBe(snap?.id);
    });

    it("warns about a budget at 80 percent once, again when used up, and re-arms below 70", async () => {
      const s = await readyShare({ quotaGib: 1, repositoryBytes: Math.round(0.85 * GIB) });
      const raised = async () =>
        (await events("file_share.storage_quota")).filter((e) => e.details?.fileShareId === s.id);
      await fileShareMonitor(fixture.deps);
      await fileShareMonitor(fixture.deps);
      expect((await raised()).map((e) => e.details?.level)).toEqual(["near"]);
      await fixture.owner
        .update(fileShares)
        .set({ repositoryBytes: GIB })
        .where(eq(fileShares.id, s.id));
      await fileShareMonitor(fixture.deps);
      expect((await raised()).map((e) => e.details?.level).sort()).toEqual(["exceeded", "near"]);
      await fixture.owner
        .update(fileShares)
        .set({ repositoryBytes: Math.round(0.5 * GIB) })
        .where(eq(fileShares.id, s.id));
      await fileShareMonitor(fixture.deps);
      expect((await share(s.id)).quotaAlertLevel).toBeNull();
    });
  });

  describe("finish processing", () => {
    it("records a refused password, alerts once and queues the webhook", async () => {
      const s = await readyShare();
      await fixture.owner.insert(webhooks).values({
        tenantId: tenant,
        url: "https://hooks.example.test/x",
        events: ["job.failed", "job.completed"],
      });
      const queued = await insertRun({
        fileShareId: s.id,
        status: "running",
        startedAt: new Date(),
      });
      await endRun(fixture.deps, queued, {
        status: "failed",
        cause: {
          code: "share.auth_failed",
          transient: false,
          params: {},
          technical: {},
        },
      });
      expect((await share(s.id)).credentialFailedAt).not.toBeNull();
      expect(await processFinish(fixture.deps, tenant, queued.id)).toBe(false);
      const alerts = (await events("backup.failed")).filter((e) => e.details?.runId === queued.id);
      expect(alerts).toHaveLength(1);
      const deliveries = await fixture.owner.select().from(webhookDeliveries);
      const payload = deliveries.find(
        (d) => (d.payload as { data?: { job?: { id?: string } } }).data?.job?.id === queued.id,
      )?.payload as { event: string; data: Record<string, unknown> };
      expect(payload.event).toBe("job.failed");
      expect(payload.data).toMatchObject({
        job: {
          queue: "file-share-backup",
          status: "failed",
          protectedObjectId: null,
          failure: { code: "share.auth_failed" },
        },
        fileShare: { id: s.id, name: s.name, protocol: "nfs" },
      });
    });
  });

  describe("the empty-source guard on the server", () => {
    it("does not take an empty restore point after one with files as a success", async () => {
      const s = await readyShare();
      await snapshot(s.id, 1, 50);
      const now = new Date();
      const emptied = await insertRun({
        fileShareId: s.id,
        status: "succeeded",
        startedAt: now,
        finishedAt: now,
        stats: { resticSnapshotId: "c".repeat(64), files: 0 },
      });
      expect(await processFinish(fixture.deps, tenant, emptied.id)).toBe(true);
      expect((await run(emptied.id)).failure?.code).toBe("share.empty_source");
      const points = await fixture.owner
        .select()
        .from(fileShareSnapshots)
        .where(eq(fileShareSnapshots.fileShareId, s.id));
      expect(points.map((p) => p.sequence)).toEqual([1]);
      // Allowed once: recorded, and the permission is used up.
      await fixture.owner
        .update(fileShares)
        .set({ allowEmptyOnce: true })
        .where(eq(fileShares.id, s.id));
      const allowed = await insertRun({
        fileShareId: s.id,
        status: "succeeded",
        startedAt: now,
        finishedAt: now,
        stats: { resticSnapshotId: "d".repeat(64), files: 0 },
      });
      expect(await processFinish(fixture.deps, tenant, allowed.id)).toBe(true);
      expect((await run(allowed.id)).status).toBe("succeeded");
      expect((await share(s.id)).allowEmptyOnce).toBe(false);
    });
  });

  describe("overdue", () => {
    it("raises backup.overdue for a protected share once per stretch", async () => {
      const s = await readyShare({ lastSuccessAt: new Date(Date.now() - 5 * 24 * 60 * MINUTE) });
      await addShareJob(fixture, tenant, [s.id], {
        schedule: { kind: "daily", timeOfDay: "02:00", timeZone: "UTC" },
      });
      const now = new Date();
      await alertOverdueBackups(fixture.deps, now);
      await alertOverdueBackups(fixture.deps, now);
      const raised = (await events("backup.overdue")).filter(
        (e) => e.details?.fileShareId === s.id,
      );
      expect(raised).toHaveLength(1);
    });
  });

  describe.skipIf(!resticAvailable)("retention against a real repository", () => {
    it("never removes the newest restore point with files, whatever the rules say", async () => {
      const s = await addShare(fixture, tenant);
      await addShareJob(fixture, tenant, [s.id], {
        settings: { retention: { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 } },
      });
      const ready = await ensureShareRepository(fixture.deps, s);
      const access = await shareRepositoryAccess(fixture.deps, ready);
      const full = join(fixture.work, "full");
      const empty = join(fixture.work, "empty");
      await mkdir(full, { recursive: true });
      await mkdir(empty, { recursive: true });
      await writeFile(join(full, "a.txt"), "a");
      const ids = await withRepository(access, async (session) => {
        await runRestic(session, ["backup", "--host", "restow-share", full]);
        await runRestic(session, ["backup", "--host", "restow-share", empty]);
        return (await resticSnapshots(session)).map((snap) => snap.id);
      });
      // Newest first: the empty one, then the one with files.
      await fixture.owner.insert(fileShareSnapshots).values([
        {
          tenantId: tenant,
          fileShareId: s.id,
          sequence: 1,
          resticSnapshotId: ids[1] as string,
          snapshotTime: new Date(Date.now() - MINUTE),
          files: 1,
        },
        {
          tenantId: tenant,
          fileShareId: s.id,
          sequence: 2,
          resticSnapshotId: ids[0] as string,
          snapshotTime: new Date(),
          files: 0,
        },
      ]);
      fixture.clock.now = new Date(Date.now() + 2 * 60 * MINUTE);
      await shareRetention(fixture.deps, { tenantId: tenant, fileShareId: s.id });
      const after = await fixture.owner
        .select({ sequence: fileShareSnapshots.sequence, status: fileShareSnapshots.status })
        .from(fileShareSnapshots)
        .where(eq(fileShareSnapshots.fileShareId, s.id));
      expect(after.sort((a, b) => a.sequence - b.sequence)).toEqual([
        { sequence: 1, status: "active" },
        { sequence: 2, status: "active" },
      ]);
      expect(await withRepository(access, (session) => resticSnapshots(session))).toHaveLength(2);
      expect((await share(s.id)).lastRetentionAt).not.toBeNull();
    }, 120_000);
  });
});
