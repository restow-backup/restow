import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { LocalStorageBackend, resticBinary } from "@restow/core";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../../problem.js";
import {
  FILE_SHARE_QUOTA_PROBLEM,
  FILE_SHARE_RESTIC_PATH,
  MemoryRunCredentials,
  buildFileShareResticRoutes,
  fileShareRepositoryPrefix,
} from "./restic-route.js";

/**
 * The runners' restic endpoint (docs/FILESHARES.md 5.3) without a database: the run
 * credentials in memory (Phase A), the tenant's storage a temp folder. With restic
 * available (RESTIC_BINARY, else the PATH) a real restic backs up through it as an
 * append-only runner and restores through it as a read-only one.
 */

const TENANT = "11111111-1111-4111-8111-111111111111";
const SHARE_A = "5b0c6f0e-9f5c-4c8a-9d55-1a2b3c4d5e6f";
const SHARE_B = "6b0c6f0e-9f5c-4c8a-9d55-1a2b3c4d5e70";
const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz0123456789ABCD";

let root: string;
let credentials: MemoryRunCredentials;
let denied: Record<string, unknown>[];
let remaining: number | null;
let app: Hono;

function issue(
  kind: "backup" | "restore",
  overrides: Partial<{
    status: string;
    expiresAt: Date;
    tenantActive: boolean;
    repositoryShareId: string;
  }> = {},
) {
  const runId = randomUUID();
  credentials.issue({
    runId,
    tenantId: TENANT,
    kind,
    status: "running",
    tenantActive: true,
    expiresAt: new Date(Date.now() + 3600_000),
    repositoryShareId: SHARE_A,
    token: TOKEN,
    ...(overrides as object),
  });
  return runId;
}

const basic = (runId: string, token = TOKEN) =>
  `Basic ${Buffer.from(`${runId}:${token}`).toString("base64")}`;
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "share-restic-"));
  credentials = new MemoryRunCredentials();
  denied = [];
  remaining = null;
  const routes = buildFileShareResticRoutes({
    credentials,
    storageOf: async () => new LocalStorageBackend(root),
    remainingBytes: async () => remaining,
    onDenied: (_access, _shareId, details) => denied.push(details),
  });
  app = new Hono();
  app.onError(errorHandler);
  app.route(FILE_SHARE_RESTIC_PATH, routes);
});

async function call(
  method: string,
  path: string,
  init: { auth?: string; body?: string; headers?: Record<string, string> } = {},
) {
  return app.request(`${FILE_SHARE_RESTIC_PATH}${path}`, {
    method,
    headers: { ...(init.auth ? { authorization: init.auth } : {}), ...(init.headers ?? {}) },
    body: init.body,
  });
}

describe("file share restic route", () => {
  it("refuses requests without, with a wrong or with a foreign credential", async () => {
    const runId = issue("backup");
    expect((await call("GET", `/${SHARE_A}/config`)).status).toBe(401);
    expect(
      (await call("GET", `/${SHARE_A}/config`, { auth: basic(runId, "x".repeat(43)) })).status,
    ).toBe(401);
    expect((await call("GET", `/${SHARE_A}/config`, { auth: basic(randomUUID()) })).status).toBe(
      401,
    );
    // A credential is valid for its own repository only.
    const other = await call("GET", `/${SHARE_B}/config`, { auth: basic(runId) });
    expect(other.status).toBe(401);
    expect(other.headers.get("www-authenticate")).toBe('Basic realm="restow-share"');
    expect((await call("GET", "/not-a-uuid/config", { auth: basic(runId) })).status).toBe(401);
  });

  it("refuses a credential whose run ended, expired or whose tenant is not active", async () => {
    for (const overrides of [
      { status: "succeeded" },
      { status: "queued" },
      { expiresAt: new Date(Date.now() - 1000) },
      { tenantActive: false },
    ]) {
      const runId = issue("backup", overrides);
      const response = await call("GET", `/${SHARE_A}/config`, { auth: basic(runId) });
      expect(response.status, JSON.stringify(overrides)).toBe(401);
      expect(((await response.json()) as { title: string }).title).toBe("Credential expired");
    }
    const runId = issue("backup");
    credentials.end(runId);
    expect((await call("GET", `/${SHARE_A}/config`, { auth: basic(runId) })).status).toBe(401);
  });

  it("is not there for a request that came through a proxy", async () => {
    const runId = issue("backup");
    for (const header of ["x-forwarded-for", "forwarded", "via"]) {
      const response = await call("GET", `/${SHARE_A}/config`, {
        auth: basic(runId),
        headers: { [header]: "203.0.113.9" },
      });
      expect(response.status, header).toBe(404);
    }
  });

  it("gives a backup run the append-only principal on its own repository", async () => {
    const runId = issue("backup");
    const pack = "pack-content";
    const put = await call("POST", `/${SHARE_A}/data/${sha256(pack)}`, {
      auth: basic(runId),
      body: pack,
    });
    expect(put.status).toBe(200);
    const stored = await readFile(
      join(
        root,
        fileShareRepositoryPrefix(SHARE_A),
        "data",
        sha256(pack).slice(0, 2),
        sha256(pack),
      ),
      "utf8",
    );
    expect(stored).toBe(pack);
    expect(
      (await call("POST", `/${SHARE_A}/data/${sha256(pack)}`, { auth: basic(runId), body: pack }))
        .status,
    ).toBe(403);
    expect(
      (await call("DELETE", `/${SHARE_A}/data/${sha256(pack)}`, { auth: basic(runId) })).status,
    ).toBe(403);
    expect(denied.map((d) => d.reason)).toEqual(["exists", "not_allowed"]);
  });

  it("gives a restore run the read-only principal: no write, not even a lock", async () => {
    const backup = issue("backup");
    const pack = "pack";
    await call("POST", `/${SHARE_A}/data/${sha256(pack)}`, { auth: basic(backup), body: pack });
    const restore = issue("restore");
    expect(
      (await call("GET", `/${SHARE_A}/data/${sha256(pack)}`, { auth: basic(restore) })).status,
    ).toBe(200);
    const lock = "lock";
    expect(
      (
        await call("POST", `/${SHARE_A}/locks/${sha256(lock)}`, {
          auth: basic(restore),
          body: lock,
        })
      ).status,
    ).toBe(403);
    expect(
      (await call("POST", `/${SHARE_A}/data/${sha256("x")}`, { auth: basic(restore), body: "x" }))
        .status,
    ).toBe(403);
  });

  it("refuses an upload over the budget with the file share problem type", async () => {
    const runId = issue("backup");
    remaining = 2;
    const response = await call("POST", `/${SHARE_A}/data/${sha256("too large")}`, {
      auth: basic(runId),
      body: "too large",
      headers: { "content-length": "9" },
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { type: string }).type).toBe(FILE_SHARE_QUOTA_PROBLEM.type);
  });
});

