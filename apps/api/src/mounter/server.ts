import { Hono } from "hono";
import type { z } from "zod";
import { isAuthorized } from "../updater/auth.js";
import type { Logger } from "../updater/logger.js";
import type { Clock } from "../updater/ops.js";
import type { Redactor } from "../updater/redact.js";
import { type MountEngine, MountEngineError } from "./engine.js";
import {
  type MounterError,
  type MounterErrorCode,
  type MounterState,
  addMountRequestSchema,
  isValidMountName,
  removeMountRequestSchema,
  testMountRequestSchema,
} from "./protocol.js";

/**
 * The mounter's HTTP API (JSON, internal Docker network only):
 *
 *   GET    /healthz            liveness, no authentication (container healthcheck)
 *   GET    /v1/state           shares, the current operation, history, capabilities
 *                              (`?refresh=1` recomputes the capabilities)
 *   POST   /v1/mounts          add a share: { mount, requestedBy } -> 202 and the state
 *   DELETE /v1/mounts/:name    remove a share: { requestedBy } -> 202 and the state
 *   POST   /v1/test            test settings ({ mount }) or a share ({ name }) -> the result
 *
 * Everything under /v1 needs `Authorization: Bearer <shared secret>`. Errors are
 * `{ "code": "...", "message": "..." }`; nothing in a response carries the secret.
 */

const MAX_BODY_BYTES = 16 * 1024;

export interface MounterServerDeps {
  engine: MountEngine;
  secret: string;
  clock: Clock;
  version: string | null;
  logger: Logger;
  redactor: Redactor;
}

const STATUS_OF: Record<MounterErrorCode, 401 | 404 | 409 | 422 | 500> = {
  unauthorized: 401,
  invalid_request: 422,
  busy: 409,
  blocked: 409,
  exists: 409,
  not_found: 404,
  conflict: 409,
  limit: 409,
  internal: 500,
};

export function buildMounterServer(deps: MounterServerDeps): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
  });

  const fail = (code: MounterErrorCode, message: string) => {
    const body: MounterError = { code, message: deps.redactor.oneLine(message, 600) };
    return new Response(JSON.stringify(body), {
      status: STATUS_OF[code],
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...(code === "unauthorized" ? { "WWW-Authenticate": "Bearer" } : {}),
      },
    });
  };

  const state = async (refresh: boolean): Promise<MounterState> => ({
    mounterVersion: deps.version,
    mounts: await deps.engine.mounts(),
    operation: deps.engine.current(),
    history: deps.engine.history(),
    capabilities: await deps.engine.capabilities(refresh),
    serverTime: deps.clock.now().toISOString(),
  });

  /** The body, parsed against `schema`; a Response when it is not acceptable. */
  async function body<S extends z.ZodTypeAny>(
    request: Request,
    schema: S,
  ): Promise<{ data: z.infer<S> } | { response: Response }> {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return { response: fail("invalid_request", "The request body is too large.") };
    }
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return { response: fail("invalid_request", "The request body is too large.") };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { response: fail("invalid_request", "The request body is not valid JSON.") };
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const summary = parsed.error.issues
        .slice(0, 5)
        .map((issue: z.ZodIssue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
        .join("; ");
      return { response: fail("invalid_request", `The request is not valid: ${summary}`) };
    }
    return { data: parsed.data };
  }

  const engineFailure = (error: unknown): Response => {
    if (error instanceof MountEngineError) {
      return fail(error.code, error.message);
    }
    throw error;
  };

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.use("/v1/*", async (c, next) => {
    if (!isAuthorized(c.req.header("authorization"), deps.secret)) {
      return fail("unauthorized", "A valid bearer secret is required.");
    }
    await next();
    return undefined;
  });

  app.get("/v1/state", async (c) => {
    const refresh = c.req.query("refresh");
    return c.json(await state(refresh === "1" || refresh === "true"));
  });

  app.post("/v1/mounts", async (c) => {
    const parsed = await body(c.req.raw, addMountRequestSchema);
    if ("response" in parsed) {
      return parsed.response;
    }
    try {
      await deps.engine.add(parsed.data.mount, parsed.data.requestedBy);
    } catch (error) {
      return engineFailure(error);
    }
    return c.json(await state(false), 202);
  });

  app.delete("/v1/mounts/:name", async (c) => {
    const name = c.req.param("name");
    if (!isValidMountName(name)) {
      return fail("invalid_request", "The share name is not valid.");
    }
    const parsed = await body(c.req.raw, removeMountRequestSchema);
    if ("response" in parsed) {
      return parsed.response;
    }
    try {
      await deps.engine.remove(name, parsed.data.requestedBy);
    } catch (error) {
      return engineFailure(error);
    }
    return c.json(await state(false), 202);
  });

  app.post("/v1/test", async (c) => {
    const parsed = await body(c.req.raw, testMountRequestSchema);
    if ("response" in parsed) {
      return parsed.response;
    }
    try {
      return c.json(await deps.engine.test(parsed.data));
    } catch (error) {
      return engineFailure(error);
    }
  });

  app.notFound(() => fail("not_found", "There is nothing at this path."));

  app.onError((error) => {
    deps.logger.error(`Request failed: ${deps.redactor.oneLine(error.message, 500)}`);
    return fail("internal", "The mounter could not handle the request.");
  });

  return app;
}
