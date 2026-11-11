import { spawn } from "node:child_process";
/**
 * A container's repository on write-once storage (docs/STORAGE.md, "Write-once storage"), end to
 * end with the real restic binary: a share that takes new files but refuses to delete, overwrite
 * or rename existing ones.
 *
 *   - CT 109 of the field report: the repository on a write-once directory target holds data but
 *     no config and no keys. The backup is refused (split) until an administrator resets it; the
 *     reset cannot move the leftovers aside there, so the next backup begins the new chain under
 *     a fresh prefix (`pve-guests/<id>.chain-2/`), recorded on the guest and in its chain. Nothing
 *     of the old prefix is moved, changed or deleted, and every reader (the node's restic route,
 *     the next backup, browsing) uses the new prefix.
 *   - A share the probe has not seen yet: it refuses to delete the files of a complete old chain
 *     (EPERM, as the NFS share answers). The reset's next backup tries to move them aside, is
 *     refused, and begins under the next fresh prefix; the old chain stays readable with its own
 *     password.
 *
 * Needs Postgres (RESTOW_TEST_DATABASE_URL, a superuser) and restic (RESTIC_BINARY, else the PATH).
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { serve } from "@hono/node-server";
import { resticBinary, type StorageBackend } from "@restow/core";
import { auditLog, pveGuests, pveSnapshots, storageTargets } from "@restow/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  basic,
  type EndpointFixture,
  keepLittleFree,
  resticAvailable,
  startFixture,
  testDatabaseAdminUrl,
} from "../endpoints/testing/fixture.js";

const DATABASE = "restow_api_pve_write_once_test";
const canRun = Boolean(testDatabaseAdminUrl) && resticAvailable();

/**
 * A storage as the write-once share answers: new keys are written, an existing key is neither
 * deleted nor overwritten (EPERM).
 */
function refusingDeletes(inner: StorageBackend): StorageBackend {
  const refusal = (syscall: string, key: string) =>
    Object.assign(new Error(`EPERM: operation not permitted, ${syscall} '${key}'`), {
      code: "EPERM",
      syscall,
    });
  return {
    put: async (key, data, options) => {
      if ((await inner.head(key)) !== null) {
        throw refusal("rename", key);
      }
      await inner.put(key, data, options);
    },
    get: (key) => inner.get(key),
    getStream: (key) => inner.getStream(key),
    head: (key) => inner.head(key),
    list: (prefix) => inner.list(prefix),
    delete: async (key) => {
      if ((await inner.head(key)) !== null) {
        throw refusal("unlink", key);
      }
    },
  };
}

type Shared = typeof import("../../db.js");
type Service = typeof import("./service.js");
type Repository = typeof import("./repository.js");
type Store = typeof import("./store.js");
type Files = typeof import("./files.js");

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

