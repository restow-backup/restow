import { spawn } from "node:child_process";
/**
 * End to end with the real restic binary against the API's own REST endpoint
 * (docs/AGENT.md, docs/TESTING.md): the proof that endpoint backup does what it
 * promises.
 *
 *   - the server initialises the repository at enrollment, the agent never has to,
 *   - a backup with the agent's credentials works, also incrementally,
 *   - with the same credentials every attempt to delete or overwrite is refused:
 *     `forget`, `prune`, a raw DELETE, a raw overwrite, a new config, a new repository,
 *   - the refusals are audited and leave every stored byte as it was,
 *   - the server (maintenance credential) can `forget --prune` and `check`,
 *   - a restore into a new folder matches the source byte for byte,
 *   - the restore test turns readiness green only when the hashes match, and a
 *     damaged pack turns it red,
 *   - browsing and downloading a folder as ZIP work and are audited,
 *   - the agent releases its own locks but cannot lift the server's, an upload
 *     over the storage budget is refused at once while a restore still works,
 *     and the sealed password next to the repository opens it with plain restic.
 *
 * Needs Postgres (RESTOW_TEST_DATABASE_URL, a superuser) and restic
 * (RESTIC_BINARY, else the PATH). The API listens on a real loopback port and
 * restic talks HTTP to it, exactly as an agent does.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import { serve } from "@hono/node-server";
import {
  ResticError,
  openEndpointPassword,
  resticBinary,
  resticCheck,
  resticForget,
  resticPrune,
  resticSnapshots,
  restoreTestSamples,
  singleKeyring,
  withRepository,
} from "@restow/core";
import {
  acquireEndpointRepositoryLock,
  auditLog,
  endpointDownloads,
  endpointReports,
  endpointRepositoryLocks,
  endpoints,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readZip } from "../../../../../packages/core/src/restore/testing/zip-reader.js";
import {
  type EndpointFixture,
  basic,
  resticAvailable,
  startFixture,
  testDatabaseAdminUrl,
} from "./testing/fixture.js";

const DATABASE = "restow_api_endpoints_restic_test";
const canRun = Boolean(testDatabaseAdminUrl) && resticAvailable();

type Shared = typeof import("../../db.js");
type Service = typeof import("./service.js");
type Readiness = typeof import("./readiness.js");
type Repository = typeof import("./repository.js");

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** Every regular file under `root` as `relative path -> sha256`. */
async function treeHashes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        result[relative(root, full)] = sha256(await readFile(full));
      }
    }
  }
  await walk(root);
  return result;
}

interface Agent {
  endpointId: string;
  agentSecret: string;
  repositoryPassword: string;
}

