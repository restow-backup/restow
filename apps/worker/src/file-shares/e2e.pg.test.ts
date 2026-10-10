/**
 * File share backup end to end (docs/FILESHARES.md 16.2, the exit of Phase B): the dispatcher
 * starts a run through a stand-in mounter that runs the real restow-share (a test build that
 * takes a plain folder for the mounted share, agent/cmd/restow-share/testmount.go), which talks
 * to the api's real runner routes and restic route in a child process, and backs up with the real
 * restic. Then the worker records the restore point, checks it, catalogues it, applies retention,
 * and a restore run writes it back into a new folder of the share, compared byte for byte.
 *
 * Needs Postgres (RESTOW_TEST_DATABASE_URL, a superuser), restic (RESTIC_BINARY, else the PATH)
 * and a Go toolchain (to build the test binary); skipped otherwise.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FILE_SHARE_PASSWORD_KIND,
  type RunnerRunRequest,
  repositoryPasswordKey,
  resticBinary,
} from "@restow/core";
import {
  type FileShare,
  fileShareCatalog,
  fileShareReports,
  fileShareRunItems,
  fileShareRuns,
  fileShareSamples,
  fileShareSnapshots,
  fileShares,
  notifications,
  runSamples,
} from "@restow/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shareCatalog } from "./catalog.js";
import { dispatchPass } from "./dispatch.js";
import { processFinish } from "./finish.js";
import { shareRetention, shareVerify } from "./maintenance.js";
import { queueShareBackup } from "./queue.js";
import {
  type ShareFixture,
  addShare,
  addShareJob,
  adminUrl,
  roleUrl,
  startShareFixture,
} from "./testing/fixture.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function available(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0;
}

const canRun =
  Boolean(adminUrl) && available(resticBinary(), ["version"]) && available("go", ["version"]);

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** Every regular file under `root` as `relative path -> sha256`, without the skipped folders. */
async function treeHashes(root: string, skip: (rel: string) => boolean = () => false) {
  const result: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      if (skip(rel)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        result[rel] = sha256(await readFile(full));
      }
    }
  }
  await walk(root);
  return result;
}

