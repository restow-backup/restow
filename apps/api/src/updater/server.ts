import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { Readable } from "node:stream";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { isAuthorized } from "./auth.js";
import { type DatabaseMover, MoveRefusedError } from "./database.js";
import { moveRequestSchema } from "./database-protocol.js";
import { type DumpStore, isDumpFileName } from "./dumps.js";
import { EngineError, type UpdateEngine } from "./engine.js";
import type { Logger } from "./logger.js";
import {
  MOUNTER_ENABLE_ANSWER_WAIT_MS,
  MounterEnableRefusedError,
  type MounterEnabler,
} from "./mounter-enable.js";
import type { Clock } from "./ops.js";
import type { Preflight } from "./preflight.js";
import {
  publicStatusOf,
  restartRequestSchema,
  type SelfUpdateView,
  type StateView,
  scheduleRequestSchema,
  type UpdaterError,
  type UpdaterErrorCode,
} from "./protocol.js";
import type { Redactor } from "./redact.js";
import { RestartRefusedError, type ServiceRestarter } from "./restart.js";

/**
 * The updater's HTTP API (JSON, internal Docker network only):
 *
 *   GET  /healthz            liveness, no authentication (container healthcheck)
 *   GET  /public/status      what a visitor may see (Caddy proxies it read-only)
 *   GET  /v1/state           the full state, `?refresh=1` recomputes the capabilities
 *   POST /v1/schedule        announce an update
 *   POST /v1/cancel          cancel a scheduled update
 *   POST /v1/acknowledge     clear a finished run
 *   POST /v1/mounter/enable  start the mounter (mounter-enable.ts); answers when the helper
 *                            finished (200) or after a minute with the start still running (202)
 *   POST /v1/restart         restart one application service: { service: "api" | "worker" | "scheduler" }
 *   POST /v1/database/check  check a directory for the database (database.ts): { targetDir, requestedBy }
 *   POST /v1/database/move   move the database there (202; the move runs in the background)
 *   POST /v1/database/old-copies/:id/remove   remove an old copy a move left: { requestedBy }
 *   GET  /v1/dumps/:file     download a pre-update dump (streamed)
 *   DELETE /v1/dumps/:file   delete a pre-update dump
 *
 * Everything under /v1 needs `Authorization: Bearer <shared secret>`. Errors are
 * `{ "code": "...", "message": "..." }`; nothing in a response carries the secret.
 */

const MAX_BODY_BYTES = 64 * 1024;

export interface ServerDeps {
  engine: UpdateEngine;
  preflight: Preflight;
  secret: string;
  clock: Clock;
  updaterVersion: string | null;
  logger: Logger;
  redactor: Redactor;
  /** The updater's own update (self-update.ts); null when this updater has none. */
  selfUpdate?: () => SelfUpdateView | null;
  /** Starting the mounter from the web interface (mounter-enable.ts); absent: not offered. */
  mounterEnable?: MounterEnabler;
  /** How long `POST /v1/mounter/enable` waits for the helper (tests shorten it). */
  mounterEnableWaitMs?: number;
  /** Restarts one application service on request (restart.ts); without it `/v1/restart` is not found. */
  restarter?: ServiceRestarter;
  /** The project directory on the host, for the commands the Updates tab shows. */
  projectDir?: string | null;
  /** The database location (database.ts); without it the routes are not found. */
  database?: DatabaseMover;
  /** The pre-update dumps, for download and deletion; without it the routes are not found. */
  dumps?: DumpStore;
}

const actorBodySchema = z
  .object({
    requestedBy: z.object({
      userId: z.string().nullable(),
      label: z.string(),
      ip: z.string().nullable(),
    }),
  })
  .strict();

const STATUS_OF: Record<UpdaterErrorCode, 401 | 404 | 409 | 422 | 500> = {
  unauthorized: 401,
  invalid_request: 422,
  not_newer: 422,
  source_not_allowed: 409,
  busy: 409,
  blocked: 409,
  running: 409,
  not_scheduled: 409,
  not_finished: 409,
  not_found: 404,
  internal: 500,
};

