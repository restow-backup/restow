import { z } from "zod";
import { componentName } from "./components.js";
import { problemSchema } from "./schemas.js";

/**
 * OpenAPI 3.1 for `/api/v1`, generated from the same zod schemas that validate
 * the requests and type the responses (docs/ARCHITECTURE.md, API: "OpenAPI aus
 * Zod-Schemas"). Served at `/api/v1/openapi.json`.
 *
 * Response shapes registered in ./components.ts become named schemas under
 * `#/components/schemas`, so client generators produce proper model types.
 * The converter covers the zod constructs the API uses and throws on anything
 * else, so a schema the document could not describe fails the test suite
 * instead of silently producing an empty schema.
 */

export type JsonSchema = { [keyword: string]: unknown };

/**
 * `input` describes what a client may send (fields with a default are
 * optional); `output` what the server returns (such fields are always there).
 */
export type SchemaMode = "input" | "output";

export type HttpMethod = "get" | "post" | "patch" | "delete";

/** Who may call an operation: a tenant (or provider) key on one tenant, a provider key, anyone. */
export type Audience = "tenant" | "provider" | "public";

export interface ResponseSpec {
  status: 200 | 201 | 202 | 204;
  description: string;
  schema?: z.ZodTypeAny;
  /** Defaults to `application/json`. */
  contentType?: "application/json" | "text/event-stream";
}

/** Everything the document needs to know about one operation. */
export interface OperationSpec {
  method: HttpMethod;
  /** Hono path relative to `/api/v1`, e.g. `/jobs/:id`. */
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  tag: string;
  audience: Audience;
  scope?: string;
  /** Changes state; refused on a tenant that is not active. */
  write?: boolean;
  /** Every call is written to the tenant's audit log. */
  audited?: boolean;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodTypeAny;
  response: ResponseSpec;
  /** Problem statuses specific to the operation (401/403/429 are implied for keyed calls). */
  errors?: readonly ProblemStatus[];
}

export type ProblemStatus = 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 503;

const PROBLEM_DESCRIPTIONS: Record<ProblemStatus, string> = {
  400: "Bad request: malformed JSON, an invalid cursor or an invalid tenant header.",
  401: "Missing or invalid API key.",
  403: "The key lacks the scope or the tenant access this operation needs, or the installation does not offer the operation.",
  404: "The tenant or the named resource does not exist.",
  409: "The request conflicts with the current state (see `detail` and `reason`).",
  410: "The resource existed but is no longer available.",
  422: "The request did not match the schema; `issues` lists every violation.",
  429: "The key's rate limit is exhausted; retry after the `Retry-After` delay.",
  503: "A dependency is not ready yet (job queue, storage or master key).",
};

const KEYED_ERRORS: readonly ProblemStatus[] = [401, 403, 429];

// ---------------------------------------------------------------------------
// zod -> JSON Schema
// ---------------------------------------------------------------------------

interface ConvertContext {
  mode: SchemaMode;
  /** Named output schemas collected while converting; absent: inline everything. */
  components?: Map<string, JsonSchema>;
}

/** Whether a property may be absent in the given mode. */
export function isOptionalProperty(schema: z.ZodTypeAny, mode: SchemaMode): boolean {
  if (mode === "input") {
    return acceptsUndefined(schema);
  }
  if (schema instanceof z.ZodOptional) {
    return true;
  }
  return schema instanceof z.ZodNullable && schema.unwrap() instanceof z.ZodOptional;
}

/** Whether `undefined` is a valid value of the schema (a key with it may be left out). */
function acceptsUndefined(schema: z.ZodTypeAny): boolean {
  return schema.safeParse(undefined).success;
}

function withNull(json: JsonSchema): JsonSchema {
  const { type, description, ...rest } = json;
  if (typeof type === "string" && !("const" in rest)) {
    const nullable: JsonSchema = { ...rest, type: [type, "null"] };
    if (Array.isArray(rest.enum)) {
      nullable.enum = [...rest.enum, null];
    }
    return description === undefined ? nullable : { ...nullable, description };
  }
  const anyOf: JsonSchema = { anyOf: [{ ...rest, ...(type ? { type } : {}) }, { type: "null" }] };
  return description === undefined ? anyOf : { ...anyOf, description };
}

/** The constraints a schema carries, as zod 4 stores them: its own definition plus its checks. */
function checkDefinitions(schema: z.ZodTypeAny): Record<string, unknown>[] {
  const definition = schema._zod.def as { checks?: { _zod: { def: Record<string, unknown> } }[] };
  return (definition.checks ?? []).map((check) => check._zod.def);
}

