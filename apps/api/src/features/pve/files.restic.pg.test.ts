import { spawn } from "node:child_process";
/**
 * File restore of Proxmox VE containers (#62) end to end with the real restic
 * binary: a container is backed up the way restow-pve does it (a run, its
 * restic credential, `restic backup .` and the mount points from the folder
 * vzdump mounted the container in, then the commit), and the file restore
 * reads it back on the server with the guest's repository password:
 *
 *   - the restore point holds the container's paths (/etc, /opt/...), not the
 *     temporary folder of the backup; the guest page names what it contains,
 *   - browsing a folder page by page, audited,
 *   - a ZIP of a folder and a file whose entries match the source, audited
 *     before the first byte, single use, only for the admin who prepared it,
 *   - a path that is not in the restore point, a VM restore point, another
 *     tenant's restore point (Row Level Security): refused,
 *   - while the worker holds the repository (retention, check), reads wait and
 *     then answer "busy", and a read holds the repository against them.
 *
 * Needs Postgres (RESTOW_TEST_DATABASE_URL, a superuser) and restic
 * (RESTIC_BINARY, else the PATH).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { serve } from "@hono/node-server";
import { resticBinary } from "@restow/core";
import {
  acquireEndpointRepositoryLock,
  auditLog,
  pveClusters,
  pveGuestRepositoryLockKey,
  pveGuests,
  pveSnapshots,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readZip } from "../../../../../packages/core/src/restore/testing/zip-reader.js";
import {
  basic,
  type EndpointFixture,
  resticAvailable,
  startFixture,
  testDatabaseAdminUrl,
} from "../endpoints/testing/fixture.js";

const DATABASE = "restow_api_pve_files_test";
const canRun = Boolean(testDatabaseAdminUrl) && resticAvailable();
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

type Shared = typeof import("../../db.js");
type Files = typeof import("./files.js");
type Service = typeof import("./service.js");

interface Node {
  nodeId: string;
  nodeSecret: string;
  clusterId: string;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from(stream)) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

describe.skipIf(!canRun)("file restore of a container restore point (#62)", () => {
  let fixture: EndpointFixture;
  let shared: Shared;
  let files: Files;
  let service: Service;
  let server: ReturnType<typeof serve>;
  let port = 0;
  let work: string;
  let backupDir: string;
  let node: Node;
  let guestId: string;
  let pointId: string;
  const actor = () => ({
    label: "admin@contoso.example",
    userId: fixture.adminId,
    ip: "192.0.2.1",
  });

  const call = (path: string, json?: unknown) =>
    fetch(`http://127.0.0.1:${port}/agent/pve/v1${path}`, {
      method: json === undefined ? "GET" : "POST",
      headers: {
        ...basic(node.nodeId, node.nodeSecret),
        ...(json === undefined ? {} : { "content-type": "application/json" }),
      },
      body: json === undefined ? undefined : JSON.stringify(json),
    });

  async function ok<T>(response: Response, status = 200): Promise<T> {
    const text = await response.text();
    expect(response.status, text).toBe(status);
    return (text ? JSON.parse(text) : null) as T;
  }

  /** restic as the node runs it: in the backup folder, with the run's credential. */
  function restic(
    args: string[],
    cwd: string,
    env: Record<string, string>,
  ): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(resticBinary(), args, {
        cwd,
        env: { PATH: process.env.PATH ?? "", HOME: work, ...env },
      });
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr.on("data", (chunk) => {
        out += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, out }));
    });
  }

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    shared = await import("../../db.js");
    files = await import("./files.js");
    service = await import("./service.js");
    const { pveNodeRoutes } = await import("./node-routes.js");
    const { pveResticRoutes } = await import("./restic-route.js");
    const { errorHandler } = await import("../../problem.js");
    const app = new Hono();
    app.onError(errorHandler);
    app.route("/agent/pve/v1", pveNodeRoutes);
    app.route("/agent/pve/restic", pveResticRoutes);
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    port = (server.address() as AddressInfo).port;

    // The container as vzdump mounts it for the backup: its root and one mount point.
    work = await mkdtemp(join(tmpdir(), "restow-pve-files-"));
    backupDir = join(work, "vzdumptmp1234_300");
    await mkdir(join(backupDir, "etc"), { recursive: true });
    await mkdir(join(backupDir, "opt", "paperless", "media"), { recursive: true });
    await mkdir(join(backupDir, "mnt", "data"), { recursive: true });
    await writeFile(join(backupDir, "etc", "hostname"), "paperless\n");
    await writeFile(join(backupDir, "opt", "paperless", "paperless.conf"), "PAPERLESS_PORT=8000\n");
    await writeFile(
      join(backupDir, "opt", "paperless", "media", "scan.pdf"),
      Buffer.alloc(200_000, 3),
    );
    await writeFile(join(backupDir, "mnt", "data", "archive.txt"), "kept on the mount point\n");
    for (let i = 0; i < 5; i++) {
      await writeFile(join(backupDir, "opt", `file-${i}.txt`), `file ${i}\n`);
    }

    // Enroll and report the container, as restow-pve does.
    const { token } = await service.createEnrollmentToken(shared.db, fixture.tenantId, actor(), {
      url: "https://restow.test.example",
    });
    const enrolled = await fetch(`http://127.0.0.1:${port}/agent/pve/v1/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        clusterName: "lab",
        clusterFingerprint: "f".repeat(64),
        nodeName: "pve1",
        pveVersion: "9.2.1",
        helperVersion: "0.4.0",
        fleecingStorage: "local-lvm",
      }),
    });
    node = await ok<Node>(enrolled, 201);
    await ok(
      await call("/inventory", {
        guests: [
          { vmid: 300, kind: "ct", name: "paperless", node: "pve1", status: "running" },
          { vmid: 301, kind: "vm", name: "web", node: "pve1", status: "running", disks: [] },
        ],
      }),
    );

    // A backup started in PVE: open the run, take its restic credential, back up, commit.
    const run = await ok<{ runId: string; guestId: string }>(
      await call("/runs", {
        vmid: 300,
        kind: "ct",
        archiveName: "ct/300/2026-10-14T22:00:00Z",
        storageId: "restow",
        startedAt: "2026-10-14T22:00:00Z",
      }),
      201,
    );
    guestId = run.guestId;
    const credential = await ok<{
      username: string;
      password: string;
      repositoryPassword: string;
    }>(await call(`/runs/${run.runId}/restic`, {}));
    const backup = await restic(
      ["backup", "--json", "--host", "pve-ct-300", "--", ".", "./mnt/data"],
      backupDir,
      {
        RESTIC_REPOSITORY: `rest:http://127.0.0.1:${port}/agent/pve/restic/${guestId}/`,
        RESTIC_REST_USERNAME: credential.username,
        RESTIC_REST_PASSWORD: credential.password,
        RESTIC_PASSWORD: credential.repositoryPassword,
        RESTIC_CACHE_DIR: join(work, "node-cache"),
      },
    );
    expect(backup.code, backup.out).toBe(0);
    const summary = backup.out
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as { message_type?: string; snapshot_id?: string };
        } catch {
          return {};
        }
      })
      .find((line) => line.message_type === "summary");
    const committed = await ok<{ snapshotId: string }>(
      await call(`/runs/${run.runId}/commit`, {
        commitId: randomUUID(),
        guestConfig:
          "arch: amd64\nhostname: paperless\nrootfs: local-lvm:vm-300-disk-0,size=8G\nmp0: local-lvm:vm-300-disk-1,mp=/mnt/data,backup=1,size=4G\nmp1: /srv/host,mp=/mnt/host\n",
        firewallConfig: null,
        resticSnapshotId: summary?.snapshot_id,
        resticBytesAdded: 1000,
        resticTotalBytes: 200_000,
        resticRoot: backupDir,
      }),
    );
    pointId = committed.snapshotId;
    await ok(await call(`/runs/${run.runId}/finish`, { status: "succeeded" }), 204);
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
      (server as { closeAllConnections?: () => void } | undefined)?.closeAllConnections?.();
    });
    await fixture?.cleanup();
    if (work) {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("names what the restore point contains, as paths in the container", async () => {
    const detail = await service.guestDetail(shared.db, fixture.tenantId, guestId);
    expect(detail.snapshots[0]).toMatchObject({
      id: pointId,
      browsable: true,
      contents: ["/", "/mnt/data"],
    });
  });

  it("browses the container's own paths, page by page, and audits every page", async () => {
    const root = await files.browseContainerFiles(
      shared.db,
      fixture.tenantId,
      pointId,
      { path: "/", limit: 1000 },
      actor(),
    );
    expect(root.entries.map((entry) => entry.path)).toEqual(["/etc", "/mnt", "/opt"]);
    // Nothing of the folder the node backed up from shows.
    expect(JSON.stringify(root)).not.toContain("vzdumptmp");

    const first = await files.browseContainerFiles(
      shared.db,
      fixture.tenantId,
      pointId,
      { path: "/opt", limit: 3 },
      actor(),
    );
    expect(first.entries.map((entry) => entry.name)).toEqual([
      "paperless",
      "file-0.txt",
      "file-1.txt",
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = await files.browseContainerFiles(
      shared.db,
      fixture.tenantId,
      pointId,
      { path: "/opt", limit: 3, cursor: first.nextCursor ?? undefined },
      actor(),
    );
    expect(second.entries.map((entry) => entry.name)).toEqual([
      "file-2.txt",
      "file-3.txt",
      "file-4.txt",
    ]);

    const mount = await files.browseContainerFiles(
      shared.db,
      fixture.tenantId,
      pointId,
      { path: "/mnt/data", limit: 1000 },
      actor(),
    );
    expect(mount.entries).toMatchObject([
      { name: "archive.txt", path: "/mnt/data/archive.txt", type: "file", size: 24 },
    ]);

    const audited = await fixture.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "pve.snapshot.browsed"), eq(auditLog.target, pointId)));
    expect(audited).toHaveLength(4);
    expect(audited.every((row) => row.tenantId === fixture.tenantId)).toBe(true);
    expect(
      audited.find((row) => (row.details as { path: string }).path === "/mnt/data")?.details,
    ).toMatchObject({ vmid: 300, name: "paperless", entries: 1 });
  }, 60_000);

  it("downloads a folder and a file as one ZIP, once, audited before the first byte", async () => {
    const prepared = await files.prepareContainerDownload(
      shared.db,
      fixture.tenantId,
      pointId,
      { paths: ["/opt/paperless", "/etc/hostname"] },
      actor(),
    );
    expect(prepared.items).toBe(2);
    // Another admin cannot start it.
    await expect(
      files.openContainerDownload(shared.db, fixture.tenantId, pointId, prepared.id, {
        ...actor(),
        userId: null,
      }),
    ).rejects.toMatchObject({ status: 404 });
    const download = await files.openContainerDownload(
      shared.db,
      fixture.tenantId,
      pointId,
      prepared.id,
      actor(),
    );
    const [audited] = await fixture.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "pve.snapshot.downloaded"), eq(auditLog.target, pointId)));
    expect(audited?.details).toMatchObject({
      vmid: 300,
      downloadId: prepared.id,
      paths: ["/opt/paperless", "/etc/hostname"],
      pathCount: 2,
    });
    expect(download.fileName).toBe("paperless-ct300-2026-10-14.zip");
    const entries = readZip(await readAll(download.stream));
    const zipped = Object.fromEntries(
      entries
        .filter((entry) => !entry.isDirectory)
        .map((entry) => [entry.name, sha256(entry.data)]),
    );
    expect(zipped).toEqual({
      "paperless/paperless.conf": sha256(
        await readFile(join(backupDir, "opt", "paperless", "paperless.conf")),
      ),
      "paperless/media/scan.pdf": sha256(
        await readFile(join(backupDir, "opt", "paperless", "media", "scan.pdf")),
      ),
      hostname: sha256("paperless\n"),
    });
    // Single use.
    await expect(
      files.openContainerDownload(shared.db, fixture.tenantId, pointId, prepared.id, actor()),
    ).rejects.toMatchObject({ status: 404 });
  }, 60_000);

  it("refuses a path outside the restore point and a VM restore point without disks", async () => {
    await expect(
      files.prepareContainerDownload(
        shared.db,
        fixture.tenantId,
        pointId,
        { paths: ["/opt/nothing-here"] },
        actor(),
      ),
    ).rejects.toMatchObject({ status: 404 });
    const [vm] = await fixture.db.select().from(pveGuests).where(eq(pveGuests.vmid, 301));
    const [vmPoint] = await fixture.db
      .insert(pveSnapshots)
      .values({
        tenantId: fixture.tenantId,
        clusterId: node.clusterId,
        guestId: vm?.id ?? "",
        sequence: 1,
        kind: "vm",
        archiveName: "vm/301/2026-10-14T22:00:00Z",
        storageId: "restow",
        manifestPath: "x",
        backupAt: new Date(),
      })
      .returning();
    await expect(
      files.browseContainerFiles(
        shared.db,
        fixture.tenantId,
        vmPoint?.id ?? "",
        { path: "/", limit: 10 },
        actor(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const detail = await service.guestDetail(shared.db, fixture.tenantId, vm?.id ?? "");
    expect(detail.snapshots[0]).toMatchObject({ browsable: false, contents: null });
  });

  it("finds nothing of another tenant (Row Level Security)", async () => {
    // Another tenant's container restore point, stored by the owner role.
    const [cluster] = await fixture.db
      .insert(pveClusters)
      .values({
        tenantId: fixture.otherTenantId,
        name: "other",
        fingerprint: "e".repeat(64),
        storageId: "restow",
      })
      .returning();
    const [guest] = await fixture.db
      .insert(pveGuests)
      .values({
        tenantId: fixture.otherTenantId,
        clusterId: cluster?.id ?? "",
        vmid: 300,
        kind: "ct",
      })
      .returning();
    const [theirs] = await fixture.db
      .insert(pveSnapshots)
      .values({
        tenantId: fixture.otherTenantId,
        clusterId: cluster?.id ?? "",
        guestId: guest?.id ?? "",
        sequence: 1,
        kind: "ct",
        archiveName: "ct/300/2026-10-14T22:00:00Z",
        storageId: "restow",
        manifestPath: "x",
        resticSnapshotId: "a".repeat(64),
        backupAt: new Date(),
      })
      .returning();
    const browse = (tenantId: string, id: string) =>
      files.browseContainerFiles(shared.db, tenantId, id, { path: "/", limit: 10 }, actor());
    await expect(browse(fixture.tenantId, theirs?.id ?? "")).rejects.toMatchObject({
      status: 404,
    });
    await expect(browse(fixture.otherTenantId, pointId)).rejects.toMatchObject({ status: 404 });
    await expect(
      files.prepareContainerDownload(
        shared.db,
        fixture.otherTenantId,
        pointId,
        { paths: ["/etc"] },
        actor(),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("waits for the worker's work on the repository and holds it against it", async () => {
    // Retention or the check holds the repository: the read waits, then says busy.
    const release = await acquireEndpointRepositoryLock(
      fixture.db.$client,
      pveGuestRepositoryLockKey(guestId),
      { mode: "exclusive" },
    );
    try {
      await expect(
        files.browseContainerFiles(
          shared.db,
          fixture.tenantId,
          pointId,
          { path: "/", limit: 10 },
          actor(),
        ),
      ).rejects.toMatchObject({
        status: 503,
        type: "urn:restow:problem:endpoint-repository-locked",
      });
    } finally {
      await release();
    }
    // A download being streamed holds the repository: the worker cannot take it meanwhile.
    const prepared = await files.prepareContainerDownload(
      shared.db,
      fixture.tenantId,
      pointId,
      { paths: ["/etc"] },
      actor(),
    );
    const download = await files.openContainerDownload(
      shared.db,
      fixture.tenantId,
      pointId,
      prepared.id,
      actor(),
    );
    await expect(
      acquireEndpointRepositoryLock(fixture.db.$client, pveGuestRepositoryLockKey(guestId), {
        mode: "exclusive",
      }),
    ).rejects.toThrow(/busy/);
    await readAll(download.stream);
    // Released once the stream ended.
    let taken: (() => Promise<void>) | null = null;
    for (let i = 0; i < 20 && !taken; i++) {
      taken = await acquireEndpointRepositoryLock(
        fixture.db.$client,
        pveGuestRepositoryLockKey(guestId),
        { mode: "exclusive" },
      ).catch(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return null;
      });
    }
    expect(taken).not.toBeNull();
    await taken?.();
  }, 60_000);
});
