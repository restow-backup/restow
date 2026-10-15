import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMoverWorld, MOVE_ACTOR, type MoverWorld, TARGET_DIR } from "./database-testing.js";
import { dumpFileName } from "./dumps.js";
import { publicStatusSchema, stateViewSchema } from "./protocol.js";
import { buildServer } from "./server.js";
import { createHarness, type Harness } from "./testing.js";

const SECRET = "e".repeat(64);
const auth = { Authorization: `Bearer ${SECRET}` };
let h: Harness;
let w: MoverWorld;
let app: ReturnType<typeof buildServer>;

beforeEach(async () => {
  h = await createHarness();
  h.redactor.add(SECRET);
  w = createMoverWorld(h);
  app = buildServer({
    engine: h.engine,
    preflight: h.preflight,
    secret: SECRET,
    clock: h.clock,
    updaterVersion: "0.4.0",
    logger: h.logger,
    redactor: h.redactor,
    database: w.mover,
    dumps: h.dumps,
  });
});

afterEach(async () => {
  await w.mover.settled();
  await h.cleanup();
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = auth,
) {
  const response = await app.request(path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response;
}

async function writeDump(at: string): Promise<string> {
  await h.dumps.ensureDirectory();
  const name = dumpFileName(new Date(at), "0.1.0", "0.2.0");
  await fs.writeFile(
    h.dumps.pathOf(name),
    Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(4096, 1)]),
  );
  return name;
}

describe("the database routes", () => {
  it.each([
    ["POST", "/v1/database/check"],
    ["POST", "/v1/database/move"],
    ["POST", "/v1/database/old-copies/c-1/remove"],
    ["GET", "/v1/dumps/restow-20260930-100000-0.1.0-to-0.2.0.dump"],
    ["DELETE", "/v1/dumps/restow-20260930-100000-0.1.0-to-0.2.0.dump"],
  ])("%s %s needs the bearer secret", async (method, path) => {
    const response = await call(method, path, method === "POST" ? {} : undefined, {});
    expect(response.status).toBe(401);
  });

  it("the state carries the database view", async () => {
    const response = await call("GET", "/v1/state?refresh=1");
    const view = stateViewSchema.parse(await response.json());
    expect(view.database).toMatchObject({
      location: { kind: "volume", source: "restow_pgdata" },
      movable: true,
      move: null,
    });
  });

  it("checks a directory", async () => {
    const response = await call("POST", "/v1/database/check", {
      targetDir: "/mnt/nowhere",
      requestedBy: MOVE_ACTOR,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: false,
      problems: [{ code: "path_missing" }],
    });
  });

  it("refuses a malformed request", async () => {
    const response = await call("POST", "/v1/database/move", { targetDir: TARGET_DIR });
    expect(response.status).toBe(422);
  });

  it("refuses a move that does not pass the checks, with the problems", async () => {
    (w.database.targets.get(TARGET_DIR) as { sameFilesystem: boolean }).sameFilesystem = true;
    const response = await call("POST", "/v1/database/move", {
      targetDir: TARGET_DIR,
      requestedBy: MOVE_ACTOR,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "blocked",
      problems: [{ code: "same_filesystem" }],
    });
  });

  it("starts a move and reports it in the public status, without paths", async () => {
    const response = await call("POST", "/v1/database/move", {
      targetDir: TARGET_DIR,
      requestedBy: MOVE_ACTOR,
    });
    expect(response.status).toBe(202);
    await w.mover.settled();
    const status = publicStatusSchema.parse(
      await (await call("GET", "/public/status", undefined, {})).json(),
    );
    expect(status.databaseMove).toMatchObject({ status: "succeeded", progress: 100 });
    const text = JSON.stringify(status);
    expect(text).not.toContain("/mnt");
    expect(text).not.toContain("owner@example.com");
  });

  it("removes an old copy", async () => {
    await call("POST", "/v1/database/move", { targetDir: TARGET_DIR, requestedBy: MOVE_ACTOR });
    await w.mover.settled();
    const id = w.store.state.database?.oldCopies[0]?.id as string;
    const response = await call("POST", `/v1/database/old-copies/${id}/remove`, {
      requestedBy: MOVE_ACTOR,
    });
    expect(response.status).toBe(202);
    await w.mover.settled();
    expect(w.store.state.database?.oldCopies).toEqual([]);
    const missing = await call("POST", "/v1/database/old-copies/c-404/remove", {
      requestedBy: MOVE_ACTOR,
    });
    expect(missing.status).toBe(404);
  });
});

describe("the dump routes", () => {
  it("stream a dump as a download", async () => {
    const name = await writeDump("2026-09-30T10:00:00Z");
    const response = await call("GET", `/v1/dumps/${name}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-length")).toBe("4101");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${name}"`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.subarray(0, 5).toString()).toBe("PGDMP");
    expect(body.length).toBe(4101);
  });

  it.each([["../status.json"], ["status.json"], ["restow-20260930-100000-0.1.0-to-0.2.0.dump"]])(
    "answer 404 for %s",
    async (name) => {
      const response = await call("GET", `/v1/dumps/${encodeURIComponent(name)}`);
      expect(response.status).toBe(404);
    },
  );

  it("delete a dump", async () => {
    const name = await writeDump("2026-09-30T10:00:00Z");
    const response = await call("DELETE", `/v1/dumps/${name}`);
    expect(response.status).toBe(200);
    expect(await h.dumps.list()).toEqual([]);
    expect((await call("DELETE", `/v1/dumps/${name}`)).status).toBe(404);
  });

  it("keep the dump a failed update needs for its recovery", async () => {
    const name = await writeDump("2026-09-30T10:00:00Z");
    h.store.state.history = [
      {
        id: "r-1",
        mode: "image",
        switchTo: null,
        fromVersion: "0.1.0",
        targetVersion: "0.2.0",
        targetTag: "v0.2.0",
        releaseUrl: null,
        requestedBy: MOVE_ACTOR,
        scheduledAt: "2026-09-30T10:00:00.000Z",
        leadSeconds: 0,
        startsAt: "2026-09-30T10:00:00.000Z",
        startedAt: "2026-09-30T10:00:00.000Z",
        finishedAt: "2026-09-30T10:05:00.000Z",
        cancelledAt: null,
        outcome: "needs_attention",
        step: "health",
        steps: [],
        progress: 80,
        message: null,
        failure: null,
        recovery: {
          dumpFile: name,
          dumpBytes: 4101,
          fromVersion: "0.1.0",
          previousImages: { app: null, web: null },
        },
        images: { app: null, web: null },
        digestVerified: null,
        signatureVerified: null,
        cancelled: false,
      },
    ];
    const response = await call("DELETE", `/v1/dumps/${name}`);
    expect(response.status).toBe(409);
    expect(await h.dumps.list()).toHaveLength(1);
  });
});