describe.skipIf(!canRun)("file share backup end to end with restow-share and restic", () => {
  let fixture: ShareFixture;
  let api: ChildProcess;
  let apiUrl = "";
  let binary = "";
  let shareDir = "";
  let share: FileShare;
  let jobId = "";
  const exits = new Map<string, Promise<{ code: number | null; stderr: string }>>();

  /** The stand-in mounter: run restow-share for the run, on the share's folder. */
  function runRunner(request: RunnerRunRequest): void {
    const cacheDir = join(fixture.work, `cache-${request.limits.cacheKey}`);
    const metaDir = join(fixture.work, `meta-${request.runId}`);
    const resticDir = dirname(resticBinary());
    const child = spawn(binary, ["run"], {
      env: {
        PATH: `${resticDir}:${process.env.PATH ?? ""}`,
        HOME: fixture.work,
        RESTOW_SHARE_API_URL: apiUrl,
        RESTOW_SHARE_RUN_ID: request.runId,
        RESTOW_SHARE_RUN_TOKEN: request.token,
        RESTOW_SHARE_EXPECT: request.mounts[0]?.share.protocol ?? "nfs",
        RESTOW_SHARE_TEST_ROOT: shareDir,
        RESTOW_SHARE_TEST_META: metaDir,
        RESTOW_SHARE_TEST_CACHE: cacheDir,
        RESTOW_SHARE_TEST_RW: request.kind === "restore" ? "1" : "0",
        GOMEMLIMIT: `${request.limits.goMemLimitMiB}MiB`,
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.resume();
    exits.set(
      request.runId,
      new Promise((done) => {
        child.on("close", (code) => {
          fixture.runner.exit(request.runId, code ?? 1, new Date(), stderr.slice(-4000));
          done({ code, stderr });
        });
      }),
    );
  }

  async function runFinished(runId: string): Promise<void> {
    const exit = await exits.get(runId);
    if (exit?.code !== 0) {
      throw new Error(`restow-share exited with ${exit?.code}:\n${exit?.stderr}`);
    }
  }

  /** Queue, dispatch and run one backup; returns the run id. */
  async function backup(): Promise<string> {
    expect(
      await queueShareBackup(fixture.deps, {
        tenantId: fixture.contoso,
        fileShareId: share.id,
        backupJobId: jobId,
        trigger: "schedule",
      }),
    ).toBe("queued");
    const summary = await dispatchPass(fixture.deps);
    expect(summary.started).toBe(1);
    const request = fixture.runner.started.at(-1) as RunnerRunRequest;
    await runFinished(request.runId);
    expect(await processFinish(fixture.deps, fixture.contoso, request.runId)).toBe(true);
    return request.runId;
  }

  beforeAll(async () => {
    fixture = await startShareFixture("restow_worker_file_shares_e2e_test");
    binary = join(fixture.work, "restow-share-test");
    const build = spawnSync(
      "go",
      ["build", "-tags", "sharetest", "-o", binary, "./cmd/restow-share"],
      {
        cwd: join(repoRoot, "agent"),
        encoding: "utf8",
      },
    );
    if (build.status !== 0) {
      throw new Error(`go build failed: ${build.stderr}`);
    }
    shareDir = join(fixture.work, "share");
    await mkdir(join(shareDir, "Finance", "2026"), { recursive: true });
    await mkdir(join(shareDir, "HR"), { recursive: true });
    await writeFile(join(shareDir, "Finance", "2026", "Q3.xlsx"), "quarter three\n".repeat(500));
    await writeFile(join(shareDir, "Finance", "budget.txt"), "budget v1\n");
    await writeFile(join(shareDir, "HR", "contracts.pdf"), Buffer.alloc(200_000, 7));
    await writeFile(join(shareDir, "readme.txt"), "read me\n");
    await writeFile(join(shareDir, "Thumbs.db"), "excluded by the preset\n");
    // Old enough to be a restore check sample (the runner picks files older than an hour).
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const { utimes } = await import("node:fs/promises");
    for (const rel of [
      "Finance/2026/Q3.xlsx",
      "HR/contracts.pdf",
      "readme.txt",
      "Finance/budget.txt",
    ]) {
      await utimes(join(shareDir, rel), old, old);
    }

    api = spawn(
      join(repoRoot, "apps", "api", "node_modules", ".bin", "tsx"),
      ["src/features/file-shares/testing/runner-server.ts"],
      {
        cwd: join(repoRoot, "apps", "api"),
        env: {
          PATH: process.env.PATH ?? "",
          HOME: fixture.work,
          DATABASE_URL: roleUrl(fixture, fixture.roles.tenant),
          DATABASE_PROVIDER_URL: roleUrl(fixture, fixture.roles.installation),
          RESTOW_MASTER_KEY: fixture.masterKey,
          BETTER_AUTH_SECRET: "e2e-better-auth-secret-0123456789",
          RESTOW_PUBLIC_URL: "https://restow.test.example",
          STORAGE_TARGET: "local",
          STORAGE_LOCAL_PATH: fixture.storageDir,
          RESTOW_RESTIC_CACHE_DIR: join(fixture.work, "api-cache"),
        },
      },
    );
    let apiOutput = "";
    api.stderr?.on("data", (chunk) => {
      apiOutput += chunk;
    });
    apiUrl = await new Promise<string>((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error(`the api did not start:\n${apiOutput}`)),
        60_000,
      );
      api.stdout?.on("data", (chunk: Buffer) => {
        const match = /"listening":(\d+)/.exec(chunk.toString());
        if (match) {
          clearTimeout(timer);
          done(`http://127.0.0.1:${match[1]}`);
        }
      });
      api.on("exit", (code) => fail(new Error(`the api exited (${code}):\n${apiOutput}`)));
      api.on("error", (error) => fail(error));
    });

    share = await addShare(fixture, fixture.contoso, { name: "Data" });
    jobId = await addShareJob(fixture, fixture.contoso, [share.id], {
      settings: { retention: { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 } },
    });
    fixture.runner.onStart = (request) => runRunner(request);
    (fixture.deps as { snapshotRoot?: string }).snapshotRoot = shareDir;
  }, 240_000);

  afterAll(async () => {
    api?.kill("SIGTERM");
    await fixture?.cleanup();
  });

  let firstRun = "";
  let secondRun = "";

  it("backs up a share: the runner reports through the api, the worker records the restore point", async () => {
    firstRun = await backup();
    const [run] = await fixture.owner
      .select()
      .from(fileShareRuns)
      .where(eq(fileShareRuns.id, firstRun));
    expect(run?.status).toBe("succeeded");
    expect(run?.tokenExpiresAt).not.toBeNull();
    expect(run?.finishProcessedAt).not.toBeNull();
    expect(run?.stats.resticSnapshotId).toMatch(/^[0-9a-f]{64}$/);
    const snapshots = await fixture.owner
      .select()
      .from(fileShareSnapshots)
      .where(eq(fileShareSnapshots.fileShareId, share.id));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      sequence: 1,
      files: 4,
      status: "active",
      runId: firstRun,
    });
    const [stored] = await fixture.owner
      .select()
      .from(fileShares)
      .where(eq(fileShares.id, share.id));
    expect(stored?.lastSnapshotId).toBe(snapshots[0]?.id);
    expect(stored?.repositoryReadyAt).not.toBeNull();
    expect(stored?.lastSuccessAt).not.toBeNull();
    // Uploads were counted into the share's size.
    expect(stored?.repositoryBytes ?? 0).toBeGreaterThan(0);
    // The runner hashed its samples and reported progress.
    const samples = await fixture.owner
      .select()
      .from(fileShareSamples)
      .where(eq(fileShareSamples.runId, firstRun));
    expect(samples.length).toBeGreaterThanOrEqual(3);
    const points = await fixture.owner
      .select()
      .from(runSamples)
      .where(eq(runSamples.fileShareRunId, firstRun));
    expect(points).toHaveLength(1);
    // The sealed repository password lies next to the repository.
    expect(
      await readFile(
        join(fixture.storageDir, repositoryPasswordKey(FILE_SHARE_PASSWORD_KIND, share.id)),
        "utf8",
      ),
    ).toContain("restow-file-share-repository-password-v1");
    // The credential died with the run.
    const request = fixture.runner.started[0] as RunnerRunRequest;
    const session = await fetch(`${apiUrl}/internal/file-shares/v1/session`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${request.runId}:${request.token}`).toString("base64")}`,
      },
    });
    expect(session.status).toBe(401);
    // Through a proxy the internal routes do not exist.
    const proxied = await fetch(`${apiUrl}/internal/file-shares/v1/session`, {
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    expect(proxied.status).toBe(404);
  }, 180_000);

  it("backs up the changes, checks the newest restore point, catalogues both and applies retention", async () => {
    await writeFile(join(shareDir, "Finance", "budget.txt"), "budget v2, changed\n");
    await rm(join(shareDir, "readme.txt"));
    await writeFile(join(shareDir, "HR", "new-hire.txt"), "welcome\n");
    secondRun = await backup();
    const snapshots = await fixture.owner
      .select()
      .from(fileShareSnapshots)
      .where(eq(fileShareSnapshots.fileShareId, share.id))
      .orderBy(asc(fileShareSnapshots.sequence));
    expect(snapshots.map((snap) => snap.sequence)).toEqual([1, 2]);
    const [newest] = snapshots.slice(-1);

    await shareVerify(fixture.deps, { tenantId: fixture.contoso, fileShareId: share.id });
    const reports = await fixture.owner
      .select()
      .from(fileShareReports)
      .where(
        and(eq(fileShareReports.fileShareId, share.id), eq(fileShareReports.kind, "restore_test")),
      );
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ readiness: "green", snapshotId: newest?.resticSnapshotId });

    const catalog = await shareCatalog(fixture.deps, {
      tenantId: fixture.contoso,
      fileShareId: share.id,
    });
    expect(catalog.snapshots).toBe(2);
    const versions = await fixture.owner
      .select()
      .from(fileShareCatalog)
      .where(eq(fileShareCatalog.fileShareId, share.id));
    const of = (path: string) =>
      versions
        .filter((v) => v.path === path)
        .map((v) => [v.firstSeq, v.endSeq])
        .sort();
    expect(of("Finance/2026/Q3.xlsx")).toEqual([[1, null]]);
    expect(of("Finance/budget.txt")).toEqual([
      [1, 2],
      [2, null],
    ]);
    expect(of("readme.txt")).toEqual([[1, 2]]);
    expect(of("HR/new-hire.txt")).toEqual([[2, null]]);
    // The preset kept Thumbs.db out of the backup; the runner's folder is never catalogued.
    expect(of("Thumbs.db")).toEqual([]);
    expect(versions.some((v) => v.path.includes("acls.jsonl"))).toBe(false);

    await shareRetention(fixture.deps, { tenantId: fixture.contoso, fileShareId: share.id });
    const after = await fixture.owner
      .select()
      .from(fileShareSnapshots)
      .where(eq(fileShareSnapshots.fileShareId, share.id))
      .orderBy(asc(fileShareSnapshots.sequence));
    expect(after.map((snap) => [snap.sequence, snap.status])).toEqual([
      [1, "pruned"],
      [2, "active"],
    ]);
    const remaining = await fixture.owner
      .select()
      .from(fileShareCatalog)
      .where(eq(fileShareCatalog.fileShareId, share.id));
    // Only versions an active restore point still holds are left.
    expect(remaining.every((v) => v.endSeq === null)).toBe(true);
    expect(remaining.map((v) => v.path).sort()).toEqual([
      "Finance/2026/Q3.xlsx",
      "Finance/budget.txt",
      "HR/contracts.pdf",
      "HR/new-hire.txt",
    ]);
    const [retention] = await fixture.owner
      .select()
      .from(fileShareReports)
      .where(
        and(eq(fileShareReports.fileShareId, share.id), eq(fileShareReports.kind, "retention")),
      );
    expect(retention?.summary).toMatchObject({ removedSnapshots: 1, unrecordedSnapshots: 0 });
  }, 240_000);

  it("restores the newest restore point into a new folder, byte for byte", async () => {
    const expected = await treeHashes(shareDir, (rel) => rel === "Thumbs.db");
    await fixture.owner
      .update(fileShares)
      .set({ allowRestore: true })
      .where(eq(fileShares.id, share.id));
    const [newest] = await fixture.owner
      .select()
      .from(fileShareSnapshots)
      .where(
        and(eq(fileShareSnapshots.fileShareId, share.id), eq(fileShareSnapshots.status, "active")),
      )
      .orderBy(desc(fileShareSnapshots.sequence))
      .limit(1);
    const [restore] = await fixture.owner
      .insert(fileShareRuns)
      .values({
        tenantId: fixture.contoso,
        fileShareId: share.id,
        lockShareId: share.id,
        targetShareId: share.id,
        sourceSnapshotId: newest?.id,
        kind: "restore",
        trigger: "manual",
        status: "queued",
        params: { destination: "new_folder", restorePermissions: false },
      })
      .returning();
    const summary = await dispatchPass(fixture.deps);
    expect(summary.started).toBe(1);
    await runFinished(restore?.id as string);
    expect(await processFinish(fixture.deps, fixture.contoso, restore?.id as string)).toBe(true);
    const [done] = await fixture.owner
      .select()
      .from(fileShareRuns)
      .where(eq(fileShareRuns.id, restore?.id as string));
    expect(done?.status).toBe("succeeded");
    const folder = (done?.stats.restore as { folder?: string } | undefined)?.folder ?? "";
    expect(folder).toMatch(/^Restow-Restore-\d{8}-\d{6}$/);
    expect(await treeHashes(join(shareDir, folder))).toEqual(expected);
    const items = await fixture.owner
      .select()
      .from(fileShareRunItems)
      .where(eq(fileShareRunItems.runId, restore?.id as string));
    expect(items).toEqual([]);
    const events = await fixture.owner
      .select({ event: notifications.event })
      .from(notifications)
      .where(eq(notifications.tenantId, fixture.contoso));
    expect(events.map((row) => row.event)).toContain("restore.completed");
    expect(events.map((row) => row.event)).not.toContain("backup.failed");
  }, 180_000);
});
