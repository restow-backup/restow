import { spawn } from "node:child_process";
/**
 * The repository of a Proxmox VE container must really be on the primary when a backup gets
 * its credential (docs/PVE.md, "New backup chain"), end to end with the real restic binary:
 *
 *   - the repository deleted from the primary: the next credential creates a new one (a new
 *     password), the old restore points become unavailable (no readiness, no restore), the
 *     guest records the new chain and the audit log says so, and the backup succeeds;
 *   - the repository only on another target of the tenant (a retired primary after a "keep"
 *     switch): the backup is refused with a clear problem, nothing is created;
 *   - a backup stopped in the UI: its credential may still release its own lock (and open the
 *     repository for that), every write is refused and audited;
 *   - a reset by an administrator: typed name, restore points unavailable at once, the old
 *     repository on the primary removed by the next backup, which begins a new chain.
 *
 * Needs Postgres (RESTOW_TEST_DATABASE_URL, a superuser) and restic (RESTIC_BINARY, else the PATH).
 */
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { resticBinary } from "@restow/core";
import { auditLog, pveGuests, pveRuns, pveSnapshots, storageTargets } from "@restow/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  basic,
  type EndpointFixture,
  resticAvailable,
  startFixture,
  testDatabaseAdminUrl,
} from "../endpoints/testing/fixture.js";

const DATABASE = "restow_api_pve_repository_test";
const canRun = Boolean(testDatabaseAdminUrl) && resticAvailable();

type Shared = typeof import("../../db.js");
type Service = typeof import("./service.js");
type Repository = typeof import("./repository.js");
type Store = typeof import("./store.js");

interface Node {
  nodeId: string;
  nodeSecret: string;
  clusterId: string;
}

