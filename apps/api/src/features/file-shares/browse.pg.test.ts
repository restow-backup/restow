/**
 * Reading a file share's backups with the real restic binary (docs/FILESHARES.md 9.1, 16.2):
 * the restore points with their restore-check rating, one folder of one (the share root shown as
 * `/`, the runner's `/.restow` folder hidden), the catalog's search and version history, and the
 * ZIP download (checked first, started once by the admin who prepared it, without `/.restow`).
 * Every read is audited. And the read fallback of 0.5.0 (docs/STORAGE.md, "restic repositories
 * on copies"): once the primary lost the repository, the restore point is browsed and downloaded
 * from the repository copy on a copy target, whose snapshots have ids of their own.
 *
 * Needs Postgres (RESTOW_TEST_DATABASE_URL) and restic (RESTIC_BINARY, else the PATH).
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { serve } from "@hono/node-server";
import {
  fileShareRepositoryKey,
  fileShareRepositoryPrefix,
  hashSecret,
  LocalStorageBackend,
  type RepositoryAccess,
  resticBinary,
  resticCacheBase,
  resticCopy,
  resticInit,
  resticInitCopy,
  resticSnapshots,
  runRestic,
  type StorageBackend,
  withRepository,
  withRepositoryPair,
} from "@restow/core";
import {
  auditLog,
  fileShareCatalog,
  fileShareReports,
  fileShareRuns,
  fileShareSnapshots,
  fileShares,
  repositoryCopies,
  storageTargets,
} from "@restow/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readZip } from "../../../../../packages/core/src/restore/testing/zip-reader.js";
import {
  type EndpointFixture,
  resticAvailable,
  startFixture,
  testDatabaseAdminUrl,
} from "../endpoints/testing/fixture.js";

const DATABASE = "restow_api_file_shares_browse_test";
const canRun = Boolean(testDatabaseAdminUrl) && resticAvailable();

type Browse = typeof import("./browse.js");
type Shared = typeof import("../../db.js");

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from(stream)) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

describe.skipIf(!canRun)("reading file share backups with restic", () => {
  let fixture: EndpointFixture;
  let browse: Browse;
  let shared: Shared;
  let work: string;
  let shareId: string;
  let snapshotId: string;
  /** The restore point's restic snapshot id in the primary's repository. */
  let primaryResticId: string;
  const password = "browse-repository-password";
  const actor = () => ({
    label: "admin@contoso.example",
    userId: fixture.adminId,
    ip: "192.0.2.1",
  });

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    shared = await import("../../db.js");
    browse = await import("./browse.js");
    const secrets = await import("../../lib/secrets.js");
    const { tenantStorage } = await import("../endpoints/repository.js");
    work = await mkdtemp(join(tmpdir(), "restow-share-browse-"));
    const root = join(work, "share");
    browse.setShareSnapshotRoot(root);
    await mkdir(join(root, "Finance", "2026"), { recursive: true });
    await writeFile(join(root, "Finance", "2026", "Q3.xlsx"), "quarter three");
    await writeFile(join(root, "Finance", "budget.txt"), "budget");
    await writeFile(join(root, "readme.txt"), "hello");
    await mkdir(join(work, ".restow"), { recursive: true });
    await writeFile(join(work, ".restow", "manifest.json"), "{}");

    const ref = await secrets.storeSecret(shared.db, {
      tenantId: fixture.tenantId,
      kind: "file_share_repository",
      plaintext: password,
    });
    const [share] = await fixture.db
      .insert(fileShares)
      .values({
        tenantId: fixture.tenantId,
        name: "Data",
        protocol: "smb",
        server: "files.example.test",
        shareName: "data",
        repositorySecretId: ref.id,
        repositoryReadyAt: new Date(),
        lastCatalogAt: new Date(),
      })
      .returning();
    shareId = share?.id as string;
    const { storage } = await tenantStorage(shared.db, fixture.tenantId);
    const resticId = await withRepository(
      {
        storage,
        prefix: fileShareRepositoryPrefix(shareId),
        repositoryPassword: password,
        repositoryKey: fileShareRepositoryKey(shareId),
        binary: resticBinary(),
        cacheBase: resticCacheBase(),
      },
      async (session) => {
        await resticInit(session);
        await runRestic(session, ["backup", "--host", "restow-share", root, join(work, ".restow")]);
        return (await resticSnapshots(session))[0]?.id as string;
      },
    );
    primaryResticId = resticId;
    const [snapshot] = await fixture.db
      .insert(fileShareSnapshots)
      .values({
        tenantId: fixture.tenantId,
        fileShareId: shareId,
        sequence: 1,
        resticSnapshotId: resticId,
        snapshotTime: new Date(),
        files: 3,
        permissions: {
          mode: "auto",
          xattr: "system.cifs_ntsd",
          entries: 6,
          descriptors: 2,
          errors: 0,
        },
      })
      .returning();
    snapshotId = snapshot?.id as string;
    await fixture.db.insert(fileShareReports).values({
      tenantId: fixture.tenantId,
      fileShareId: shareId,
      kind: "restore_test",
      readiness: "green",
      snapshotId: resticId,
    });
    await fixture.db.insert(fileShareCatalog).values([
      {
        tenantId: fixture.tenantId,
        fileShareId: shareId,
        path: "Finance/2026/Q3.xlsx",
        name: "Q3.xlsx",
        size: 13,
        firstSeq: 1,
      },
      {
        tenantId: fixture.tenantId,
        fileShareId: shareId,
        path: "Finance/2026/Q3.xlsx",
        name: "Q3.xlsx",
        size: 9,
        firstSeq: 0,
        endSeq: 1,
      },
      {
        tenantId: fixture.tenantId,
        fileShareId: shareId,
        path: "readme.txt",
        name: "readme.txt",
        size: 5,
        firstSeq: 1,
      },
    ]);
  }, 180_000);

  afterAll(async () => {
    browse?.setShareSnapshotRoot(null);
    await fixture?.cleanup();
    if (work) await rm(work, { recursive: true, force: true });
  });

  it("lists the restore points with their restore-check rating", async () => {
    const { items } = await browse.listSnapshots(shared.db, fixture.tenantId, shareId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: snapshotId,
      sequence: 1,
      files: 3,
      verification: { state: "green", reason: null },
      permissions: { xattr: "system.cifs_ntsd" },
    });
  });

  it("shows the share root as / and hides the runner's folder", async () => {
    const root = await browse.browseSnapshot(
      shared.db,
      fixture.tenantId,
      shareId,
      { snapshot: snapshotId, path: "/", limit: 100 },
      actor(),
    );
    expect(root.entries.map((entry) => [entry.path, entry.type])).toEqual([
      ["/Finance", "dir"],
      ["/readme.txt", "file"],
    ]);
    expect(root.permissions?.entries).toBe(6);
    const finance = await browse.browseSnapshot(
      shared.db,
      fixture.tenantId,
      shareId,
      { snapshot: snapshotId, path: "/Finance", limit: 1 },
      actor(),
    );
    expect(finance.entries.map((entry) => entry.path)).toEqual(["/Finance/2026"]);
    expect(finance.nextCursor).not.toBeNull();
    const next = await browse.browseSnapshot(
      shared.db,
      fixture.tenantId,
      shareId,
      { snapshot: snapshotId, path: "/Finance", limit: 10, cursor: finance.nextCursor as string },
      actor(),
    );
    expect(next.entries.map((entry) => entry.path)).toEqual(["/Finance/budget.txt"]);
    const audit = await fixture.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "file_share.browsed"));
    expect(audit.length).toBeGreaterThanOrEqual(3);
  });

  it("downloads files and a folder as one ZIP, once, without the runner's folder", async () => {
    const prepared = await browse.prepareDownload(
      shared.db,
      fixture.tenantId,
      shareId,
      { snapshotId, paths: ["/Finance", "/readme.txt"] },
      actor(),
    );
    expect(prepared.items).toBe(2);
    const download = await browse.openDownload(
      shared.db,
      fixture.tenantId,
      shareId,
      prepared.id,
      actor(),
    );
    const entries = readZip(await readAll(download.stream));
    const files = Object.fromEntries(
      entries
        .filter((entry) => !entry.isDirectory)
        .map((entry) => [entry.name, entry.data.toString()]),
    );
    expect(files).toEqual({
      "Finance/2026/Q3.xlsx": "quarter three",
      "Finance/budget.txt": "budget",
      "readme.txt": "hello",
    });
    expect(download.fileName.startsWith("Data-")).toBe(true);
    await expect(
      browse.openDownload(shared.db, fixture.tenantId, shareId, prepared.id, actor()),
    ).rejects.toMatchObject({ status: 404, type: "urn:restow:problem:file-share-download-gone" });
    await expect(
      browse.prepareDownload(
        shared.db,
        fixture.tenantId,
        shareId,
        { snapshotId, paths: ["/missing.txt"] },
        actor(),
      ),
    ).rejects.toMatchObject({ status: 404, type: "urn:restow:problem:file-share-path-not-found" });
  });

  it("searches the catalog and shows the versions of a file", async () => {
    const found = await browse.searchCatalog(
      shared.db,
      fixture.tenantId,
      shareId,
      { q: "q3.", limit: 20 },
      actor(),
    );
    expect(found.items).toEqual([
      expect.objectContaining({
        path: "/Finance/2026/Q3.xlsx",
        size: 13,
        current: true,
        snapshotId,
      }),
    ]);
    const versions = await browse.fileVersions(
      shared.db,
      fixture.tenantId,
      shareId,
      "/Finance/2026/Q3.xlsx",
    );
    expect(versions.items.map((item) => [item.size, item.current, item.snapshotId])).toEqual([
      [13, true, snapshotId],
      [9, false, null],
    ]);
    await expect(
      browse.searchCatalog(
        shared.db,
        fixture.otherTenantId,
        shareId,
        { q: "q3", limit: 20 },
        actor(),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("reads the restore point from the repository copy on a copy target once the primary lost the repository", async () => {
    const { forgetTenantStorage } = await import("../endpoints/repository.js");
    const copyDir = join(work, "copy-target");
    const [target] = await fixture.db
      .insert(storageTargets)
      .values({
        tenantId: fixture.tenantId,
        name: "Offsite",
        kind: "local",
        role: "copy",
        config: { basePath: copyDir },
      })
      .returning();
    const prefix = fileShareRepositoryPrefix(shareId);
    const access = (storage: StorageBackend, key: string): RepositoryAccess => ({
      storage,
      prefix,
      repositoryPassword: password,
      repositoryKey: key,
      binary: resticBinary(),
      cacheBase: resticCacheBase(),
    });
    // What the worker's copy pass does: the same prefix and password, `restic copy`.
    await withRepositoryPair(
      access(new LocalStorageBackend(fixture.storageDir), fileShareRepositoryKey(shareId)),
      access(new LocalStorageBackend(copyDir), `${fileShareRepositoryKey(shareId)}.copy`),
      async (session) => {
        await resticInitCopy(session);
        await resticCopy(session, [primaryResticId]);
      },
    );
    const onCopy = await withRepository(
      access(new LocalStorageBackend(copyDir), `${fileShareRepositoryKey(shareId)}.copy`),
      (session) => resticSnapshots(session, { noLock: true }),
    );
    // The copy holds the restore point under another id; the database records the primary's.
    expect(onCopy).toHaveLength(1);
    expect(onCopy[0]?.id).not.toBe(primaryResticId);
    expect(onCopy[0]?.original).toBe(primaryResticId);

    // The primary loses the repository.
    await rename(join(fixture.storageDir, "file-shares", shareId), join(work, "lost-repository"));
    forgetTenantStorage(fixture.tenantId);
    try {
      const root = await browse.browseSnapshot(
        shared.db,
        fixture.tenantId,
        shareId,
        { snapshot: snapshotId, path: "/", limit: 100 },
        actor(),
      );
      expect(root.entries.map((entry) => [entry.path, entry.type])).toEqual([
        ["/Finance", "dir"],
        ["/readme.txt", "file"],
      ]);
      const prepared = await browse.prepareDownload(
        shared.db,
        fixture.tenantId,
        shareId,
        { snapshotId, paths: ["/Finance/budget.txt", "/readme.txt"] },
        actor(),
      );
      const download = await browse.openDownload(
        shared.db,
        fixture.tenantId,
        shareId,
        prepared.id,
        actor(),
      );
      const files = Object.fromEntries(
        readZip(await readAll(download.stream))
          .filter((entry) => !entry.isDirectory)
          .map((entry) => [entry.name, entry.data.toString()]),
      );
      expect(files).toEqual({ "budget.txt": "budget", "readme.txt": "hello" });

      // A full restore back into the share (docs/STORAGE.md, "Restoring from a copy"), as the
      // runner does it: the dispatcher pinned the run to the target that holds the repository,
      // the runner asks for its session and runs restic with what it was told.
      const { fileShareRunnerRoutes } = await import("./runner-routes.js");
      const { FILE_SHARE_RESTIC_PATH, fileShareResticRoutes } = await import("./restic-route.js");
      const { FILE_SHARE_RUNNER_PATH } = await import("./constants.js");
      const { errorHandler } = await import("../../problem.js");
      const app = new Hono();
      app.onError(errorHandler);
      app.route(FILE_SHARE_RESTIC_PATH, fileShareResticRoutes);
      app.route(FILE_SHARE_RUNNER_PATH, fileShareRunnerRoutes);
      const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      const port = (server.address() as AddressInfo).port;
      try {
        const token = "runner-token-of-the-restore";
        const [run] = await fixture.db
          .insert(fileShareRuns)
          .values({
            tenantId: fixture.tenantId,
            fileShareId: shareId,
            lockShareId: shareId,
            kind: "restore",
            status: "starting",
            startedAt: new Date(),
            tokenHash: hashSecret(token),
            tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
            sourceSnapshotId: snapshotId,
            storageTarget: target?.id as string,
            params: { paths: ["/"], destination: "new_folder", folder: "restored" },
          })
          .returning();
        const runId = run?.id as string;
        const authorization = `Basic ${Buffer.from(`${runId}:${token}`).toString("base64")}`;
        const runner = (method: string, path: string, body?: unknown) =>
          fetch(`http://127.0.0.1:${port}${FILE_SHARE_RUNNER_PATH}${path}`, {
            method,
            headers: {
              authorization,
              ...(body !== undefined ? { "content-type": "application/json" } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
          });
        const sessionResponse = await runner("GET", "/session");
        expect(sessionResponse.status).toBe(200);
        const session = (await sessionResponse.json()) as {
          repository: { repositoryPassword: string };
          restore: { snapshotId: string };
        };
        // The id under which the copy holds the restore point, not the one the database records.
        expect(session.restore.snapshotId).toBe(onCopy[0]?.id);

        const restoreDir = join(work, "restored-from-copy");
        const restored = await new Promise<{ code: number | null; out: string }>(
          (resolve, reject) => {
            const child = spawn(
              resticBinary(),
              [
                "restore",
                `${session.restore.snapshotId}:${join(work, "share")}`,
                "--target",
                restoreDir,
                "--no-lock",
                "--overwrite",
                "never",
              ],
              {
                env: {
                  PATH: process.env.PATH ?? "",
                  HOME: work,
                  RESTIC_REPOSITORY: `rest:http://127.0.0.1:${port}${FILE_SHARE_RESTIC_PATH}/${shareId}/`,
                  RESTIC_REST_USERNAME: runId,
                  RESTIC_REST_PASSWORD: token,
                  RESTIC_PASSWORD: session.repository.repositoryPassword,
                  RESTIC_CACHE_DIR: join(work, "runner-cache"),
                },
              },
            );
            let out = "";
            child.stdout.on("data", (chunk) => {
              out += chunk;
            });
            child.stderr.on("data", (chunk) => {
              out += chunk;
            });
            child.once("error", reject);
            child.once("close", (code) => resolve({ code, out }));
          },
        );
        expect(restored.code, restored.out).toBe(0);
        for (const [file, content] of [
          [join("Finance", "2026", "Q3.xlsx"), "quarter three"],
          [join("Finance", "budget.txt"), "budget"],
          ["readme.txt", "hello"],
        ] as const) {
          expect(await readFile(join(restoreDir, file), "utf8"), file).toBe(content);
        }

        const finish = await runner("POST", "/finish", {
          status: "succeeded",
          stats: { files: 3 },
          restore: { restored: 3 },
          logTail: "ok",
        });
        expect(finish.status, await finish.text()).toBeLessThan(300);
        // The run and the audit log say that the restore read the copy, and which.
        const [ended] = await fixture.db
          .select()
          .from(fileShareRuns)
          .where(eq(fileShareRuns.id, runId));
        expect(ended).toMatchObject({ kind: "restore", status: "succeeded" });
        expect(ended?.stats.readFrom).toMatchObject({
          targetId: target?.id,
          targetName: "Offsite",
          role: "copy",
        });
        const audited = await fixture.db
          .select()
          .from(auditLog)
          .where(eq(auditLog.action, "file_share.restore_read_from_copy"));
        expect(audited).toHaveLength(1);
        expect(audited[0]?.details).toMatchObject({ runId, targetName: "Offsite", role: "copy" });
        expect(audited[0]?.target).toBe(shareId);
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          (server as { closeAllConnections?: () => void }).closeAllConnections?.();
        });
      }
    } finally {
      await rename(join(work, "lost-repository"), join(fixture.storageDir, "file-shares", shareId));
      forgetTenantStorage(fixture.tenantId);
    }

    // The status the storage page and the share's page show (GET /storage/repository-copies).
    const { objectCopyStatus, repositoryCopyStatus } = await import(
      "../storage/repository-copies.js"
    );
    const copiedAt = new Date("2026-11-07T10:00:00.000Z");
    await fixture.db.insert(repositoryCopies).values([
      {
        tenantId: fixture.tenantId,
        prefix,
        kind: "file_share",
        ownerId: shareId,
        targetId: target?.id as string,
        state: "behind",
        primarySnapshots: 3,
        missingSnapshots: 2,
        lastSnapshotId: primaryResticId,
        lastCopiedAt: copiedAt,
        lastAttemptAt: copiedAt,
        lastCheckAt: copiedAt,
        lastCheckOk: true,
        troubleSince: copiedAt,
      },
      // A row of a target that is no copy target any more waits for the worker: not shown.
      {
        tenantId: fixture.tenantId,
        prefix,
        kind: "file_share",
        ownerId: shareId,
        targetId: "00000000-0000-4000-8000-000000000009",
        state: "current",
      },
    ]);
    const forShare = await objectCopyStatus(shared.db, fixture.tenantId, shareId);
    expect(forShare.copies).toEqual([
      expect.objectContaining({
        targetId: target?.id,
        targetName: "Offsite",
        kind: "file_share",
        state: "behind",
        primarySnapshots: 3,
        missingSnapshots: 2,
        lastSnapshotId: primaryResticId.slice(0, 8),
        lastCopiedAt: copiedAt.toISOString(),
        lastCheckOk: true,
        troubleSince: copiedAt.toISOString(),
      }),
    ]);
    const all = await repositoryCopyStatus(shared.db, fixture.tenantId);
    expect(all.targets).toEqual([
      {
        targetId: target?.id,
        targetName: "Offsite",
        total: 1,
        current: 0,
        behind: 1,
        failed: 0,
        pending: 0,
      },
    ]);
    expect(all.repositories).toHaveLength(1);
    // Another tenant sees none of it.
    expect(await objectCopyStatus(shared.db, fixture.otherTenantId, shareId)).toEqual({
      copies: [],
    });
    expect(await repositoryCopyStatus(shared.db, fixture.otherTenantId)).toEqual({
      targets: [],
      repositories: [],
    });
  }, 180_000);
});