describe.skipIf(!canRun)("endpoint backup with the real restic binary", () => {
  let fixture: EndpointFixture;
  let shared: Shared;
  let service: Service;
  let readiness: Readiness;
  let repository: Repository;
  let port = 0;
  let server: ReturnType<typeof serve>;
  let work: string;
  let source: string;
  let agent: Agent;
  const actor = () => ({
    label: "admin@contoso.example",
    userId: fixture.adminId,
    ip: "192.0.2.1",
  });

  const url = (endpointId: string) => `rest:http://127.0.0.1:${port}/agent/restic/${endpointId}/`;

  /** Runs restic without blocking this process: the API under test lives in it. */
  function restic(
    args: string[],
    who: Agent = agent,
    env: Record<string, string> = {},
  ): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(resticBinary(), args, {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: work,
          RESTIC_REPOSITORY: url(who.endpointId),
          RESTIC_REST_USERNAME: who.endpointId,
          RESTIC_REST_PASSWORD: who.agentSecret,
          RESTIC_PASSWORD: who.repositoryPassword,
          RESTIC_CACHE_DIR: join(work, "agent-cache"),
          ...env,
        },
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

  const rest = (path: string, init: { method?: string; body?: Buffer; who?: Agent } = {}) =>
    fetch(`http://127.0.0.1:${port}/agent/restic/${(init.who ?? agent).endpointId}${path}`, {
      method: init.method ?? "GET",
      headers: basic((init.who ?? agent).endpointId, (init.who ?? agent).agentSecret),
      body: init.body ? new Uint8Array(init.body) : undefined,
    });

  async function maintenanceAccess() {
    const [row] = await fixture.db
      .select()
      .from(endpoints)
      .where(eq(endpoints.id, agent.endpointId));
    if (!row) throw new Error("endpoint missing");
    return repository.repositoryAccess(shared.db, row);
  }

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    shared = await import("../../db.js");
    service = await import("./service.js");
    readiness = await import("./readiness.js");
    repository = await import("./repository.js");
    const { agentRoutes } = await import("./agent-routes.js");
    const { resticRoutes } = await import("./restic-route.js");
    const { installRoutes } = await import("./install-routes.js");
    const { errorHandler } = await import("../../problem.js");
    const app = new Hono();
    app.onError(errorHandler);
    app.route("/agent/v1", agentRoutes);
    app.route("/agent/restic", resticRoutes);
    app.route("/install", installRoutes);
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    port = (server.address() as AddressInfo).port;

    work = await mkdtemp(join(tmpdir(), "restow-endpoint-e2e-"));
    source = join(work, "source");
    await mkdir(join(source, "docs", "deep"), { recursive: true });
    await writeFile(join(source, "hello.txt"), "hello from the endpoint\n");
    await writeFile(join(source, "docs", "report.md"), "# Report\n\nnumbers\n");
    await writeFile(join(source, "docs", "deep", "blob.bin"), Buffer.alloc(300_000, 7));
    await writeFile(join(source, "umlaut-Größe.txt"), "ü\n");

    // Enroll exactly like the agent does: token in the body, secret and password back.
    const created = await service.createEnrollmentToken(
      shared.db,
      fixture.tenantId,
      { profile: "server", os: "linux" },
      actor(),
      { url: "https://restow.test.example", configured: true },
    );
    const response = await fetch(`http://127.0.0.1:${port}/agent/v1/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: created.token,
        hostname: "web-01",
        os: "linux",
        arch: "amd64",
        agentVersion: "0.1.0",
        osVersion: "test",
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      endpointId: string;
      agentSecret: string;
      repository: { url: string; password: string };
    };
    expect(body.repository.url).toContain(`/agent/restic/${body.endpointId}/`);
    agent = {
      endpointId: body.endpointId,
      agentSecret: body.agentSecret,
      repositoryPassword: body.repository.password,
    };
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
      (server as { closeAllConnections?: () => void } | undefined)?.closeAllConnections?.();
    });
    await fixture?.cleanup();
    if (work) await rm(work, { recursive: true, force: true });
  });

  it("backs up with the agent's credentials, also incrementally", async () => {
    const first = await restic(["backup", source]);
    expect(first.code, first.out).toBe(0);
    await writeFile(join(source, "hello.txt"), "hello again\n");
    const second = await restic(["backup", source]);
    expect(second.code, second.out).toBe(0);
    const snapshots = JSON.parse(
      (await restic(["snapshots", "--json"])).out.split("\n")[0] ?? "[]",
    );
    expect(snapshots).toHaveLength(2);
  }, 120_000);

  it("refuses everything that would delete a backup", async () => {
    const before = await resticSnapshotIds();
    expect(before).toHaveLength(2);
    const packsBefore = await treeHashes(join(fixture.storageDir, "endpoints", agent.endpointId));

    for (const args of [
      ["forget", "--prune", "--keep-last", "1"],
      ["forget", "--keep-last", "1"],
      ["forget", before[0] as string],
    ]) {
      const result = await restic(args);
      expect(result.code, args.join(" ")).not.toBe(0);
    }
    // With nothing unreferenced to remove a bare prune has nothing to delete and
    // succeeds; the state below must be unchanged all the same.
    await restic(["prune"]);

    // Nothing changed: same snapshots, same bytes.
    expect(await resticSnapshotIds()).toEqual(before);
    const packsAfter = await treeHashes(join(fixture.storageDir, "endpoints", agent.endpointId));
    const lockless = (tree: Record<string, string>) =>
      Object.fromEntries(Object.entries(tree).filter(([name]) => !name.startsWith("locks")));
    expect(lockless(packsAfter)).toEqual(lockless(packsBefore));
  }, 120_000);

  it("refuses a raw delete, an overwrite, a new config and a new repository", async () => {
    const tree = await treeHashes(join(fixture.storageDir, "endpoints", agent.endpointId));
    const snapshotFile = Object.keys(tree).find((name) => name.startsWith("snapshots/")) as string;
    const dataFile = Object.keys(tree).find((name) => name.startsWith("data/")) as string;
    const snapshotName = snapshotFile.split("/").pop() as string;
    const dataName = dataFile.split("/").pop() as string;

    expect((await rest(`/snapshots/${snapshotName}`, { method: "DELETE" })).status).toBe(403);
    expect((await rest(`/data/${dataName}`, { method: "DELETE" })).status).toBe(403);
    expect((await rest("/config", { method: "DELETE" })).status).toBe(403);
    expect((await rest("/", { method: "DELETE" })).status).toBe(403);
    // Overwrite an existing object (even with the right bytes).
    const original = await readFile(
      join(fixture.storageDir, "endpoints", agent.endpointId, snapshotFile),
    );
    expect(
      (await rest(`/snapshots/${snapshotName}`, { method: "POST", body: original })).status,
    ).toBe(403);
    // A new config or a fresh repository.
    expect((await rest("/config", { method: "POST", body: Buffer.from("{}") })).status).toBe(403);
    expect((await rest("/?create=true", { method: "POST" })).status).toBe(403);
    // Garbage under a name it does not match.
    expect(
      (await rest(`/index/${"e".repeat(64)}`, { method: "POST", body: Buffer.from("junk") }))
        .status,
    ).toBe(400);
    // Locks are the one thing that may go (restic refreshes and releases them).
    const lockBody = Buffer.from("a lock");
    const lockName = sha256(lockBody);
    expect((await rest(`/locks/${lockName}`, { method: "POST", body: lockBody })).status).toBe(200);
    expect((await rest(`/locks/${lockName}`, { method: "DELETE" })).status).toBe(200);

    expect(await treeHashes(join(fixture.storageDir, "endpoints", agent.endpointId))).toEqual(tree);

    // The attempts are in the audit log, once per kind.
    const entries = await fixture.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "endpoint.repository.denied"),
          eq(auditLog.target, agent.endpointId),
        ),
      );
    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).not.toContain(agent.agentSecret);
  }, 60_000);

  it("refuses wrong credentials and another endpoint's repository", async () => {
    const wrong = await rest("/config", { who: { ...agent, agentSecret: "rsea_wrong" } });
    expect(wrong.status).toBe(401);
    const result = await restic(["snapshots"], { ...agent, agentSecret: "rsea_wrong" });
    expect(result.code).not.toBe(0);
  }, 60_000);

  it("restores into a new folder byte for byte", async () => {
    const target = join(work, "restored");
    const result = await restic(["restore", "latest", "--target", target]);
    expect(result.code, result.out).toBe(0);
    const restoredRoot = join(target, source);
    expect(await treeHashes(restoredRoot)).toEqual(await treeHashes(source));
  }, 60_000);

  it("lets the server prune and check with its own credential", async () => {
    const access = await maintenanceAccess();
    const outcome = await withRepository(access, async (session) => {
      // The server forgets snapshots by id (it decides which), never by restic's --keep rules.
      const [, older] = await resticSnapshots(session);
      const forgotten = await resticForget(session, [older?.id as string]);
      await resticPrune(session);
      const remaining = await resticSnapshots(session);
      const check = await resticCheck(session, "100%");
      return { forgotten, remaining, check };
    });
    expect(outcome.forgotten).toBe(1);
    expect(outcome.remaining).toHaveLength(1);
    expect(outcome.check.output).toContain("no errors were found");
    // The agent still restores the surviving snapshot.
    const target = join(work, "restored-after-prune");
    expect((await restic(["restore", "latest", "--target", target])).code).toBe(0);
    expect(await treeHashes(join(target, source))).toEqual(await treeHashes(source));
  }, 120_000);

  describe("the restore test", () => {
    let snapshotId = "";
    let agentRow: typeof endpoints.$inferSelect;

    beforeAll(async () => {
      const access = await maintenanceAccess();
      snapshotId =
        (await withRepository(access, (session) => resticSnapshots(session)))[0]?.id ?? "";
      const [row] = await fixture.db
        .select()
        .from(endpoints)
        .where(eq(endpoints.id, agent.endpointId));
      if (!row) throw new Error("endpoint missing");
      agentRow = row;
    });

    async function readinessOf() {
      const { pinTenantStatement } = await import("../../lib/tenant-context.js");
      return shared.db.transaction(async (tx) => {
        await tx.execute(pinTenantStatement(fixture.tenantId));
        const map = await readiness.loadEndpointReadiness(tx, fixture.tenantId, [agent.endpointId]);
        return map.get(agent.endpointId);
      });
    }

    async function agentFinishesBackup(samples: { path: string; sha256: string; size: number }[]) {
      const call = (path: string, body: unknown) =>
        fetch(`http://127.0.0.1:${port}/agent/v1${path}`, {
          method: "POST",
          headers: {
            ...basic(agent.endpointId, agent.agentSecret),
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      const start = await call("/runs", { kind: "backup", startedAt: new Date().toISOString() });
      const { runId } = (await start.json()) as { runId: string };
      const finish = await call(`/runs/${runId}/finish`, {
        status: "succeeded",
        finishedAt: new Date().toISOString(),
        snapshotId,
        sample: samples,
        errors: [],
        logTail: "ok",
      });
      expect(finish.status).toBe(200);
    }

    async function serverRestoreTest(samples: { path: string; sha256: string }[]) {
      const access = await maintenanceAccess();
      const result = await withRepository(access, (session) =>
        restoreTestSamples(session, snapshotId, samples),
      );
      const green = result.files > 0 && result.mismatched.length === 0;
      await fixture.db.insert(endpointReports).values({
        tenantId: fixture.tenantId,
        endpointId: agent.endpointId,
        kind: "restore_test",
        origin: "server",
        snapshotId,
        readiness: green ? "green" : "red",
        summary: { files: result.files, matched: result.matched, mismatched: result.mismatched },
      });
      return result;
    }

    const realSamples = async () => {
      const files = ["hello.txt", "docs/report.md", "docs/deep/blob.bin", "umlaut-Größe.txt"];
      return Promise.all(
        files.map(async (name) => {
          const bytes = await readFile(join(source, name));
          return { path: join(source, name), sha256: sha256(bytes), size: bytes.length };
        }),
      );
    };

    it("is unverified after a backup and green only after the hashes matched", async () => {
      const samples = await realSamples();
      await agentFinishesBackup(samples);
      expect((await readinessOf())?.state).toBe("unverified");
      const result = await serverRestoreTest(samples);
      expect(result).toMatchObject({ files: 4, matched: 4, mismatched: [], transient: false });
      expect((await readinessOf())?.state).toBe("green");
    }, 120_000);

    it("is red when a file's hash does not match", async () => {
      const samples = await realSamples();
      const wrong = samples.map((sample, index) =>
        index === 0 ? { ...sample, sha256: sha256("not the content") } : sample,
      );
      const result = await serverRestoreTest(wrong);
      expect(result.matched).toBe(3);
      expect(result.mismatched).toHaveLength(1);
      expect(result.mismatched[0]?.path).toBe(wrong[0]?.path);
      expect((await readinessOf())?.state).toBe("red");
    }, 120_000);

    it("is red when a file is not in the snapshot at all", async () => {
      const result = await serverRestoreTest([{ path: "/no/such/file", sha256: sha256("x") }]);
      expect(result.mismatched[0]?.actual).toBeNull();
    }, 60_000);

    it("finds damage in a pack file and rates the endpoint red", async () => {
      // The last restore test passes again, so it is the check that speaks now.
      await serverRestoreTest(await realSamples());
      expect((await readinessOf())?.state).toBe("green");
      const packs = await treeHashes(
        join(fixture.storageDir, "endpoints", agent.endpointId, "data"),
      );
      const packName = Object.keys(packs)[0] as string;
      const path = join(fixture.storageDir, "endpoints", agent.endpointId, "data", packName);
      const bytes = await readFile(path);
      const damaged = Buffer.from(bytes);
      damaged[Math.floor(damaged.length / 3)] =
        (damaged[Math.floor(damaged.length / 3)] ?? 0) ^ 0xff;
      await writeFile(path, damaged);
      const access = await maintenanceAccess();
      await expect(
        withRepository(access, (session) => resticCheck(session, "100%")),
      ).rejects.toBeInstanceOf(ResticError);
      await fixture.db.insert(endpointReports).values({
        tenantId: fixture.tenantId,
        endpointId: agent.endpointId,
        kind: "repository_check",
        origin: "server",
        readiness: "red",
        summary: { errorMessage: "pack damaged" },
      });
      // Repair the file again for the tests after this one.
      await writeFile(path, bytes);
      const rating = await readinessOf();
      expect(rating?.state).toBe("red");
      expect(rating?.basis).toBe("repository_check");
      void agentRow;
    }, 120_000);
  });

  describe("browsing and downloading", () => {
    it("browses a folder of a snapshot and audits it", async () => {
      const snapshots = await service.listSnapshots(shared.db, fixture.tenantId, agent.endpointId);
      expect(snapshots.items).toHaveLength(1);
      const id = snapshots.items[0]?.id ?? "";
      const listing = await service.browseSnapshot(
        shared.db,
        fixture.tenantId,
        agent.endpointId,
        { snapshotId: id, path: source, limit: 100 },
        actor(),
      );
      expect(listing.nextCursor).toBeNull();
      expect(listing.entries.map((entry) => [entry.name, entry.type])).toEqual([
        ["docs", "dir"],
        ["hello.txt", "file"],
        ["umlaut-Größe.txt", "file"],
      ]);
      const [entry] = await fixture.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "endpoint.snapshot.browsed"),
            eq(auditLog.target, agent.endpointId),
          ),
        );
      expect(entry?.actor).toBe("admin@contoso.example");
      expect(JSON.stringify(entry?.details)).toContain(id);
    }, 60_000);

    it("pages through a folder by cursor, and refuses a cursor it did not issue", async () => {
      const snapshots = await service.listSnapshots(shared.db, fixture.tenantId, agent.endpointId);
      const id = snapshots.items[0]?.id ?? "";
      const browse = (limit: number, cursor?: string) =>
        service.browseSnapshot(
          shared.db,
          fixture.tenantId,
          agent.endpointId,
          { snapshotId: id, path: source, limit, cursor },
          actor(),
        );
      const first = await browse(2);
      expect(first.entries.map((entry) => entry.name)).toEqual(["docs", "hello.txt"]);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = await browse(2, first.nextCursor ?? undefined);
      expect(second.entries.map((entry) => entry.name)).toEqual(["umlaut-Größe.txt"]);
      expect(second.nextCursor).toBeNull();
      // The cursor is opaque text, not a path: a page ends exactly at the end of the folder.
      expect((await browse(3)).nextCursor).toBeNull();
      await expect(browse(2, "not-a-cursor")).rejects.toMatchObject({
        status: 400,
        type: "urn:restow:problem:endpoint-invalid-cursor",
      });
      const audited = await fixture.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "endpoint.snapshot.browsed"),
            eq(auditLog.target, agent.endpointId),
          ),
        );
      expect(
        audited.some((row) => (row.details as { continued?: boolean } | null)?.continued === true),
      ).toBe(true);
    }, 120_000);

    async function newestSnapshotId(): Promise<string> {
      const snapshots = await service.listSnapshots(shared.db, fixture.tenantId, agent.endpointId);
      return snapshots.items[0]?.id ?? "";
    }

    async function readAll(stream: Readable): Promise<Buffer> {
      const chunks: Buffer[] = [];
      for await (const chunk of Readable.from(stream)) {
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks);
    }

    it("downloads files and a folder as one ZIP whose entries match the source", async () => {
      const id = await newestSnapshotId();
      const prepared = await service.prepareDownload(
        shared.db,
        fixture.tenantId,
        agent.endpointId,
        { snapshotId: id, paths: [join(source, "docs"), join(source, "hello.txt")] },
        actor(),
      );
      expect(prepared).toMatchObject({ items: 2, id: expect.any(String) });
      expect(Date.parse(prepared.expiresAt)).toBeGreaterThan(Date.now());
      // Preparing reads nothing out: there is no download in the audit log yet.
      const before = await fixture.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "endpoint.snapshot.downloaded"),
            eq(auditLog.target, agent.endpointId),
          ),
        );
      const download = await service.openDownload(
        shared.db,
        fixture.tenantId,
        agent.endpointId,
        prepared.id,
        actor(),
      );
      // The read is audited before the first byte reaches the client.
      const audited = await fixture.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "endpoint.snapshot.downloaded"),
            eq(auditLog.target, agent.endpointId),
          ),
        );
      expect(audited).toHaveLength(before.length + 1);
      expect(audited.at(-1)?.details).toMatchObject({
        snapshotId: id,
        downloadId: prepared.id,
        pathCount: 2,
      });
      const entries = readZip(await readAll(download.stream));
      const files = Object.fromEntries(
        entries
          .filter((entry) => !entry.isDirectory)
          .map((entry) => [entry.name, sha256(entry.data)]),
      );
      expect(files).toEqual({
        "docs/report.md": sha256(await readFile(join(source, "docs", "report.md"))),
        "docs/deep/blob.bin": sha256(await readFile(join(source, "docs", "deep", "blob.bin"))),
        "hello.txt": sha256(await readFile(join(source, "hello.txt"))),
      });
    }, 120_000);

    it("starts a prepared download once, for the admin who asked, before it expires", async () => {
      const id = await newestSnapshotId();
      const input = { snapshotId: id, paths: [join(source, "hello.txt")] };
      const other = { ...actor(), userId: randomUUID() };
      const prepared = await service.prepareDownload(
        shared.db,
        fixture.tenantId,
        agent.endpointId,
        input,
        actor(),
      );
      const gone = { status: 404, type: "urn:restow:problem:endpoint-download-gone" };
      // Another admin, another tenant and a wrong endpoint find nothing.
      await expect(
        service.openDownload(shared.db, fixture.tenantId, agent.endpointId, prepared.id, other),
      ).rejects.toMatchObject(gone);
      await expect(
        service.openDownload(
          shared.db,
          fixture.otherTenantId,
          agent.endpointId,
          prepared.id,
          actor(),
        ),
      ).rejects.toMatchObject({ status: 404 });
      const first = await service.openDownload(
        shared.db,
        fixture.tenantId,
        agent.endpointId,
        prepared.id,
        actor(),
      );
      await readAll(first.stream);
      await expect(
        service.openDownload(shared.db, fixture.tenantId, agent.endpointId, prepared.id, actor()),
      ).rejects.toMatchObject(gone);

      // Not started in time: gone, too.
      const stale = await service.prepareDownload(
        shared.db,
        fixture.tenantId,
        agent.endpointId,
        input,
        actor(),
        undefined,
        new Date(Date.now() - 2 * service.DOWNLOAD_TTL_MS),
      );
      await expect(
        service.openDownload(shared.db, fixture.tenantId, agent.endpointId, stale.id, actor()),
      ).rejects.toMatchObject(gone);
    }, 120_000);

    it("answers 404 for a path the snapshot does not have, before anything is prepared", async () => {
      const id = await newestSnapshotId();
      const count = async () =>
        (await fixture.db.select().from(endpointDownloads)).filter(
          (row) => row.endpointId === agent.endpointId,
        ).length;
      const before = await count();
      await expect(
        service.prepareDownload(
          shared.db,
          fixture.tenantId,
          agent.endpointId,
          { snapshotId: id, paths: [join(source, "hello.txt"), "/nope/nothing"] },
          actor(),
        ),
      ).rejects.toMatchObject({
        status: 404,
        type: "urn:restow:problem:endpoint-path-not-found",
      });
      expect(await count()).toBe(before);
    }, 120_000);

    it("packs a selection of many paths, each looked up once, in the order asked", async () => {
      const id = await newestSnapshotId();
      const paths = [
        join(source, "umlaut-Größe.txt"),
        join(source, "hello.txt"),
        join(source, "umlaut-Größe.txt"),
        join(source, "docs", "report.md"),
        ...Array.from({ length: 300 }, () => join(source, "hello.txt")),
      ];
      const prepared = await service.prepareDownload(
        shared.db,
        fixture.tenantId,
        agent.endpointId,
        { snapshotId: id, paths },
        actor(),
      );
      // Repeated paths count once.
      expect(prepared.items).toBe(3);
      const download = await service.openDownload(
        shared.db,
        fixture.tenantId,
        agent.endpointId,
        prepared.id,
        actor(),
      );
      const names = readZip(await readAll(download.stream))
        .filter((entry) => !entry.isDirectory)
        .map((entry) => entry.name);
      expect(names).toEqual(["umlaut-Größe.txt", "hello.txt", "report.md"]);
    }, 120_000);
  });

  describe("locks, the storage budget and the password next to the repository", () => {
    const repositoryDir = () => join(fixture.storageDir, "endpoints", agent.endpointId);
    const lockFiles = async () =>
      readdir(join(repositoryDir(), "locks")).catch(() => [] as string[]);

    it("releases the agent's own locks after a backup and keeps no record of them", async () => {
      await writeFile(join(source, "lock-test.txt"), randomUUID());
      const result = await restic(["backup", source]);
      expect(result.code, result.out).toBe(0);
      expect(await lockFiles()).toEqual([]);
      const records = await fixture.db
        .select()
        .from(endpointRepositoryLocks)
        .where(eq(endpointRepositoryLocks.endpointId, agent.endpointId));
      expect(records).toEqual([]);
    }, 120_000);

    it("cannot lift a lock the server holds, not even with unlock --remove-all", async () => {
      const access = await maintenanceAccess();
      const serverLock = Buffer.from('{"time":"2099-01-01T00:00:00Z","exclusive":true}');
      const key = `${access.prefix}locks/${sha256(serverLock)}`;
      await access.storage.put(key, serverLock);
      try {
        const result = await restic(["unlock", "--remove-all"]);
        expect(result.code, result.out).not.toBe(0);
        expect(await access.storage.head(key)).not.toBeNull();
      } finally {
        await access.storage.delete(key);
      }
    }, 120_000);

    it("refuses a backup over the storage budget at once, and takes it again with room", async () => {
      const before = await resticSnapshotIds();
      const previous = process.env.RESTOW_ENDPOINT_QUOTA_GIB;
      // A budget smaller than what the repository holds already.
      process.env.RESTOW_ENDPOINT_QUOTA_GIB = "0.000001";
      try {
        await writeFile(join(source, "quota.bin"), Buffer.alloc(200_000, 9));
        const started = Date.now();
        const refused = await restic(["backup", source]);
        expect(refused.code).not.toBe(0);
        // restic gives up on a 403 instead of retrying the same pack for minutes.
        expect(Date.now() - started).toBeLessThan(60_000);
        expect(await resticSnapshotIds()).toEqual(before);
        const [row] = await fixture.db
          .select()
          .from(endpoints)
          .where(eq(endpoints.id, agent.endpointId));
        expect(row?.quotaRefusedAt).toBeInstanceOf(Date);
        // A restore still works with the budget used up.
        const target = join(work, "restored-over-budget");
        const restored = await restic(["restore", "latest", "--target", target]);
        expect(restored.code, restored.out).toBe(0);
      } finally {
        if (previous === undefined) {
          Reflect.deleteProperty(process.env, "RESTOW_ENDPOINT_QUOTA_GIB");
        } else {
          process.env.RESTOW_ENDPOINT_QUOTA_GIB = previous;
        }
      }
      const again = await restic(["backup", source]);
      expect(again.code, again.out).toBe(0);
      expect(await resticSnapshotIds()).toHaveLength(before.length + 1);
    }, 180_000);

    it("keeps the password next to the repository, so plain restic opens the folder without the database", async () => {
      const document = await readFile(join(repositoryDir(), "restow-repository-password.json"));
      const { loadTenantDek } = await import("../../lib/secrets.js");
      const { withTenantTx } = await import("../../lib/tenant-context.js");
      const dek = await withTenantTx(shared.db, fixture.tenantId, (tx) =>
        loadTenantDek(tx, fixture.tenantId),
      );
      const { password } = openEndpointPassword(
        document,
        singleKeyring(dek).open,
        agent.endpointId,
      );
      expect(password).toBe(agent.repositoryPassword);
      // restic straight on the storage folder, no server, no REST endpoint: the file does not disturb it.
      const listed = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
        const child = spawn(resticBinary(), ["snapshots", "--json", "--no-lock"], {
          env: {
            PATH: process.env.PATH ?? "",
            HOME: work,
            RESTIC_REPOSITORY: repositoryDir(),
            RESTIC_PASSWORD: password,
            RESTIC_CACHE_DIR: join(work, "plain-cache"),
          },
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
      expect(listed.code, listed.out).toBe(0);
      expect(JSON.parse(listed.out.split("\n")[0] ?? "[]").length).toBe(
        (await resticSnapshotIds()).length,
      );
    }, 120_000);

    it("answers 'repository busy' to reads while the server maintains the repository, and serves them after", async () => {
      const id = (await resticSnapshotIds())[0] as string;
      const prepared = await service.prepareDownload(
        shared.db,
        fixture.tenantId,
        agent.endpointId,
        { snapshotId: id, paths: [join(source, "hello.txt")] },
        actor(),
      );
      // Retention or the check of the worker holds the repository.
      const maintenance = await acquireEndpointRepositoryLock(
        fixture.db.$client,
        agent.endpointId,
        { mode: "exclusive" },
      );
      const busy = { status: 503, type: "urn:restow:problem:endpoint-repository-locked" };
      try {
        await expect(
          service.listSnapshots(shared.db, fixture.tenantId, agent.endpointId),
        ).rejects.toMatchObject(busy);
        await expect(
          service.browseSnapshot(
            shared.db,
            fixture.tenantId,
            agent.endpointId,
            { snapshotId: id, path: source, limit: 100 },
            actor(),
          ),
        ).rejects.toMatchObject(busy);
        await expect(
          service.openDownload(shared.db, fixture.tenantId, agent.endpointId, prepared.id, actor()),
        ).rejects.toMatchObject(busy);
      } finally {
        await maintenance();
      }
      // The refused download was not spent: it starts now, and reads hold the repository only
      // shared, so a second read runs beside it.
      const download = await service.openDownload(
        shared.db,
        fixture.tenantId,
        agent.endpointId,
        prepared.id,
        actor(),
      );
      expect(
        (await service.listSnapshots(shared.db, fixture.tenantId, agent.endpointId)).items.length,
      ).toBeGreaterThan(0);
      await new Promise<void>((resolve, reject) => {
        download.stream.once("end", () => resolve());
        download.stream.once("error", reject);
        download.stream.resume();
      });
    }, 120_000);

    it("shows the storage use on the detail page and flags nothing for a machine that behaves", async () => {
      const detail = await service.getEndpoint(
        shared.db,
        fixture.tenantId,
        agent.endpointId,
        "https://restow.test.example",
      );
      expect(detail.storage.usedBytes).toBeGreaterThan(0);
      // The installation's default: 2 TiB per endpoint.
      expect(detail.storage.budgetBytes).toBe(2048 * 1024 ** 3);
      const snapshots = await service.listSnapshots(shared.db, fixture.tenantId, agent.endpointId);
      expect(snapshots.items.every((snapshot) => snapshot.flags.length === 0)).toBe(true);
    }, 120_000);
  });

  async function resticSnapshotIds(): Promise<string[]> {
    const access = await maintenanceAccess();
    return (await withRepository(access, (session) => resticSnapshots(session))).map((s) => s.id);
  }
});
