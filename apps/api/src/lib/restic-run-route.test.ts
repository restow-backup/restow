import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageBackend } from "@restow/core";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../problem.js";
import {
  type CredentialFailures,
  type RunResticResolution,
  buildRunResticRoute,
  processLocalLocks,
} from "./restic-run-route.js";

const RUN = "0f1e2d3c-4b5a-4968-8776-655443322110";
const REPO = "5b0c6f0e-9f5c-4c8a-9d55-1a2b3c4d5e6f";
const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

class CountingFailures implements CredentialFailures {
  counts = new Map<string, number>();
  isBlocked(key: string): boolean {
    return (this.counts.get(key) ?? 0) >= 3;
  }
  record(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
}

let failures: CountingFailures;
let resolution: RunResticResolution | null;
let seen: { runId: string; token: string; repoId: string }[];
let audits: unknown[];
let app: Hono;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "run-route-"));
  failures = new CountingFailures();
  seen = [];
  audits = [];
  resolution = {
    ok: true,
    access: {
      tenantId: "t1",
      runId: RUN,
      principal: "agent",
      prefix: `repos/${REPO}/`,
      storage: new LocalStorageBackend(root),
    },
  };
  const locks = processLocalLocks();
  app = new Hono();
  app.onError(errorHandler);
  app.route(
    "/agent/x/restic",
    buildRunResticRoute({
      basePath: "/agent/x/restic",
      param: "guestId",
      realm: "restow-test",
      resolve: async (credentials, repoId) => {
        seen.push({ ...credentials, repoId });
        return resolution as RunResticResolution;
      },
      locks: (access) => locks(access.runId),
      failures,
      audit: (_access, repoId, denial) => audits.push({ repoId, ...denial }),
    }),
  );
});

const auth = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

function call(method: string, path: string, headers: Record<string, string> = {}, body?: string) {
  return app.request(`/agent/x/restic${path}`, {
    method,
    headers: { authorization: auth(RUN, "token"), "x-real-ip": "198.51.100.7", ...headers },
    body,
  });
}

describe("run-scoped restic route builder", () => {
  it("resolves the credential for the repository in the path and serves the protocol below it", async () => {
    const lock = "lock";
    const response = await call("POST", `/${REPO}/locks/${sha256(lock)}`, {}, lock);
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ runId: RUN, token: "token", repoId: REPO }]);
    // The run's own lock may be released again (process-local registry).
    expect((await call("DELETE", `/${REPO}/locks/${sha256(lock)}`)).status).toBe(200);
  });

  it("answers 401 with the realm and counts an invalid credential, but not an expired one", async () => {
    resolution = { ok: false, reason: "invalid" };
    const invalid = await call("GET", `/${REPO}/config`);
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toBe('Basic realm="restow-test"');
    expect(failures.counts.get("198.51.100.7")).toBe(1);
    resolution = { ok: false, reason: "expired" };
    const expired = await call("GET", `/${REPO}/config`);
    expect(expired.status).toBe(401);
    expect(((await expired.json()) as { title: string }).title).toBe("Credential expired");
    expect(failures.counts.get("198.51.100.7")).toBe(1);
  });

  it("never asks the feature about malformed credentials or repositories, and rate-limits", async () => {
    expect(
      (await call("GET", `/${REPO}/config`, { authorization: auth("not-a-uuid", "x") })).status,
    ).toBe(401);
    expect((await call("GET", "/not-a-uuid/config")).status).toBe(401);
    expect((await call("GET", `/${REPO}/config`, { authorization: "Bearer x" })).status).toBe(401);
    expect(seen).toEqual([]);
    expect((await call("GET", `/${REPO}/config`)).status).toBe(429);
  });

  it("audits what the authorization matrix refuses", async () => {
    expect((await call("DELETE", `/${REPO}/data/${sha256("x")}`)).status).toBe(403);
    expect(audits).toEqual([
      {
        repoId: REPO,
        action: "delete",
        type: "data",
        reason: "not_allowed",
        method: "DELETE",
        ip: "198.51.100.7",
      },
    ]);
  });

  it("serves proxied requests unless the route is internal", async () => {
    const lock = "proxied";
    const proxied = await call(
      "POST",
      `/${REPO}/locks/${sha256(lock)}`,
      { "x-forwarded-for": "203.0.113.1" },
      lock,
    );
    expect(proxied.status).toBe(200);
    const internal = new Hono();
    internal.route(
      "/internal/r",
      buildRunResticRoute({
        basePath: "/internal/r",
        param: "shareId",
        realm: "r",
        internalOnly: true,
        resolve: async () => resolution as RunResticResolution,
        locks: () => processLocalLocks()(RUN),
        failures,
        audit: () => undefined,
      }),
    );
    for (const header of ["x-forwarded-for", "forwarded", "via", "x-forwarded-host"]) {
      const response = await internal.request(`/internal/r/${REPO}/config`, {
        headers: { authorization: auth(RUN, "token"), [header]: "x" },
      });
      expect(response.status, header).toBe(404);
    }
  });
});