function applyStringFormat(json: JsonSchema, definition: Record<string, unknown>): void {
  switch (definition.format) {
    case "email":
      json.format = "email";
      break;
    case "url":
      json.format = "uri";
      break;
    case "uuid":
    case "guid":
      json.format = "uuid";
      break;
    case "datetime":
      json.format = "date-time";
      break;
    case "date":
      json.format = "date";
      break;
    case "regex":
      json.pattern = (definition.pattern as RegExp).source;
      break;
    default:
      // includes, startsWith and friends narrow the value, but have no format of their own.
      break;
  }
}

function stringSchema(schema: z.ZodTypeAny): JsonSchema {
  const json: JsonSchema = { type: "string" };
  // z.uuid(), z.email(), ...: the schema is the format check itself.
  const own = schema._zod.def as unknown as Record<string, unknown>;
  if (own.check === "string_format") {
    applyStringFormat(json, own);
  }
  for (const check of checkDefinitions(schema)) {
    switch (check.check) {
      case "min_length":
        json.minLength = check.minimum;
        break;
      case "max_length":
        json.maxLength = check.maximum;
        break;
      case "length_equals":
        json.minLength = check.length;
        json.maxLength = check.length;
        break;
      case "string_format":
        applyStringFormat(json, check);
        break;
      default:
        // trim, toLowerCase and friends shape the value, not the accepted set.
        break;
    }
  }
  return json;
}

function numberSchema(schema: z.ZodNumber): JsonSchema {
  const json: JsonSchema = { type: "number" };
  if ((schema._zod.def as { format?: string }).format) {
    json.type = "integer";
  }
  for (const check of checkDefinitions(schema)) {
    if (check.check === "number_format") {
      json.type = "integer";
    } else if (check.check === "greater_than") {
      json[check.inclusive ? "minimum" : "exclusiveMinimum"] = check.value;
    } else if (check.check === "less_than") {
      json[check.inclusive ? "maximum" : "exclusiveMaximum"] = check.value;
    } else if (check.check === "multiple_of") {
      json.multipleOf = check.value;
    }
  }
  return json;
}

function arraySchema(schema: z.ZodArray<z.ZodTypeAny>, ctx: ConvertContext): JsonSchema {
  const json: JsonSchema = { type: "array", items: convertSchema(schema.element, ctx) };
  for (const check of checkDefinitions(schema)) {
    if (check.check === "length_equals") {
      json.minItems = check.length;
      json.maxItems = check.length;
    } else if (check.check === "min_length") {
      json.minItems = check.minimum;
    } else if (check.check === "max_length") {
      json.maxItems = check.maximum;
    }
  }
  return json;
}

function objectSchema(schema: z.ZodObject, ctx: ConvertContext): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(schema.shape as z.ZodRawShape)) {
    properties[name] = convertSchema(field as z.ZodTypeAny, ctx);
    if (!isOptionalProperty(field as z.ZodTypeAny, ctx.mode)) {
      required.push(name);
    }
  }
  const json: JsonSchema = { type: "object", properties };
  if (required.length > 0) {
    json.required = required;
  }
  // zod 4 keeps the handling of unknown keys in the catchall: undefined strips them,
  // `never` refuses them (strictObject), `unknown` keeps them (looseObject, passthrough).
  const catchall = schema._zod.def.catchall as z.ZodTypeAny | undefined;
  if (catchall instanceof z.ZodNever) {
    json.additionalProperties = false;
  } else if (catchall instanceof z.ZodUnknown) {
    json.additionalProperties = true;
  } else if (catchall) {
    json.additionalProperties = convertSchema(catchall, ctx);
  }
  return json;
}