interface Credential {
  username: string;
  password: string;
  repositoryPassword: string;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe.skipIf(!canRun)("the repository of a container is checked before a backup", () => {
  let fixture: EndpointFixture;
  let shared: Shared;
  let service: Service;
  let repository: Repository;
  let store: Store;
  let server: ReturnType<typeof serve>;
  let port = 0;
  let work: string;
  let backupDir: string;
  let node: Node;
  let guestId = "";
  let sequence = 0;
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

  function restic(args: string[], env: Record<string, string>) {
    return new Promise<{ code: number | null; out: string }>((resolve, reject) => {
      const child = spawn(resticBinary(), args, {
        cwd: backupDir,
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

  async function openRun(): Promise<string> {
    sequence += 1;
    const at = `2026-10-${String(10 + sequence).padStart(2, "0")}T22:00:00Z`;
    const run = await ok<{ runId: string; guestId: string }>(
      await call("/runs", {
        vmid: 300,
        kind: "ct",
        archiveName: `ct/300/${at}`,
        storageId: "restow",
        startedAt: at,
      }),
      201,
    );
    guestId = run.guestId;
    return run.runId;
  }

  /** A whole container backup as restow-pve runs it; returns the credential it used. */
  async function backUp(): Promise<{ runId: string; credential: Credential; snapshotId: string }> {
    const runId = await openRun();
    const credential = await ok<Credential>(await call(`/runs/${runId}/restic`, {}));
    const backup = await restic(["backup", "--json", "--host", "pve-ct-300", "--", "."], {
      RESTIC_REPOSITORY: `rest:http://127.0.0.1:${port}/agent/pve/restic/${guestId}/`,
      RESTIC_REST_USERNAME: credential.username,
      RESTIC_REST_PASSWORD: credential.password,
      RESTIC_PASSWORD: credential.repositoryPassword,
      RESTIC_CACHE_DIR: join(work, "node-cache"),
    });
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
      await call(`/runs/${runId}/commit`, {
        commitId: randomUUID(),
        guestConfig: "arch: amd64\nhostname: paperless\nrootfs: local-lvm:vm-300-disk-0,size=8G\n",
        firewallConfig: null,
        resticSnapshotId: summary?.snapshot_id,
        resticBytesAdded: 100,
        resticTotalBytes: 1000,
        resticRoot: backupDir,
      }),
    );
    await ok(await call(`/runs/${runId}/finish`, { status: "succeeded" }), 204);
    return { runId, credential, snapshotId: committed.snapshotId };
  }

  const repositoryDir = () => join(fixture.storageDir, "pve-guests", guestId);
  const guestRow = async () =>
    (await fixture.db.select().from(pveGuests).where(eq(pveGuests.id, guestId)))[0];
  const pointStatus = async (id: string) =>
    (await fixture.db.select().from(pveSnapshots).where(eq(pveSnapshots.id, id)))[0]?.status;
  const audits = (action: string) =>
    fixture.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, fixture.tenantId), eq(auditLog.action, action)));

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    shared = await import("../../db.js");
    service = await import("./service.js");
    repository = await import("./repository.js");
    store = await import("./store.js");
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

    work = await mkdtemp(join(tmpdir(), "restow-pve-repository-"));
    backupDir = join(work, "vzdumptmp_300");
    await mkdir(join(backupDir, "etc"), { recursive: true });
    await writeFile(join(backupDir, "etc", "hostname"), "paperless\n");

    const { token } = await service.createEnrollmentToken(shared.db, fixture.tenantId, actor(), {
      url: "https://restow.test.example",
    });
    const enrolled = await fetch(`http://127.0.0.1:${port}/agent/pve/v1/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        clusterName: "lab",
        clusterFingerprint: "e".repeat(64),
        nodeName: "pve1",
        pveVersion: "9.2.1",
        helperVersion: "0.4.0",
        fleecingStorage: "local-lvm",
      }),
    });
    node = await ok<Node>(enrolled, 201);
    await ok(
      await call("/inventory", {
        guests: [{ vmid: 300, kind: "ct", name: "paperless", node: "pve1", status: "running" }],
      }),
    );
  }, 120_000);

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

  it("begins a new chain when the repository is gone from the primary", async () => {
    const first = await backUp();
    expect(await exists(join(repositoryDir(), "config"))).toBe(true);
    const before = await guestRow();
    expect(before?.repositoryChains).toEqual([]);

    // A second backup with the repository in place: the same repository, no new chain.
    const second = await backUp();
    expect(second.credential.repositoryPassword).toBe(first.credential.repositoryPassword);
    expect(await audits("pve.repository.reinitialized")).toHaveLength(0);

    // The repository disappears from the primary (the field incident: the primary changed).
    await rm(repositoryDir(), { recursive: true, force: true });
    const third = await backUp();
    expect(third.credential.repositoryPassword).not.toBe(first.credential.repositoryPassword);
    expect(await exists(join(repositoryDir(), "config"))).toBe(true);
    expect(await pointStatus(first.snapshotId)).toBe("unavailable");
    expect(await pointStatus(second.snapshotId)).toBe("unavailable");
    expect(await pointStatus(third.snapshotId)).toBe("active");

    const guest = await guestRow();
    expect(guest?.repositoryChains).toHaveLength(1);
    expect(guest?.repositoryChains[0]).toMatchObject({
      reason: "missing",
      unavailablePoints: 2,
      actor: null,
      target: { name: "Installation default", kind: "local", installationDefault: true },
    });
    // The installation default's path stays with the provider.
    expect(guest?.repositoryChains[0]?.target?.location).toBeNull();
    expect(guest?.lastSnapshotId).toBe(third.snapshotId);

    const [event] = await audits("pve.repository.reinitialized");
    expect(event?.target).toBe(guestId);
    expect(event?.details).toMatchObject({ reason: "missing", unavailablePoints: 2 });

    // The guest page shows the chain and the unavailable restore points as such.
    const detail = await service.guestDetail(shared.db, fixture.tenantId, guestId);
    expect(detail.repository?.chains[0]?.reason).toBe("missing");
    const listed = new Map(detail.snapshots.map((s) => [s.id, s]));
    expect(listed.get(first.snapshotId)).toMatchObject({ available: false, browsable: false });
    expect(listed.get(third.snapshotId)).toMatchObject({ available: true, backupType: "first" });
    // A restore point of the old chain is neither restored nor checked any more.
    await expect(
      service.requestVerify(shared.db, fixture.tenantId, first.snapshotId, actor()),
    ).rejects.toMatchObject({ status: 404 });
  }, 180_000);

  it("lets a stopped backup release its own lock, and nothing else", async () => {
    const runId = await openRun();
    const credential = await ok<Credential>(await call(`/runs/${runId}/restic`, {}));
    const base = `http://127.0.0.1:${port}/agent/pve/restic/${guestId}`;
    const auth = {
      authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
    };
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    const send = (method: string, path: string, body?: string) =>
      fetch(`${base}${path}`, { method, headers: auth, body });
    // The running backup takes its lock (as restic does) and a second one it will refresh.
    expect((await send("POST", `/locks/${sha("lock-1")}`, "lock-1")).status).toBe(200);
    expect((await send("POST", `/locks/${sha("lock-2")}`, "lock-2")).status).toBe(200);

    // Stopped in the UI: restic fails at its next write, but its lock goes with it.
    await fixture.db
      .update(pveRuns)
      .set({ cancelRequestedAt: new Date() })
      .where(eq(pveRuns.id, runId));
    const deniedBefore = (await audits("pve.node.denied")).length;
    expect((await send("POST", `/data/${sha("more")}`, "more")).status).toBe(403);
    expect((await send("POST", `/locks/${sha("lock-3")}`, "lock-3")).status).toBe(403);
    expect((await send("GET", "/config")).status).toBe(200);
    expect((await send("GET", "/locks/")).status).toBe(200);
    expect((await send("DELETE", `/locks/${sha("lock-1")}`)).status).toBe(200);
    expect(await exists(join(repositoryDir(), "locks", sha("lock-1")))).toBe(false);
    const denied = (await audits("pve.node.denied")).slice(deniedBefore);
    expect(denied.map((entry) => entry.details)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "write", type: "data", reason: "not_allowed" }),
        expect.objectContaining({ action: "write", type: "locks", reason: "not_allowed" }),
      ]),
    );

