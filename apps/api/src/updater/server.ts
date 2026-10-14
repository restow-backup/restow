import { type Context, Hono } from "hono";
import { isAuthorized } from "./auth.js";
import { EngineError, type UpdateEngine } from "./engine.js";
import type { Logger } from "./logger.js";
import type { Clock } from "./ops.js";
import type { Preflight } from "./preflight.js";
import {
  type SelfUpdateView,
  type StateView,
  type UpdaterError,
  type UpdaterErrorCode,
  publicStatusOf,
  restartRequestSchema,
  scheduleRequestSchema,
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
 *   POST /v1/restart         restart one application service: { service: "api" | "worker" | "scheduler" }
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
  /** Restarts one application service on request (restart.ts); without it `/v1/restart` is not found. */
  restarter?: ServiceRestarter;
  /** The project directory on the host, for the commands the Updates tab shows. */
  projectDir?: string | null;
}

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
      restartableServices: [...(deps.restarter?.services ?? [])],
      restart: deps.restarter?.view() ?? null,
      projectDir: deps.projectDir ?? null,
      serverTime: deps.clock.now().toISOString(),
    };
  };

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.get("/public/status", (c) => {
    const view = deps.engine.view();
    return c.json(publicStatusOf(view.run, view.phase, deps.clock.now()));
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

  const invalid = (issues: readonly { path: (string | number)[]; message: string }[]) => {
    const summary = issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
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

  app.notFound(() => fail("not_found", "There is nothing at this path."));

  app.onError((error) => {
    deps.logger.error(`Request failed: ${deps.redactor.oneLine(error.message, 500)}`);
    return fail("internal", "The updater could not handle the request.");
  });

  return app;
}