function convertType(schema: z.ZodTypeAny, ctx: ConvertContext): JsonSchema {
  if (schema instanceof z.ZodString || schema instanceof z.ZodStringFormat) {
    return stringSchema(schema);
  }
  if (schema instanceof z.ZodNumber) {
    return numberSchema(schema);
  }
  if (schema instanceof z.ZodBoolean) {
    return { type: "boolean" };
  }
  if (schema instanceof z.ZodNull) {
    return { type: "null" };
  }
  if (schema instanceof z.ZodDate) {
    return { type: "string", format: "date-time" };
  }
  if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny) {
    return {};
  }
  if (schema instanceof z.ZodLiteral) {
    const value = schema.value as unknown;
    return { const: value, type: value === null ? "null" : typeof value };
  }
  if (schema instanceof z.ZodEnum) {
    return { type: "string", enum: [...(schema.options as string[])] };
  }
  if (schema instanceof z.ZodObject) {
    return objectSchema(schema, ctx);
  }
  if (schema instanceof z.ZodArray) {
    return arraySchema(schema as z.ZodArray<z.ZodTypeAny>, ctx);
  }
  if (schema instanceof z.ZodRecord) {
    return {
      type: "object",
      additionalProperties: convertSchema(schema.valueType as z.ZodTypeAny, ctx),
    };
  }
  // Before ZodUnion: in zod 4 a discriminated union is a union.
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const options = [...(schema.options as z.ZodTypeAny[])];
    return {
      oneOf: options.map((option) => convertSchema(option, ctx)),
      discriminator: { propertyName: schema._zod.def.discriminator as string },
    };
  }
  if (schema instanceof z.ZodUnion) {
    return {
      anyOf: (schema.options as z.ZodTypeAny[]).map((option) => convertSchema(option, ctx)),
    };
  }
  if (schema instanceof z.ZodIntersection) {
    return {
      allOf: [
        convertSchema(schema._zod.def.left as z.ZodTypeAny, ctx),
        convertSchema(schema._zod.def.right as z.ZodTypeAny, ctx),
      ],
    };
  }
  if (schema instanceof z.ZodOptional) {
    return convertSchema(schema.unwrap() as z.ZodTypeAny, ctx);
  }
  if (schema instanceof z.ZodNullable) {
    return withNull(convertSchema(schema.unwrap() as z.ZodTypeAny, ctx));
  }
  if (schema instanceof z.ZodDefault) {
    const inner = convertSchema(schema._zod.def.innerType as z.ZodTypeAny, ctx);
    return ctx.mode === "input" ? { ...inner, default: schema._zod.def.defaultValue } : inner;
  }
  if (schema instanceof z.ZodPipe) {
    const { in: from, out: to } = schema._zod.def as unknown as {
      in: z.ZodTypeAny;
      out: z.ZodTypeAny;
    };
    // transform: the accepted shape is the one before it; preprocess: the one after it.
    if (to instanceof z.ZodTransform) {
      return convertSchema(from, ctx);
    }
    if (from instanceof z.ZodTransform) {
      return convertSchema(to, ctx);
    }
    return convertSchema(ctx.mode === "input" ? from : to, ctx);
  }
  if (schema instanceof z.ZodCatch || schema instanceof z.ZodReadonly) {
    return convertSchema(schema._zod.def.innerType as z.ZodTypeAny, ctx);
  }
  if (schema instanceof z.ZodLazy) {
    return convertSchema(schema._zod.innerType as z.ZodTypeAny, ctx);
  }
  throw new Error(`OpenAPI: unsupported zod type ${schema.constructor.name || "unknown"}`);
}

function convertSchema(schema: z.ZodTypeAny, ctx: ConvertContext): JsonSchema {
  const name = ctx.mode === "output" && ctx.components ? componentName(schema) : undefined;
  if (name && ctx.components) {
    if (!ctx.components.has(name)) {
      // Reserve the name first, so a shape that contains itself cannot recurse forever.
      ctx.components.set(name, {});
      ctx.components.set(name, describe(convertType(schema, ctx), schema));
    }
    return { $ref: `#/components/schemas/${name}` };
  }
  return describe(convertType(schema, ctx), schema);
}

/**
 * The description of a schema. A wrapper that adds nothing to the accepted shape (optional,
 * nullable, default, ...) speaks with the voice of what it wraps, as `.describe()` on the inner
 * schema did before zod 4, where the wrappers copied it.
 */
function descriptionOf(schema: z.ZodTypeAny): string | undefined {
  if (schema.description) {
    return schema.description;
  }
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodCatch ||
    schema instanceof z.ZodReadonly
  ) {
    return descriptionOf(schema.unwrap() as z.ZodTypeAny);
  }
  if (schema instanceof z.ZodPipe) {
    const { in: from, out: to } = schema._zod.def as unknown as {
      in: z.ZodTypeAny;
      out: z.ZodTypeAny;
    };
    if (to instanceof z.ZodTransform) {
      return descriptionOf(from);
    }
  }
  return undefined;
}

function describe(json: JsonSchema, schema: z.ZodTypeAny): JsonSchema {
  const description = descriptionOf(schema);
  return description ? { ...json, description } : json;
}

/**
 * The JSON Schema (2020-12 dialect, as OpenAPI 3.1 uses it) of a zod schema,
 * fully inlined. The document builder uses named components instead.
 */