    // Also once the run has ended (the node reported the end before restic let go).
    await ok(await call(`/runs/${runId}/finish`, { status: "failed", error: "stopped" }), 204);
    expect((await send("DELETE", `/locks/${sha("lock-2")}`)).status).toBe(200);
    // Until the credential expires.
    await fixture.db
      .update(pveRuns)
      .set({ resticExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(pveRuns.id, runId));
    expect((await send("GET", "/config")).status).toBe(401);
  }, 60_000);

  it("refuses a backup while the repository lies only on another target", async () => {
    // The repository moves to a retired primary (what "keep existing backups" left behind).
    const retired = join(work, "retired");
    await mkdir(join(retired, "pve-guests"), { recursive: true });
    await cp(repositoryDir(), join(retired, "pve-guests", guestId), { recursive: true });
    await rm(repositoryDir(), { recursive: true, force: true });
    await fixture.db.insert(storageTargets).values({
      tenantId: fixture.tenantId,
      name: "Old NAS",
      kind: "local",
      role: "previous",
      config: { basePath: retired },
    });
    store.forgetTenantChunkStore(fixture.tenantId);
    const chainsBefore = (await guestRow())?.repositoryChains.length;

    const runId = await openRun();
    const response = await call(`/runs/${runId}/restic`, {});
    expect(response.status).toBe(409);
    const body = (await response.json()) as { type: string; detail: string };
    expect(body.type).toBe("urn:restow:problem:pve-repository-elsewhere");
    expect(body.detail).toContain("reset the repository");
    expect(await exists(join(repositoryDir(), "config"))).toBe(false);
    expect((await guestRow())?.repositoryChains.length).toBe(chainsBefore);
    await ok(await call(`/runs/${runId}/finish`, { status: "failed", error: "refused" }), 204);
  }, 60_000);

  it("resets the repository: typed name, points unavailable, a new chain next backup", async () => {
    await expect(
      repository.resetGuestRepository(shared.db, fixture.tenantId, guestId, "wrong", actor()),
    ).rejects.toMatchObject({ status: 422 });

    // An old repository on the primary as well (removed by the next backup).
    await mkdir(repositoryDir(), { recursive: true });
    await writeFile(join(repositoryDir(), "config"), "stale");
    const active = await fixture.db
      .select({ id: pveSnapshots.id })
      .from(pveSnapshots)
      .where(and(eq(pveSnapshots.guestId, guestId), eq(pveSnapshots.status, "active")));
    expect(active.length).toBeGreaterThan(0);

    const result = await repository.resetGuestRepository(
      shared.db,
      fixture.tenantId,
      guestId,
      " paperless ",
      actor(),
    );
    expect(result.unavailablePoints).toBe(active.length);
    for (const point of active) {
      expect(await pointStatus(point.id)).toBe("unavailable");
    }
    const reset = await guestRow();
    expect(reset?.repositoryReadyAt).toBeNull();
    expect(reset?.repositorySecretId).toBeNull();
    expect(reset?.repositoryChains[0]).toMatchObject({
      reason: "reset",
      actor: "admin@contoso.example",
    });
    const [event] = await audits("pve.repository.reset");
    expect(event?.actorUserId).toBe(fixture.adminId);

    // The next backup creates a new repository on the primary (the retired one stays as it is).
    const next = await backUp();
    expect(await pointStatus(next.snapshotId)).toBe("active");
    expect(await exists(join(work, "retired", "pve-guests", guestId, "config"))).toBe(true);
    expect((await guestRow())?.repositoryReadyAt).not.toBeNull();
  }, 180_000);
});
