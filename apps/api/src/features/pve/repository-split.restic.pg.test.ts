import { spawn } from "node:child_process";
/**
 * The 2026-10-16 field incident end to end, with the real restic binary and Postgres
 * (docs/STORAGE.md, "Runs and storage changes"; docs/PVE.md, "Repository problems"). The
 * tenant's primary is the installation default; NFW-01 is a copy target. On 0.4.1 the copy was
 * promoted while CT 109's first backup ran:
 *
 *   - the run's config, keys and first packs landed on the installation default, the rest
 *     (later packs, index, snapshot) on NFW-01, and the restore point looked fine;
 *   - the promotion dropped the installation default from the tenant's targets;
 *   - CT 109's next backups failed with HTTP 500 (`restic init` on a prefix that holds a
 *     snapshot), also after "Reset repository", and left an orphan secret each time;
 *   - CT 100, intact on the installation default, silently began a new chain, its restore
 *     points became unavailable.
 *
 * Each of these is asserted the other way round here: promoting is refused; a run whose target
 * stops being the primary in the middle (the same role flip 0.4.1 did, written straight to the
 * database) gets 403 for its writes (restic stops at once) and writes nothing to the new
 * primary; the repository found on another target, split across targets or missing is refused
 * with its own problem (never a 500, never a silent new chain, no orphan secret); restores read
 * from the target that holds the repository; a reset moves the leftovers aside and the next
 * backup begins a new chain.
 *
 * Not every assertion fails on 0.4.x by itself: there the restic route resolved the primary
 * through a cache of up to a minute, so a flip seconds into a run left all of its writes on the
 * old primary, and "NFW-01 got nothing" held on the old code as well. The last test therefore
 * takes the old code path on purpose (a run with no target recorded, as every run before 0.5.0,
 * and the cache dropped at the flip, as its expiry would) and shows the split it makes: config,
 * keys and the first pack on the installation default, the other packs, index and snapshot on
 * NFW-01, and a committed restore point. That is the layout the repair's own test
 * (apps/worker/src/handlers/repository-repair.pg.test.ts, CT 109) rebuilds; here the 0.5.0
 * credential path is run on it.
 *
 * Needs Postgres (RESTOW_TEST_DATABASE_URL, a superuser) and restic (RESTIC_BINARY, else PATH).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { resticBinary } from "@restow/core";
import {
  auditLog,
  pveGuests,
  pveRuns,
  pveSnapshots,
  secrets,
  storageRepositoryRepairs,
  storageTargets,
} from "@restow/db";
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

const DATABASE = "restow_api_pve_split_test";
const canRun = Boolean(testDatabaseAdminUrl) && resticAvailable();

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

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string, rel: string) {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(d, entry.name), r);
      } else {
        out.push(r);
      }
    }
  }
  await walk(dir, "");
  return out.sort();
}

describe.skipIf(!canRun)("a storage change in the middle of a container backup", () => {
  let fixture: EndpointFixture;
  let shared: typeof import("../../db.js");
  let service: typeof import("./service.js");
  let store: typeof import("./store.js");
  let repository: typeof import("./repository.js");
  let storageService: typeof import("../storage/service.js");
  let server: ReturnType<typeof serve>;
  let port = 0;
  let work: string;
  let copyDir: string;
  let node: Node;
  let copyId = "";
  let sequence = 0;
  /** Flip the copy to primary after this many data uploads (null: never). */
  let flipAfterDataUploads: number | null = null;
  let dataUploads = 0;
  /** At the flip, also take the old code path: drop the run's target and the cached store. */
  let flipTheOldWay = false;
  const refusedWrites: { status: number; type: string | null }[] = [];
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

  function restic(args: string[], env: Record<string, string>, cwd: string) {
    return new Promise<{ code: number | null; out: string }>((resolve, reject) => {
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

  /** The role flip of 0.4.0 and 0.4.1: no guard, no lock, no placeholder for the default. */
  async function flipLikeV041() {
    await fixture.db
      .update(storageTargets)
      .set({ role: "copy" })
      .where(
        and(eq(storageTargets.tenantId, fixture.tenantId), eq(storageTargets.role, "primary")),
      );
    await fixture.db
      .update(storageTargets)
      .set({ role: "primary" })
      .where(eq(storageTargets.id, copyId));
  }

  async function openRun(vmid: number): Promise<{ runId: string; guestId: string }> {
    sequence += 1;
    const at = `2026-10-${String(10 + sequence).padStart(2, "0")}T12:00:00Z`;
    return ok(
      await call("/runs", {
        vmid,
        kind: "ct",
        archiveName: `ct/${vmid}/${at}`,
        storageId: "restow",
        startedAt: at,
      }),
      201,
    );
  }

  async function backUp(vmid: number, dir: string) {
    const { runId, guestId } = await openRun(vmid);
    const credentialResponse = await call(`/runs/${runId}/restic`, {});
    if (credentialResponse.status !== 200) {
      const body = (await credentialResponse.json()) as { type?: string; detail?: string };
      await call(`/runs/${runId}/finish`, { status: "failed", error: "credential" });
      return { runId, guestId, credentialStatus: credentialResponse.status, body };
    }
    const credential = (await credentialResponse.json()) as Credential;
    const backup = await restic(
      ["backup", "--json", "--pack-size", "4", "--host", `pve-ct-${vmid}`, "--", "."],
      {
        RESTIC_REPOSITORY: `rest:http://127.0.0.1:${port}/agent/pve/restic/${guestId}/`,
        RESTIC_REST_USERNAME: credential.username,
        RESTIC_REST_PASSWORD: credential.password,
        RESTIC_PASSWORD: credential.repositoryPassword,
        RESTIC_CACHE_DIR: join(work, `node-cache-${vmid}`),
      },
      dir,
    );
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
    let snapshotId: string | null = null;
    if (backup.code === 0) {
      const committed = await ok<{ snapshotId: string }>(
        await call(`/runs/${runId}/commit`, {
          commitId: randomUUID(),
          guestConfig: `arch: amd64\nhostname: ct${vmid}\nrootfs: local-lvm:vm-${vmid}-disk-0,size=8G\n`,
          firewallConfig: null,
          resticSnapshotId: summary?.snapshot_id,
          resticBytesAdded: 100,
          resticTotalBytes: 1000,
          resticRoot: dir,
        }),
      );
      snapshotId = committed.snapshotId;
      await ok(await call(`/runs/${runId}/finish`, { status: "succeeded" }), 204);
    } else {
      await call(`/runs/${runId}/finish`, { status: "failed", error: "restic" });
    }
    return {
      runId,
      guestId,
      credentialStatus: 200,
      credential,
      resticCode: backup.code,
      resticOut: backup.out.slice(-800),
      snapshotId,
    };
  }

  async function data(name: string, mib: number): Promise<string> {
    const dir = join(work, name);
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < mib; i++) {
      await writeFile(join(dir, `f${i}`), randomBytes(1024 * 1024));
    }
    return dir;
  }

  async function guestRow(guestId: string) {
    const [row] = await fixture.db.select().from(pveGuests).where(eq(pveGuests.id, guestId));
    return row;
  }

  async function pointStatus(id: string) {
    const [row] = await fixture.db
      .select({ status: pveSnapshots.status })
      .from(pveSnapshots)
      .where(eq(pveSnapshots.id, id));
    return row?.status;
  }

  async function secretCount(): Promise<number> {
    const rows = await fixture.db
      .select({ id: secrets.id })
      .from(secrets)
      .where(and(eq(secrets.tenantId, fixture.tenantId), eq(secrets.kind, "pve_ct_repository")));
    return rows.length;
  }

  async function audits(action: string) {
    return fixture.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, fixture.tenantId), eq(auditLog.action, action)));
  }

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    shared = await import("../../db.js");
    service = await import("./service.js");
    store = await import("./store.js");
    repository = await import("./repository.js");
    storageService = await import("../storage/service.js");
    const { pveNodeRoutes } = await import("./node-routes.js");
    const { pveResticRoutes } = await import("./restic-route.js");
    const { errorHandler } = await import("../../problem.js");
    const app = new Hono();
    app.onError(errorHandler);
    app.route("/agent/pve/v1", pveNodeRoutes);
    app.use("/agent/pve/restic/*", async (c, next) => {
      await next();
      if (c.req.method === "POST" && c.res.status === 403) {
        const body = (await c.res
          .clone()
          .json()
          .catch(() => ({}))) as { type?: string };
        refusedWrites.push({ status: 403, type: body.type ?? null });
      }
      if (c.req.method === "POST" && c.req.path.includes("/data/") && c.res.status === 200) {
        dataUploads += 1;
        if (flipAfterDataUploads !== null && dataUploads === flipAfterDataUploads) {
          flipAfterDataUploads = null;
          await flipLikeV041();
          if (flipTheOldWay) {
            // A run as before 0.5.0 (no target recorded: the route writes to whatever is the
            // primary now), and the store cache gone as after its minute.
            await fixture.db
              .update(pveRuns)
              .set({ storageTarget: null, storageGeneration: null })
              .where(and(eq(pveRuns.tenantId, fixture.tenantId), eq(pveRuns.status, "running")));
            store.forgetTenantChunkStore(fixture.tenantId);
          }
        }
      }
    });
    app.route("/agent/pve/restic", pveResticRoutes);
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    port = (server.address() as AddressInfo).port;

    work = await mkdtemp(join(tmpdir(), "restow-pve-split-"));
    copyDir = join(work, "nfw-01");
    await mkdir(copyDir, { recursive: true });

    const { token } = await service.createEnrollmentToken(shared.db, fixture.tenantId, actor(), {
      url: "https://restow.test.example",
    });
    node = await ok<Node>(
      await fetch(`http://127.0.0.1:${port}/agent/pve/v1/enroll`, {
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
      }),
      201,
    );
    await ok(
      await call("/inventory", {
        guests: [
          { vmid: 109, kind: "ct", name: "ct109", node: "pve1", status: "running" },
          { vmid: 100, kind: "ct", name: "ct100", node: "pve1", status: "running" },
          { vmid: 102, kind: "ct", name: "ct102", node: "pve1", status: "running" },
          { vmid: 103, kind: "ct", name: "ct103", node: "pve1", status: "running" },
          { vmid: 104, kind: "ct", name: "ct104", node: "pve1", status: "running" },
          { vmid: 106, kind: "ct", name: "ct106", node: "pve1", status: "running" },
        ],
      }),
    );
    // NFW-01: a local copy target (role copy, tested), as on 2026-10-10.
    const [row] = await fixture.db
      .insert(storageTargets)
      .values({
        tenantId: fixture.tenantId,
        name: "NFW-01",
        kind: "local",
        role: "copy",
        status: "ok",
        config: { basePath: copyDir },
      })
      .returning({ id: storageTargets.id });
    copyId = row?.id as string;
    store.forgetTenantChunkStore(fixture.tenantId);
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

  it("reproduces the 2026-10-16 sequence: nothing splits, nothing starts a silent chain", async () => {
    // CT 100 backs up on the installation default (one restore point).
    const dir100 = await data("ct100", 1);
    const ct100first = await backUp(100, dir100);
    expect(ct100first.snapshotId, ct100first.resticOut).not.toBeNull();
    const [run100] = await fixture.db
      .select({ target: pveRuns.storageTarget })
      .from(pveRuns)
      .where(eq(pveRuns.id, ct100first.runId));
    // The run was pinned to the target its credential was issued for.
    expect(run100?.target).toBe("installation_default");

    // Promoting the copy is refused while containers have repositories.
    const refusal = (await storageService
      .promoteTarget(shared.db, fixture.tenantId, copyId, {
        email: "admin@contoso.example",
        id: fixture.adminId,
        ip: "192.0.2.1",
        isProviderAdmin: true,
      } as never)
      .catch((error: unknown) => error)) as { status?: number; type?: string };
    expect(refusal.status).toBe(409);
    expect(refusal.type).toBe("urn:restow:problem:storage-switch-blocked-by-repositories");

    // CT 109's first backup; after its first data pack the primary changes the way 0.4.1
    // changed it (straight in the database, no guard, no lock, the default dropped).
    const dir109 = await data("ct109", 24);
    dataUploads = 0;
    flipAfterDataUploads = 1;
    const ct109first = await backUp(109, dir109);
    // The run fails cleanly instead of finishing on another target.
    expect(ct109first.resticCode).not.toBe(0);
    expect(ct109first.snapshotId).toBeNull();
    expect(refusedWrites.map((refused) => refused.type)).toContain(
      "urn:restow:problem:storage-switched-during-run",
    );
    const g109 = ct109first.guestId;
    // NFW-01 got nothing of it: no data, no index, no snapshot.
    expect(await files(join(copyDir, "pve-guests", g109))).toEqual([]);
    // The installation default has the repository (config and keys).
    expect(await exists(join(fixture.storageDir, "pve-guests", g109, "config"))).toBe(true);

    // After the flip the installation default is no target of the tenant any more (what 0.4.1
    // left behind); it is still searched.
    const resolved = await store.tenantChunkStore(fixture.tenantId);
    expect(resolved.primaryTarget).toBe(copyId);
    expect(resolved.read.copies).toHaveLength(0);

    // CT 109's next backup: refused with the place the repository lies, not a 500.
    const secretsBefore = await secretCount();
    const ct109second = await backUp(109, dir109);
    expect(ct109second.credentialStatus).toBe(409);
    expect(ct109second.body?.type).toBe("urn:restow:problem:pve-repository-elsewhere");
    expect(ct109second.body?.detail).toContain("the installation default");
    expect((await guestRow(g109))?.repositoryProblem).toMatchObject({
      type: "pve-repository-elsewhere",
      heldBy: "installation_default",
    });
    // No orphan secret.
    expect(await secretCount()).toBe(secretsBefore);

    // CT 100's next backup: refused too, no new chain; its restore point stays.
    const ct100second = await backUp(100, dir100);
    expect(ct100second.credentialStatus).toBe(409);
    expect(ct100second.body?.type).toBe("urn:restow:problem:pve-repository-elsewhere");
    expect(await audits("pve.repository.reinitialized")).toHaveLength(0);
    expect(await pointStatus(ct100first.snapshotId as string)).toBe("active");
    expect(await exists(join(fixture.storageDir, "pve-guests", ct100first.guestId, "config"))).toBe(
      true,
    );

    // A restore of CT 100's restore point reads from the target that holds it.
    const restoreCredential = await ok<Credential>(
      await call(`/snapshots/${ct100first.snapshotId}/restic`, {}),
    );
    const listed = await restic(
      ["snapshots", "--json", "--no-lock"],
      {
        RESTIC_REPOSITORY: `rest:http://127.0.0.1:${port}/agent/pve/restic/${ct100first.guestId}/`,
        RESTIC_REST_USERNAME: restoreCredential.username,
        RESTIC_REST_PASSWORD: restoreCredential.password,
        RESTIC_PASSWORD: restoreCredential.repositoryPassword,
        RESTIC_CACHE_DIR: join(work, "restore-cache"),
      },
      work,
    );
    expect(listed.code, listed.out).toBe(0);
    expect(listed.out).toContain('"hostname":"pve-ct-100"');
  }, 600_000);

  it("refuses a split repository with its own problem; a reset moves the leftovers aside", async () => {
    // CT 102 backs up completely on the (now) primary NFW-01; then its config and keys are
    // taken away, as CT 109's are on NFW-01 in the field: data, index and snapshot without them.
    const dir102 = await data("ct102", 1);
    const first = await backUp(102, dir102);
    expect(first.snapshotId, first.resticOut).not.toBeNull();
    const repo102 = join(copyDir, "pve-guests", first.guestId);
    const aside = join(work, "ct102-config-and-keys");
    await mkdir(aside, { recursive: true });
    await cp(join(repo102, "config"), join(aside, "config"));
    await cp(join(repo102, "keys"), join(aside, "keys"), { recursive: true });
    await rm(join(repo102, "config"));
    await rm(join(repo102, "keys"), { recursive: true, force: true });
    repository.forgetCheckedRuns();

    const secretsBefore = await secretCount();
    const second = await backUp(102, dir102);
    expect(second.credentialStatus).toBe(409);
    expect(second.body?.type).toBe("urn:restow:problem:pve-repository-split");
    expect(await secretCount()).toBe(secretsBefore);
    expect((await guestRow(first.guestId))?.repositoryProblem?.type).toBe("pve-repository-split");

    // "Reset repository": the restore point becomes unavailable, and the next backup moves the
    // data-only leftovers aside (never deletes them) and begins a new chain.
    await repository.resetGuestRepository(
      shared.db,
      fixture.tenantId,
      first.guestId,
      "ct102",
      actor(),
    );
    expect(await pointStatus(first.snapshotId as string)).toBe("unavailable");
    const third = await backUp(102, dir102);
    expect(third.credentialStatus).toBe(200);
    expect(third.snapshotId, third.resticOut).not.toBeNull();
    const siblings = await readdir(join(copyDir, "pve-guests"));
    const orphaned = siblings.filter((name) => name.startsWith(`${first.guestId}.orphaned-`));
    expect(orphaned).toHaveLength(1);
    expect(await files(join(copyDir, "pve-guests", orphaned[0] as string))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^snapshots\//),
        expect.stringMatching(/^index\//),
      ]),
    );
    expect((await guestRow(first.guestId))?.repositoryProblem).toBeNull();
    // One new secret for the new chain, none for the refused attempt.
    expect(await secretCount()).toBe(secretsBefore + 1);
  }, 300_000);

  it("refuses a repository missing everywhere while restore points refer to it", async () => {
    const dir103 = await data("ct103", 1);
    const first = await backUp(103, dir103);
    expect(first.snapshotId, first.resticOut).not.toBeNull();
    await rm(join(copyDir, "pve-guests", first.guestId), { recursive: true, force: true });
    repository.forgetCheckedRuns();

    const second = await backUp(103, dir103);
    expect(second.credentialStatus).toBe(409);
    expect(second.body?.type).toBe("urn:restow:problem:pve-repository-missing");
    expect(await pointStatus(first.snapshotId as string)).toBe("active");
    expect(await audits("pve.repository.reinitialized")).toHaveLength(0);

    // With no restore point referring to it any more, a new chain begins without asking.
    await fixture.db
      .update(pveSnapshots)
      .set({ status: "pruned" })
      .where(eq(pveSnapshots.id, first.snapshotId as string));
    const third = await backUp(103, dir103);
    expect(third.credentialStatus).toBe(200);
    expect(third.snapshotId, third.resticOut).not.toBeNull();
    const [event] = await audits("pve.repository.reinitialized");
    expect(event?.details).toMatchObject({ reason: "missing", unavailablePoints: 0 });
  }, 300_000);

  it("moves a whole leftover aside after a reset; a failed or a running repair holds backups", async () => {
    const dir106 = await data("ct106", 1);
    const first = await backUp(106, dir106);
    expect(first.snapshotId, first.resticOut).not.toBeNull();
    // A reset, then the next backup: the old repository (config, keys, data) is moved aside,
    // never deleted (0.4.x deleted it), and a new chain begins.
    await repository.resetGuestRepository(
      shared.db,
      fixture.tenantId,
      first.guestId,
      "ct106",
      actor(),
    );
    const second = await backUp(106, dir106);
    expect(second.credentialStatus).toBe(200);
    expect(second.snapshotId, second.resticOut).not.toBeNull();
    const orphaned = (await readdir(join(copyDir, "pve-guests"))).filter((name) =>
      name.startsWith(`${first.guestId}.orphaned-`),
    );
    expect(orphaned).toHaveLength(1);
    expect(await files(join(copyDir, "pve-guests", orphaned[0] as string))).toEqual(
      expect.arrayContaining([
        "config",
        expect.stringMatching(/^keys\//),
        expect.stringMatching(/^snapshots\//),
      ]),
    );

    // The repair could not rebuild it: refused even though config and keys are on the primary.
    const failed = {
      at: "2026-11-04T10:00:00.000Z",
      type: "pve-repository-repair-failed",
      heldBy: null,
      activePoints: 1,
    };
    await fixture.db
      .update(pveGuests)
      .set({ repositoryProblem: failed })
      .where(eq(pveGuests.id, first.guestId));
    repository.forgetCheckedRuns();
    const refused = await backUp(106, dir106);
    expect(refused.credentialStatus).toBe(409);
    expect(refused.body?.type).toBe("urn:restow:problem:pve-repository-repair-failed");
    expect((await guestRow(first.guestId))?.repositoryProblem).toEqual(failed);
    await fixture.db
      .update(pveGuests)
      .set({ repositoryProblem: null })
      .where(eq(pveGuests.id, first.guestId));

    // A repair is queued: backups get no credential until it has ended.
    const [repair] = await fixture.db
      .insert(storageRepositoryRepairs)
      .values({ tenantId: fixture.tenantId, kind: "apply", requestedBy: "admin@contoso.example" })
      .returning();
    const waiting = await backUp(106, dir106);
    expect(waiting.credentialStatus).toBe(409);
    expect(waiting.body?.type).toBe("urn:restow:problem:storage-repair-running");
    await fixture.db
      .delete(storageRepositoryRepairs)
      .where(eq(storageRepositoryRepairs.id, repair?.id as string));
    const after = await backUp(106, dir106);
    expect(after.credentialStatus).toBe(200);
    expect(after.snapshotId, after.resticOut).not.toBeNull();
  }, 300_000);

  it("shows the split the old code path makes, and refuses it with the 0.5.0 credential", async () => {
    // Back to the state of 2026-10-16: the installation default is the primary, NFW-01 a copy.
    await fixture.db
      .update(storageTargets)
      .set({ role: "copy" })
      .where(eq(storageTargets.id, copyId));
    store.forgetTenantChunkStore(fixture.tenantId);
    const dir104 = await data("ct104", 24);
    dataUploads = 0;
    flipTheOldWay = true;
    flipAfterDataUploads = 1;
    let first: Awaited<ReturnType<typeof backUp>>;
    try {
      first = await backUp(104, dir104);
    } finally {
      flipTheOldWay = false;
      flipAfterDataUploads = null;
    }
    // On the old path the run finishes and its restore point is committed: it looks fine.
    expect(first.resticCode, first.resticOut).toBe(0);
    expect(first.snapshotId).not.toBeNull();
    expect(await pointStatus(first.snapshotId as string)).toBe("active");
    const g104 = first.guestId;
    const onDefault = await files(join(fixture.storageDir, "pve-guests", g104));
    const onNfw = await files(join(copyDir, "pve-guests", g104));
    // The installation default: config, keys and the first pack, no index, no snapshot.
    expect(onDefault).toContain("config");
    expect(onDefault.some((key) => key.startsWith("keys/"))).toBe(true);
    expect(onDefault.some((key) => key.startsWith("data/"))).toBe(true);
    expect(onDefault.some((key) => key.startsWith("snapshots/"))).toBe(false);
    // NFW-01, the new primary: the other packs, the index and the snapshot, no config, no key.
    expect(onNfw).not.toContain("config");
    expect(onNfw.some((key) => key.startsWith("keys/"))).toBe(false);
    expect(onNfw.some((key) => key.startsWith("data/"))).toBe(true);
    expect(onNfw.some((key) => key.startsWith("index/"))).toBe(true);
    expect(onNfw.some((key) => key.startsWith("snapshots/"))).toBe(true);

    // 0.5.0: the next backup is refused as split, naming where the config lies; no 500, no
    // new chain, no orphan secret, the restore point stays.
    const secretsBefore = await secretCount();
    const second = await backUp(104, dir104);
    expect(second.credentialStatus).toBe(409);
    expect(second.body?.type).toBe("urn:restow:problem:pve-repository-split");
    expect(second.body?.detail).toContain("the installation default");
    expect((await guestRow(g104))?.repositoryProblem).toMatchObject({
      type: "pve-repository-split",
      heldBy: "installation_default",
      activePoints: 1,
    });
    expect(await secretCount()).toBe(secretsBefore);
    expect(await pointStatus(first.snapshotId as string)).toBe("active");
    expect(
      (await audits("pve.repository.reinitialized")).filter((event) => event.target === g104),
    ).toHaveLength(0);
  }, 600_000);
});
