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
  params?: z.AnyZodObject;
  query?: z.AnyZodObject;
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
    return schema.isOptional();
  }
  if (schema instanceof z.ZodOptional) {
    return true;
  }
  return schema instanceof z.ZodNullable && schema.unwrap() instanceof z.ZodOptional;
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

function stringSchema(schema: z.ZodString): JsonSchema {
  const json: JsonSchema = { type: "string" };
  for (const check of schema._def.checks) {
    switch (check.kind) {
      case "min":
        json.minLength = check.value;
        break;
      case "max":
        json.maxLength = check.value;
        break;
      case "length":
        json.minLength = check.value;
        json.maxLength = check.value;
        break;
      case "email":
        json.format = "email";
        break;
      case "url":
        json.format = "uri";
        break;
      case "uuid":
        json.format = "uuid";
        break;
      case "datetime":
        json.format = "date-time";
        break;
      case "date":
        json.format = "date";
        break;
      case "regex":
        json.pattern = check.regex.source;
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
  for (const check of schema._def.checks) {
    if (check.kind === "int") {
      json.type = "integer";
    } else if (check.kind === "min") {
      json[check.inclusive ? "minimum" : "exclusiveMinimum"] = check.value;
    } else if (check.kind === "max") {
      json[check.inclusive ? "maximum" : "exclusiveMaximum"] = check.value;
    } else if (check.kind === "multipleOf") {
      json.multipleOf = check.value;
    }
  }
  return json;
}

function arraySchema(schema: z.ZodArray<z.ZodTypeAny>, ctx: ConvertContext): JsonSchema {
  const json: JsonSchema = { type: "array", items: convertSchema(schema.element, ctx) };
  const { minLength, maxLength, exactLength } = schema._def;
  if (exactLength) {
    json.minItems = exactLength.value;
    json.maxItems = exactLength.value;
  }
  if (minLength) {
    json.minItems = minLength.value;
  }
  if (maxLength) {
    json.maxItems = maxLength.value;
  }
  return json;
}

function objectSchema(schema: z.AnyZodObject, ctx: ConvertContext): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(schema.shape as z.ZodRawShape)) {
    properties[name] = convertSchema(field, ctx);
    if (!isOptionalProperty(field, ctx.mode)) {
      required.push(name);
    }
  }
  const json: JsonSchema = { type: "object", properties };
  if (required.length > 0) {
    json.required = required;
  }
  const catchall = schema._def.catchall as z.ZodTypeAny;
  if (!(catchall instanceof z.ZodNever)) {
    json.additionalProperties = convertSchema(catchall, ctx);
  } else if (schema._def.unknownKeys === "passthrough") {
    json.additionalProperties = true;
  } else if (schema._def.unknownKeys === "strict") {
    json.additionalProperties = false;
  }
  return json;
}

function convertType(schema: z.ZodTypeAny, ctx: ConvertContext): JsonSchema {
  if (schema instanceof z.ZodString) {
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
    return arraySchema(schema, ctx);
  }
  if (schema instanceof z.ZodRecord) {
    return { type: "object", additionalProperties: convertSchema(schema.valueSchema, ctx) };
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const options = [...(schema.options as z.ZodTypeAny[])];
    return {
      oneOf: options.map((option) => convertSchema(option, ctx)),
      discriminator: { propertyName: schema.discriminator as string },
    };
  }
  if (schema instanceof z.ZodUnion) {
    return {
      anyOf: (schema.options as z.ZodTypeAny[]).map((option) => convertSchema(option, ctx)),
    };
  }
  if (schema instanceof z.ZodIntersection) {
    return {
      allOf: [convertSchema(schema._def.left, ctx), convertSchema(schema._def.right, ctx)],
    };
  }
  if (schema instanceof z.ZodOptional) {
    return convertSchema(schema.unwrap(), ctx);
  }
  if (schema instanceof z.ZodNullable) {
    return withNull(convertSchema(schema.unwrap(), ctx));
  }
  if (schema instanceof z.ZodDefault) {
    const inner = convertSchema(schema._def.innerType, ctx);
    return ctx.mode === "input" ? { ...inner, default: schema._def.defaultValue() } : inner;
  }
  if (schema instanceof z.ZodEffects) {
    // refine / transform / preprocess: the accepted shape is the inner schema's.
    return convertSchema(schema.innerType(), ctx);
  }
  if (schema instanceof z.ZodPipeline) {
    return convertSchema(ctx.mode === "input" ? schema._def.in : schema._def.out, ctx);
  }
  if (schema instanceof z.ZodCatch || schema instanceof z.ZodReadonly) {
    return convertSchema(schema._def.innerType, ctx);
  }
  if (schema instanceof z.ZodBranded) {
    return convertSchema(schema.unwrap(), ctx);
  }
  if (schema instanceof z.ZodLazy) {
    return convertSchema(schema.schema, ctx);
  }
  throw new Error(`OpenAPI: unsupported zod type ${schema._def.typeName ?? "unknown"}`);
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

function describe(json: JsonSchema, schema: z.ZodTypeAny): JsonSchema {
  return schema.description ? { ...json, description: schema.description } : json;
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

function parametersOf(
  schema: z.AnyZodObject | undefined,
  location: "path" | "query",
): JsonSchema[] {
  if (!schema) {
    return [];
  }
  return Object.entries(schema.shape as z.ZodRawShape).map(([name, field]) => {
    const { description, ...fieldSchema } = toJsonSchema(field, "input");
    return {
      name,
      in: location,
      required: location === "path" || !field.isOptional(),
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
