import type { Database } from "@restow/db";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import type { z } from "zod";
import {
  type KeyTenant,
  type KeyTenantDeps,
  assertProviderKeys,
  resolveKeyTenant,
} from "../../features/apikeys/key-tenant.js";
import { isApiKeyAuthorization } from "../../features/apikeys/tokens.js";
import type { audit } from "../../lib/audit.js";
import { clientIp } from "../../lib/request.js";
import type {
  ApiKeyContext,
  ApiKeyVariables,
  ApiScope,
  requireApiKey,
} from "../../middleware/apiKey.js";
import { TENANT_HEADER } from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { parseOrProblem } from "../../schemas.js";
import { type KeyActor, keyActor } from "./actor.js";
import type { Audience, OperationSpec, ResponseSpec } from "./openapi.js";
import type { VersionSource } from "./version.js";

/**
 * The integration API's route definer.
 *
 * One definition per operation carries everything about it: method and path,
 * the scope, the request schemas, the response schema and its documentation.
 * The definer registers the Hono handler from it (API key, scope, tenant,
 * validation) and keeps the definition for the OpenAPI document, so what is
 * documented is exactly what is enforced.
 *
 * `/api/v1` is shared with the session-protected feature routes of the web UI
 * (`/jobs`, `/restore`, `/verify`, ...). An operation here claims only
 * requests that carry a Restow API key (`Authorization: Bearer rsk_...`).
 * Any other request passes on to the next route registered for the same path,
 * so the router can be mounted ahead of the feature routes; when nothing else
 * serves the path, the caller learns that an API key is required.
 */

export type V1Env = { Variables: ApiKeyVariables };

/** The tenant an operation acts on, as resolved from the key (and header). */
export type TenantInfo = KeyTenant;

/**
 * The database and the feature gate (provider keys need `apiKeys.provider`)
 * for the shared key rules, plus the API-key middleware factory.
 */
export interface GuardDeps extends KeyTenantDeps {
  /** API-key middleware factory (middleware/apiKey.ts). */
  requireKey: typeof requireApiKey;
}

/** What the operations need; injected so tests can replace the database, the key gate and the clock. */
export interface V1Deps extends GuardDeps {
  /**
   * The installation pool (apps/api/src/db.ts): only for the provider
   * overviews' tenant list and the mailbox usage that counts every tenant.
   * `db` stays the application pool, subject to Row Level Security.
   */
  providerDb: Database;
  /** Appends to the tenant's audit log (lib/audit.ts). */
  audit: typeof audit;
  version: VersionSource;
  now: () => Date;
}

/** Problem statuses of a tenant read besides 401/403/429: tenant header or cursor, tenant, validation. */
export const READ_ERRORS = [400, 404, 422] as const;
/** Problem statuses of a change: additionally a conflict with the current state and a queue not ready. */
export const WRITE_ERRORS = [400, 404, 409, 422, 503] as const;

type Infer<S> = S extends z.ZodTypeAny ? z.infer<S> : undefined;

export interface RouteDefinition<
  P extends z.AnyZodObject | undefined,
  Q extends z.AnyZodObject | undefined,
  B extends z.ZodTypeAny | undefined,
  R extends z.ZodTypeAny | undefined,
> extends Omit<OperationSpec, "audience" | "scope" | "params" | "query" | "body" | "response"> {
  scope: ApiScope;
  params?: P;
  query?: Q;
  body?: B;
  response: Omit<ResponseSpec, "schema"> & { schema?: R };
}

export interface RouteInput<P, Q, B> {
  params: Infer<P>;
  query: Infer<Q>;
  body: Infer<B>;
}

export interface KeyedCall<I> {
  c: Context<V1Env>;
  key: ApiKeyContext;
  actor: KeyActor;
  input: I;
}

export interface TenantCall<I> extends KeyedCall<I> {
  tenant: TenantInfo;
}

/** A handler answers with the documented body, or with its own Response (streams). */
export type RouteResult<R> = (R extends z.ZodTypeAny ? z.infer<R> : null) | Response;

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/** True when a route registered after the current one would serve this request. */
export function hasLaterHandler(
  routes: readonly { method: string }[],
  routeIndex: number,
): boolean {
  return routes.slice(routeIndex + 1).some((route) => route.method !== "ALL");
}

export function apiKeyRequired(): ProblemError {
  return new ProblemError(401, "API key required", {
    type: "urn:restow:problem:api-key-required",
    detail: "This endpoint belongs to the integration API. Send 'Authorization: Bearer rsk_...'.",
  });
}

/** The tenant-state rule is shared with every key surface (features/apikeys/key-tenant.ts). */
export { assertTenantUsable } from "../../features/apikeys/key-tenant.js";