export function buildServer(deps: ServerDeps): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
  });

  const fail = (code: UpdaterErrorCode, message: string, extra: Partial<UpdaterError> = {}) => {
    const body: UpdaterError = { code, message, ...extra };
    return new Response(JSON.stringify(body), {
      status: STATUS_OF[code],
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...(code === "unauthorized" ? { "WWW-Authenticate": "Bearer" } : {}),
      },
    });
  };

  const stateView = async (refresh: boolean): Promise<StateView> => {
    const view = deps.engine.view();
    return {
      updaterVersion: deps.updaterVersion,
      phase: view.phase,
      run: view.run,
      history: view.history,
      events: view.events,
      capabilities: await deps.preflight.get(refresh),
      selfUpdate: deps.selfUpdate?.() ?? null,
      mounterEnable: deps.mounterEnable?.view() ?? null,
      restartableServices: [...(deps.restarter?.services ?? [])],
      restart: deps.restarter?.view() ?? null,
      projectDir: deps.projectDir ?? null,
      database: deps.database ? await deps.database.view(refresh) : null,
      serverTime: deps.clock.now().toISOString(),
    };
  };

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.get("/public/status", (c) => {
    const view = deps.engine.view();
    return c.json(
      publicStatusOf(view.run, view.phase, deps.clock.now(), deps.database?.publicMove() ?? null),
    );
  });

  app.use("/v1/*", async (c, next) => {
    if (!isAuthorized(c.req.header("authorization"), deps.secret)) {
      return fail("unauthorized", "A valid bearer secret is required.");
    }
    await next();
    return undefined;
  });

  app.get("/v1/state", async (c) => {
    const refresh = c.req.query("refresh");
    return c.json(await stateView(refresh === "1" || refresh === "true"));
  });

  /** The JSON body, bounded in size; a Response when it is unusable. */
  const readJson = async (c: Context): Promise<{ json: unknown } | Response> => {
    const declared = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return fail("invalid_request", "The request body is too large.");
    }
    const text = await c.req.text();
    if (text.length > MAX_BODY_BYTES) {
      return fail("invalid_request", "The request body is too large.");
    }
    try {
      return { json: JSON.parse(text) };
    } catch {
      return fail("invalid_request", "The request body is not valid JSON.");
    }
  };

  const invalid = (issues: readonly { path: readonly PropertyKey[]; message: string }[]) => {
    const summary = issues
      .slice(0, 5)
      .map((issue) => `${issue.path.map(String).join(".") || "body"}: ${issue.message}`)
      .join("; ");
    return fail("invalid_request", `The request is not valid: ${summary}`);
  };

  app.post("/v1/schedule", async (c) => {
    const body = await readJson(c);
    if (body instanceof Response) {
      return body;
    }
    const parsed = scheduleRequestSchema.safeParse(body.json);
    if (!parsed.success) {
      return invalid(parsed.error.issues);
    }
    try {
      await deps.engine.schedule(parsed.data);
    } catch (error) {
      if (error instanceof EngineError) {
        return fail(
          error.code,
          error.message,
          error.blockers.length > 0 ? { blockers: error.blockers } : {},
        );
      }
      throw error;
    }
    return c.json(await stateView(false), 202);
  });

  app.post("/v1/cancel", async (c) => {
    try {
      await deps.engine.cancel();
    } catch (error) {
      if (error instanceof EngineError) {
        return fail(error.code, error.message);
      }
      throw error;
    }
    return c.json(await stateView(false));
  });

  app.post("/v1/acknowledge", async (c) => {
    try {
      await deps.engine.acknowledge();
    } catch (error) {
      if (error instanceof EngineError) {
        return fail(error.code, error.message);
      }
      throw error;
    }
    return c.json(await stateView(false));
  });

  // Restart one application service, on an administrator's request: the allowlist is the
  // schema's enum, and the service name never reaches a command line unchecked (restart.ts).
  app.post("/v1/restart", async (c) => {
    const restarter = deps.restarter;
    if (!restarter) {
      return fail("not_found", "There is nothing at this path.");
    }
    const body = await readJson(c);
    if (body instanceof Response) {
      return body;
    }
    const parsed = restartRequestSchema.safeParse(body.json);
    if (!parsed.success) {
      return invalid(parsed.error.issues);
    }
    try {
      restarter.start(parsed.data.service);
    } catch (error) {
      if (error instanceof RestartRefusedError) {
        return fail(error.code, error.message);
      }
      throw error;
    }
    return c.json(await stateView(false), 202);
  });

  app.post("/v1/mounter/enable", async (c) => {
    const enabler = deps.mounterEnable;
    if (!enabler) {
      return fail("not_found", "This updater cannot start the mounter.");
    }
    let started: { done: Promise<void> };
    try {
      started = await enabler.start();
    } catch (error) {
      if (error instanceof MounterEnableRefusedError) {
        return fail(error.code, error.message);
      }
      throw error;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finished = await Promise.race([
      started.done.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(
          () => resolve(false),
          deps.mounterEnableWaitMs ?? MOUNTER_ENABLE_ANSWER_WAIT_MS,
        );
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    return c.json(await stateView(false), finished ? 200 : 202);
  });

  // -- The database location (database.ts, docs/DATABASE.md) -------------------

  const moveRefused = (error: MoveRefusedError) =>
    fail(error.code, error.message, error.problems.length > 0 ? { problems: error.problems } : {});

  app.post("/v1/database/check", async (c) => {
    const mover = deps.database;
    if (!mover) {
      return fail("not_found", "This updater cannot move the database.");
    }
    const body = await readJson(c);
    if (body instanceof Response) {
      return body;
    }
    const parsed = moveRequestSchema.safeParse(body.json);
    if (!parsed.success) {
      return invalid(parsed.error.issues);
    }
    return c.json(await mover.check(parsed.data.targetDir));
  });

  app.post("/v1/database/move", async (c) => {
    const mover = deps.database;
    if (!mover) {
      return fail("not_found", "This updater cannot move the database.");
    }
    const body = await readJson(c);
    if (body instanceof Response) {
      return body;
    }
    const parsed = moveRequestSchema.safeParse(body.json);
    if (!parsed.success) {
      return invalid(parsed.error.issues);
    }
    try {
      await mover.start(parsed.data);
    } catch (error) {
      if (error instanceof MoveRefusedError) {
        return moveRefused(error);
      }
      throw error;
    }
    return c.json(await stateView(false), 202);
  });

  app.post("/v1/database/old-copies/:id/remove", async (c) => {
    const mover = deps.database;
    if (!mover) {
      return fail("not_found", "This updater cannot move the database.");
    }
    const body = await readJson(c);
    if (body instanceof Response) {
      return body;
    }
    const parsed = actorBodySchema.safeParse(body.json);
    if (!parsed.success) {
      return invalid(parsed.error.issues);
    }
    try {
      await mover.removeOldCopy(c.req.param("id"), parsed.data.requestedBy);
    } catch (error) {
      if (error instanceof MoveRefusedError) {
        return moveRefused(error);
      }
      throw error;
    }
    return c.json(await stateView(false), 202);
  });

  // -- Pre-update dumps -------------------------------------------------------

  /** The dump a `needs_attention` run still refers to: the operator restores from it. */
  const protectedDump = (): string | null =>
    deps.engine.view().history[0]?.recovery?.dumpFile ?? null;

  app.get("/v1/dumps/:file", async (c) => {
    const dumps = deps.dumps;
    const name = c.req.param("file");
    if (!dumps || !isDumpFileName(name)) {
      return fail("not_found", "There is no such dump.");
    }
    const file = dumps.pathOf(name);
    let size: number;
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) {
        return fail("not_found", "There is no such dump.");
      }
      size = stat.size;
    } catch {
      return fail("not_found", "There is no such dump.");
    }
    const stream = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(size),
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  app.delete("/v1/dumps/:file", async (c) => {
    const dumps = deps.dumps;
    const name = c.req.param("file");
    if (!dumps || !isDumpFileName(name)) {
      return fail("not_found", "There is no such dump.");
    }
    const { phase } = deps.engine.view();
    if (phase === "scheduled" || phase === "running") {
      return fail("busy", "An update is announced or running; delete dumps after it.");
    }
    if (protectedDump() === name) {
      return fail(
        "blocked",
        "The last update needs this dump to restore the database (it ended needing attention).",
      );
    }
    if (!(await dumps.remove(name))) {
      return fail("not_found", "There is no such dump.");
    }
    deps.preflight.invalidate();
    deps.logger.info(`The dump ${name} was deleted, as an administrator asked.`);
    return c.json(await stateView(false));
  });

  app.notFound(() => fail("not_found", "There is nothing at this path."));

  app.onError((error) => {
    deps.logger.error(`Request failed: ${deps.redactor.oneLine(error.message, 500)}`);
    return fail("internal", "The updater could not handle the request.");
  });

  return app;
}