export function toJsonSchema(schema: z.ZodTypeAny, mode: SchemaMode): JsonSchema {
  return convertSchema(schema, { mode });
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/** `/jobs/:id/events` -> `/jobs/{id}/events`. */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function parametersOf(schema: z.ZodObject | undefined, location: "path" | "query"): JsonSchema[] {
  if (!schema) {
    return [];
  }
  return Object.entries(schema.shape as z.ZodRawShape).map(([name, field]) => {
    const { description, ...fieldSchema } = toJsonSchema(field as z.ZodTypeAny, "input");
    return {
      name,
      in: location,
      required: location === "path" || !acceptsUndefined(field as z.ZodTypeAny),
      schema: fieldSchema,
      ...(description ? { description } : {}),
    };
  });
}

const PROBLEM_REF = { $ref: "#/components/schemas/Problem" };

function problemResponse(status: ProblemStatus): JsonSchema {
  return {
    description: PROBLEM_DESCRIPTIONS[status],
    content: { "application/problem+json": { schema: PROBLEM_REF } },
  };
}

function describeOperation(operation: OperationSpec): string {
  const notes: string[] = [];
  if (operation.description) {
    notes.push(operation.description);
  }
  if (operation.scope) {
    notes.push(`Requires scope \`${operation.scope}\`.`);
  }
  if (operation.audience === "provider") {
    notes.push("Provider key only.");
  }
  if (operation.audited) {
    notes.push("Every call is recorded in the tenant's audit log.");
  }
  return notes.join("\n\n");
}

function operationObject(
  operation: OperationSpec,
  components: Map<string, JsonSchema>,
): JsonSchema {
  const keyed = operation.audience !== "public";
  const parameters = [
    ...parametersOf(operation.params, "path"),
    ...parametersOf(operation.query, "query"),
    ...(operation.audience === "tenant" ? [{ $ref: "#/components/parameters/TenantHeader" }] : []),
  ];
  const { response } = operation;
  const responses: Record<string, JsonSchema> = {
    [String(response.status)]: {
      description: response.description,
      ...(response.schema
        ? {
            content: {
              [response.contentType ?? "application/json"]: {
                schema: convertSchema(response.schema, { mode: "output", components }),
              },
            },
          }
        : {}),
    },
  };
  const errors = new Set<ProblemStatus>([
    ...(keyed ? KEYED_ERRORS : []),
    ...(operation.errors ?? []),
  ]);
  for (const status of [...errors].sort((a, b) => a - b)) {
    responses[String(status)] = problemResponse(status);
  }

  return {
    operationId: operation.operationId,
    summary: operation.summary,
    description: describeOperation(operation),
    tags: [operation.tag],
    security: keyed ? [{ apiKey: operation.scope ? [operation.scope] : [] }] : [],
    ...(operation.scope ? { "x-restow-scope": operation.scope } : {}),
    ...(operation.audited ? { "x-restow-audited": true } : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(operation.body
      ? {
          requestBody: {
            // A body whose fields are all optional may be left out entirely.
            required: !operation.body.safeParse({}).success,
            content: { "application/json": { schema: toJsonSchema(operation.body, "input") } },
          },
        }
      : {}),
    responses,
  };
}

export interface DocumentInfo {
  title: string;
  /** Version of the v1 contract (not of the running build). */
  version: string;
  description: string;
  /** The running Restow build, when the image was stamped with one. */
  build: string | null;
}

/** The OpenAPI 3.1 document of the given operations. */
export function buildOpenApiDocument(
  operations: readonly OperationSpec[],
  info: DocumentInfo,
): JsonSchema {
  const components = new Map<string, JsonSchema>([
    ["Problem", toJsonSchema(problemSchema, "output")],
  ]);
  const paths: Record<string, Record<string, JsonSchema>> = {};
  for (const operation of operations) {
    const path = toOpenApiPath(operation.path);
    paths[path] = {
      ...(paths[path] ?? {}),
      [operation.method]: operationObject(operation, components),
    };
  }
  const tags = [...new Set(operations.map((operation) => operation.tag))].map((name) => ({ name }));
  const schemas = Object.fromEntries(
    [...components.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

  return {
    openapi: "3.1.0",
    info: {
      title: info.title,
      version: info.version,
      description: info.description,
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
      ...(info.build ? { "x-restow-build": info.build } : {}),
    },
    servers: [{ url: "/api/v1" }],
    tags,
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "rsk_<tenant>_<random> | rsk_provider_<random>",
          description:
            "An API key of this installation. Tenant keys act on their own tenant; provider keys (where the installation offers them) read across tenants and name a tenant in `X-Restow-Tenant` for tenant operations. The security requirement lists the scope an operation needs.",
        },
      },
      parameters: {
        TenantHeader: {
          name: "X-Restow-Tenant",
          in: "header",
          required: false,
          description:
            "Tenant id. Required with a provider key; with a tenant key it may be omitted and must otherwise name the key's own tenant.",
          schema: { type: "string", format: "uuid" },
        },
      },
      schemas,
    },
  };
}