/** The JSON body; an empty body counts as `{}`, so all-optional bodies may be left out. */
export async function readJsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProblemError(400, "Malformed JSON", {
      type: "urn:restow:problem:malformed-json",
      detail: "The request body is not valid JSON.",
    });
  }
}

// ---------------------------------------------------------------------------
// Definer
// ---------------------------------------------------------------------------

type AnyDefinition = RouteDefinition<
  z.AnyZodObject | undefined,
  z.AnyZodObject | undefined,
  z.ZodTypeAny | undefined,
  z.ZodTypeAny | undefined
>;

async function readInput(c: Context<V1Env>, definition: AnyDefinition) {
  return {
    params: definition.params ? parseOrProblem(definition.params, c.req.param()) : undefined,
    query: definition.query ? parseOrProblem(definition.query, c.req.query()) : undefined,
    body: definition.body ? parseOrProblem(definition.body, await readJsonBody(c)) : undefined,
  };
}

const JSON_CONTENT_TYPE = "application/json; charset=UTF-8";

function respond(c: Context<V1Env>, response: ResponseSpec, result: unknown): Response {
  if (result instanceof Response) {
    return result;
  }
  if (response.status === 204) {
    return c.body(null, 204);
  }
  return c.body(JSON.stringify(result), response.status, { "content-type": JSON_CONTENT_TYPE });
}

export class IntegrationApi {
  readonly app = new Hono<V1Env>();
  readonly operations: OperationSpec[] = [];

  constructor(private readonly deps: GuardDeps) {}

  /** An operation on one tenant: the key's own, or the one a provider key names. */
  tenant<
    P extends z.AnyZodObject | undefined = undefined,
    Q extends z.AnyZodObject | undefined = undefined,
    B extends z.ZodTypeAny | undefined = undefined,
    R extends z.ZodTypeAny | undefined = undefined,
  >(
    definition: RouteDefinition<P, Q, B, R>,
    handler: (call: TenantCall<RouteInput<P, Q, B>>) => Promise<RouteResult<R>>,
  ): void {
    this.register(definition, "tenant", async (c, key) => {
      const actor = keyActor(key, clientIp(c));
      const tenant = await resolveKeyTenant(
        this.deps,
        key,
        c.req.header(TENANT_HEADER),
        definition.write === true,
      );
      const input = (await readInput(c, definition)) as RouteInput<P, Q, B>;
      return respond(c, definition.response, await handler({ c, key, actor, tenant, input }));
    });
  }

  /** A cross-tenant operation for provider keys (while `apiKeys.provider` is on). */
  provider<
    P extends z.AnyZodObject | undefined = undefined,
    Q extends z.AnyZodObject | undefined = undefined,
    B extends z.ZodTypeAny | undefined = undefined,
    R extends z.ZodTypeAny | undefined = undefined,
  >(
    definition: RouteDefinition<P, Q, B, R>,
    handler: (call: KeyedCall<RouteInput<P, Q, B>>) => Promise<RouteResult<R>>,
  ): void {
    this.register(definition, "provider", async (c, key) => {
      await assertProviderKeys(this.deps);
      const actor = keyActor(key, clientIp(c));
      const input = (await readInput(c, definition)) as RouteInput<P, Q, B>;
      return respond(c, definition.response, await handler({ c, key, actor, input }));
    });
  }

  /** A public JSON document (no key), e.g. the OpenAPI description. */
  document(path: string, build: () => unknown): void {
    this.app.get(path, (c) =>
      c.body(JSON.stringify(build()), 200, { "content-type": JSON_CONTENT_TYPE }),
    );
  }

  private register(
    definition: AnyDefinition,
    audience: Exclude<Audience, "public">,
    run: (c: Context<V1Env>, key: ApiKeyContext) => Promise<Response>,
  ): void {
    this.operations.push({ ...definition, audience });
    const keyGate = this.deps.requireKey(definition.scope, { provider: audience === "provider" });

    const handler: MiddlewareHandler<V1Env> = async (c, next) => {
      if (!isApiKeyAuthorization(c.req.header("authorization"))) {
        if (hasLaterHandler(matchedRoutes(c), c.req.routeIndex)) {
          await next();
          return;
        }
        throw apiKeyRequired();
      }
      let response: Response | undefined;
      await keyGate(c, async () => {
        response = await run(c, c.get("apiKey"));
      });
      if (!response) {
        throw new Error("the API key gate neither rejected nor continued the request");
      }
      return response;
    };
    this.app.on(definition.method.toUpperCase(), definition.path, handler);
  }
}