function haveRestic(): boolean {
  return spawnSync(resticBinary(), ["version"]).status === 0;
}

describe.runIf(haveRestic())("file share restic route with the real restic", () => {
  let server: ReturnType<typeof serve>;
  let base: string;

  beforeAll(async () => {
    server = serve({ fetch: (request) => app.fetch(request), port: 0, hostname: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  function restic(args: string[], env: Record<string, string>) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(resticBinary(), args, {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: root,
          RESTIC_PASSWORD: "repo-password",
          RESTIC_CACHE_DIR: join(root, "cache"),
          ...env,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }

  it("backs up as an append-only runner and restores as a read-only one", async () => {
    const repoDir = join(root, fileShareRepositoryPrefix(SHARE_A));
    await mkdir(repoDir, { recursive: true });
    expect((await restic(["init", "--repo", repoDir], {})).code).toBe(0);
    const share = join(root, "share");
    await mkdir(join(share, "Finance"), { recursive: true });
    await writeFile(join(share, "Finance", "Q3.xlsx"), "quarter three");

    const backupRun = issue("backup");
    const repo = `rest:${base}${FILE_SHARE_RESTIC_PATH}/${SHARE_A}/`;
    const backup = await restic(["backup", "--json", "--host", "restow-share", share], {
      RESTIC_REPOSITORY: repo,
      RESTIC_REST_USERNAME: backupRun,
      RESTIC_REST_PASSWORD: TOKEN,
    });
    expect(backup.code, backup.stderr).toBe(0);
    // The append-only runner cannot forget a snapshot.
    const snapshotId = (
      JSON.parse(backup.stdout.trim().split("\n").pop() as string) as { snapshot_id: string }
    ).snapshot_id;
    const forget = await restic(["forget", snapshotId], {
      RESTIC_REPOSITORY: repo,
      RESTIC_REST_USERNAME: backupRun,
      RESTIC_REST_PASSWORD: TOKEN,
    });
    expect(forget.code).not.toBe(0);
    credentials.end(backupRun);

    const restoreRun = issue("restore");
    const target = join(root, "target");
    const restore = await restic(["restore", `latest:${share}`, "--target", target, "--no-lock"], {
      RESTIC_REPOSITORY: repo,
      RESTIC_REST_USERNAME: restoreRun,
      RESTIC_REST_PASSWORD: TOKEN,
    });
    expect(restore.code, restore.stderr).toBe(0);
    expect(await readFile(join(target, "Finance", "Q3.xlsx"), "utf8")).toBe("quarter three");
    // Without --no-lock the reader is refused: it may not even write a lock.
    const locked = await restic(["snapshots"], {
      RESTIC_REPOSITORY: repo,
      RESTIC_REST_USERNAME: restoreRun,
      RESTIC_REST_PASSWORD: TOKEN,
    });
    expect(locked.code).not.toBe(0);
    // The ended backup credential is dead.
    const dead = await restic(["snapshots", "--no-lock"], {
      RESTIC_REPOSITORY: repo,
      RESTIC_REST_USERNAME: backupRun,
      RESTIC_REST_PASSWORD: TOKEN,
    });
    expect(dead.code).not.toBe(0);
    await rm(root, { recursive: true, force: true });
  }, 60_000);
});