/** Every file below `dir` (relative) with its bytes. */
async function snapshotTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else {
        out.set(relative(dir, path), (await readFile(path)).toString("base64"));
      }
    }
  }
  await walk(dir);
  return out;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe.skipIf(!canRun)("a container repository on write-once storage", () => {
  let fixture: EndpointFixture;
  let shared: Shared;
  let service: Service;
  let repository: Repository;
  let store: Store;
  let files: Files;
  let server: ReturnType<typeof serve>;
  let port = 0;
  let work: string;
  let worm: string;
  let backupDir: string;
  let node: Node;
  let targetId = "";
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
    const at = `2026-11-${String(sequence).padStart(2, "0")}T22:00:00Z`;
    const run = await ok<{ runId: string; guestId: string }>(
      await call("/runs", {
        vmid: 109,
        kind: "ct",
        archiveName: `ct/109/${at}`,
        storageId: "restow",
        startedAt: at,
      }),
      201,
    );
    guestId = run.guestId;
    return run.runId;
  }

  async function backUp(): Promise<{ runId: string; credential: Credential; snapshotId: string }> {
    const runId = await openRun();
    const credential = await ok<Credential>(await call(`/runs/${runId}/restic`, {}));
    const backup = await restic(["backup", "--json", "--host", "pve-ct-109", "--", "."], {
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
        guestConfig: "arch: amd64\nhostname: nextcloud\nrootfs: local-lvm:vm-109-disk-0,size=8G\n",
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

  /** Mark the target write-once as its last test found it (or not). */
  async function recordWriteOnce(writeOnce: boolean): Promise<void> {
    await fixture.db
      .update(storageTargets)
      .set({
        config: {
          basePath: worm,
          lastProbe: {
            ok: true,
            writeOnce: {
              writeOnce,
              refused: writeOnce ? ["overwrite", "delete"] : [],
              code: writeOnce ? "EPERM" : null,
              checkedAt: new Date().toISOString(),
            },
          },
        } as never,
      })
      .where(eq(storageTargets.id, targetId));
    store.forgetTenantChunkStore(fixture.tenantId);
  }

  const prefixDir = (prefix: string) => join(worm, prefix);
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
    await keepLittleFree(fixture.db);
    shared = await import("../../db.js");
    service = await import("./service.js");
    repository = await import("./repository.js");
    store = await import("./store.js");
    files = await import("./files.js");
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

    work = await mkdtemp(join(tmpdir(), "restow-pve-write-once-"));
    worm = join(work, "worm-share");
    await mkdir(worm, { recursive: true });
    backupDir = join(work, "vzdumptmp_109");
    await mkdir(join(backupDir, "etc"), { recursive: true });
    await writeFile(join(backupDir, "etc", "hostname"), "nextcloud\n");

    // The tenant's primary: a directory target on the write-once share.
    const [target] = await fixture.db
      .insert(storageTargets)
      .values({
        tenantId: fixture.tenantId,
        name: "NAS WORM",
        kind: "local",
        role: "primary",
        config: { basePath: worm },
      })
      .returning();
    targetId = target?.id ?? "";

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
        helperVersion: "0.5.0",
        fleecingStorage: "local-lvm",
      }),
    });
    node = await ok<Node>(enrolled, 201);
    await ok(
      await call("/inventory", {
        guests: [{ vmid: 109, kind: "ct", name: "nextcloud", node: "pve1", status: "running" }],
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

  it("begins a new chain under a fresh prefix after a reset, and leaves the data-only one alone", async () => {
    const first = await backUp();
    const defaultPrefix = `pve-guests/${guestId}/`;
    expect(await exists(join(prefixDir(defaultPrefix), "config"))).toBe(true);
    expect((await guestRow())?.repositoryPrefix).toBeNull();

    // CT 109: data without config and keys (the first half of a split chain).
    await rm(join(prefixDir(defaultPrefix), "config"));
    await rm(join(prefixDir(defaultPrefix), "keys"), { recursive: true });
    await rm(join(prefixDir(defaultPrefix), "locks"), { recursive: true, force: true });
    await recordWriteOnce(true);
    // Every page that shows retention asks this (GET /storage/write-once).
    const { primaryWriteOnce } = await import("../storage/write-once.js");
    expect(await primaryWriteOnce(shared.db, fixture.tenantId)).toMatchObject({
      writeOnce: true,
      targetName: "NAS WORM",
      installationDefault: false,
      refused: ["overwrite", "delete"],
    });
    const leftovers = await snapshotTree(prefixDir(defaultPrefix));
    expect([...leftovers.keys()].some((key) => key.startsWith("data/"))).toBe(true);

    // Restore points still refer to it: refused as split, nothing begins silently.
    const refusedRun = await openRun();
    const refused = await call(`/runs/${refusedRun}/restic`, {});
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { type: string }).type).toBe(
      "urn:restow:problem:pve-repository-split",
    );
    await ok(await call(`/runs/${refusedRun}/finish`, { status: "failed", error: "refused" }), 204);

    // The reset; the next backup cannot move the leftovers aside on write-once storage.
    await repository.resetGuestRepository(
      shared.db,
      fixture.tenantId,
      guestId,
      "nextcloud",
      actor(),
    );
    const second = await backUp();
    const fresh = `pve-guests/${guestId}.chain-2/`;
    expect(second.credential.repositoryPassword).not.toBe(first.credential.repositoryPassword);
    expect(await exists(join(prefixDir(fresh), "config"))).toBe(true);
    expect(await exists(join(prefixDir(fresh), "restow-repository-password.json"))).toBe(true);
    const guest = await guestRow();
    expect(guest?.repositoryPrefix).toBe(fresh);
    expect(guest?.repositoryProblem).toBeNull();
    expect(guest?.repositoryChains[0]).toMatchObject({
      reason: "reset",
      prefix: fresh,
      previousPrefix: defaultPrefix,
    });
    const [audit] = await audits("pve.repository.fresh_prefix");
    expect(audit?.details).toMatchObject({ prefix: fresh, previousPrefix: defaultPrefix });

    // Nothing of the old prefix was moved, changed or deleted: it reads exactly as before.
    expect(await snapshotTree(prefixDir(defaultPrefix))).toEqual(leftovers);
    expect(
      (await readdir(join(worm, "pve-guests"))).filter((name) => name.includes(".orphaned-")),
    ).toEqual([]);
    expect(await pointStatus(first.snapshotId)).toBe("unavailable");
    expect(await pointStatus(second.snapshotId)).toBe("active");

    // The next backup goes on in the same chain under the recorded prefix (no new chain), and
    // its restore point is browsed from there.
    const third = await backUp();
    expect(third.credential.repositoryPassword).toBe(second.credential.repositoryPassword);
    expect((await guestRow())?.repositoryChains).toHaveLength(1);
    const browsed = await files.browseContainerFiles(
      shared.db,
      fixture.tenantId,
      third.snapshotId,
      { path: "/", limit: 100 },
      actor(),
    );
    expect(browsed.entries.map((entry) => entry.path)).toContain("/etc");
    const detail = await service.guestDetail(shared.db, fixture.tenantId, guestId);
    expect(detail.repository?.chains[0]).toMatchObject({ prefix: fresh });
  }, 240_000);

  it("takes the next fresh prefix when the storage refuses the move, and the old chain stays readable", async () => {
    const current = `pve-guests/${guestId}.chain-2/`;
    const oldPassword = (await backUp()).credential.repositoryPassword;
    // Not recorded as write-once (the probe has not seen it): the share itself refuses.
    await recordWriteOnce(false);
    await rm(join(prefixDir(current), "locks"), { recursive: true, force: true });
    const before = await snapshotTree(prefixDir(current));

    await repository.resetGuestRepository(
      shared.db,
      fixture.tenantId,
      guestId,
      "nextcloud",
      actor(),
    );
    // The backup's credential, as the node asks for it, on a storage that refuses deletes.
    const runId = await openRun();
    const password = await repository.ensureGuestRepository(
      fixture.tenantId,
      guestId,
      { runId, write: true, target: targetId },
      { backend: refusingDeletes },
    );
    const fresh = `pve-guests/${guestId}.chain-3/`;
    expect(await exists(join(prefixDir(fresh), "config"))).toBe(true);
    const guest = await guestRow();
    expect(guest?.repositoryPrefix).toBe(fresh);
    expect(guest?.repositoryChains[0]).toMatchObject({
      reason: "reset",
      prefix: fresh,
      previousPrefix: current,
    });
    expect((await audits("pve.repository.fresh_prefix")).at(-1)?.details).toMatchObject({
      prefix: fresh,
      previousPrefix: current,
      reason: "EPERM",
    });
    // The node's backup then writes into the new chain through the restic route.
    const credential = await ok<Credential>(await call(`/runs/${runId}/restic`, {}));
    expect(credential.repositoryPassword).toBe(password);
    const backup = await restic(["backup", "--json", "--host", "pve-ct-109", "--", "."], {
      RESTIC_REPOSITORY: `rest:http://127.0.0.1:${port}/agent/pve/restic/${guestId}/`,
      RESTIC_REST_USERNAME: credential.username,
      RESTIC_REST_PASSWORD: credential.password,
      RESTIC_PASSWORD: credential.repositoryPassword,
      RESTIC_CACHE_DIR: join(work, "node-cache"),
    });
    expect(backup.code, backup.out).toBe(0);
    expect((await readdir(join(prefixDir(fresh), "snapshots"))).length).toBe(1);
    await ok(await call(`/runs/${runId}/finish`, { status: "failed", error: "test" }), 204);

    // The old chain is where it was, whole (only a copy of one file went to a moved-aside
    // folder before the share refused), and restic opens it with its own password.
    expect(await snapshotTree(prefixDir(current))).toEqual(before);
    const listed = await restic(["snapshots", "--json", "--no-lock", "--no-cache"], {
      RESTIC_REPOSITORY: prefixDir(current),
      RESTIC_PASSWORD: oldPassword,
    });
    expect(listed.code, listed.out).toBe(0);
    expect((JSON.parse(listed.out) as unknown[]).length).toBeGreaterThanOrEqual(3);
  }, 240_000);
});
