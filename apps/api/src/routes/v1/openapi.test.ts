import { configureProductName } from "@restow/i18n";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { errorHandler } from "../../problem.js";
import { buildV1 } from "../v1.js";
import { type JsonSchema, toJsonSchema, toOpenApiPath } from "./openapi.js";
import { featuresOn } from "./testing/features.js";
import { fakeRequireKey } from "./testing/keys.js";
import { scriptedDb } from "./testing/scripted-db.js";
import type { VersionInfo } from "./version.js";

const VERSION: VersionInfo = {
  running: "1.4.0",
  commit: null,
  latest: null,
  updateAvailable: null,
  releaseUrl: null,
  updateCheck: "disabled",
  checkedAt: null,
  channel: "stable",
  latestTag: null,
  publishedAt: null,
  checkError: null,
  maintenance: null,
};

function integrationApi() {
  const script = scriptedDb([]);
  return buildV1({
    db: script.db,
    providerDb: script.db,
    requireKey: fakeRequireKey,
    requireFeature: featuresOn,
    audit: async () => {
      throw new Error("no audit expected");
    },
    version: { current: () => VERSION },
    now: () => new Date("2026-09-23T10:00:00.000Z"),
  });
}

describe("toJsonSchema", () => {
  it("describes strings with their formats and bounds", () => {
    expect(toJsonSchema(z.string().uuid(), "output")).toEqual({ type: "string", format: "uuid" });
    expect(toJsonSchema(z.string().datetime({ offset: true }), "output")).toEqual({
      type: "string",
      format: "date-time",
    });
    expect(toJsonSchema(z.string().trim().min(3).max(20).describe("A name."), "input")).toEqual({
      type: "string",
      minLength: 3,
      maxLength: 20,
      description: "A name.",
    });
  });

  it("describes integers with inclusive and exclusive bounds", () => {
    expect(toJsonSchema(z.coerce.number().int().min(1).max(500), "input")).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 500,
    });
    expect(toJsonSchema(z.number().positive(), "input")).toEqual({
      type: "number",
      exclusiveMinimum: 0,
    });
  });

  it("marks nullable values in the 3.1 style", () => {
    expect(toJsonSchema(z.string().nullable(), "output")).toEqual({ type: ["string", "null"] });
    expect(toJsonSchema(z.enum(["a", "b"]).nullable(), "output")).toEqual({
      type: ["string", "null"],
      enum: ["a", "b", null],
    });
    expect(toJsonSchema(z.object({ a: z.number() }).nullable(), "output")).toEqual({
      type: ["object", "null"],
      properties: { a: { type: "number" } },
      required: ["a"],
    });
    expect(toJsonSchema(z.union([z.string(), z.number()]).nullable(), "output")).toEqual({
      anyOf: [{ anyOf: [{ type: "string" }, { type: "number" }] }, { type: "null" }],
    });
  });

  it("treats defaults as optional input and as always present output", () => {
    const schema = z.object({ mode: z.enum(["x", "y"]).default("x"), note: z.string().optional() });
    expect(toJsonSchema(schema, "input")).toEqual({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["x", "y"], default: "x" },
        note: { type: "string" },
      },
    });
    expect(toJsonSchema(schema, "output")).toMatchObject({ required: ["mode"] });
  });

  it("describes unions, records, transforms and passthrough objects", () => {
    const union = z.discriminatedUnion("type", [
      z.object({ type: z.literal("original") }),
      z.object({ type: z.literal("other"), accountId: z.string() }),
    ]);
    expect(toJsonSchema(union, "input")).toMatchObject({
      oneOf: [{ properties: { type: { const: "original" } } }, { required: ["type", "accountId"] }],
      discriminator: { propertyName: "type" },
    });
    expect(toJsonSchema(z.record(z.string(), z.number()), "output")).toEqual({
      type: "object",
      additionalProperties: { type: "number" },
    });
    expect(
      toJsonSchema(
        z
          .string()
          .max(10)
          .transform((value) => value.trim()),
        "input",
      ),
    ).toEqual({
      type: "string",
      maxLength: 10,
    });
    expect(toJsonSchema(z.object({}).passthrough(), "output")).toEqual({
      type: "object",
      properties: {},
      additionalProperties: true,
    });
  });

  it("refuses a construct it cannot describe instead of documenting nothing", () => {
    expect(() => toJsonSchema(z.bigint(), "output")).toThrow(/unsupported zod type ZodBigInt/);
  });

  it("converts Hono paths to OpenAPI paths", () => {
    expect(toOpenApiPath("/webhooks/:id/deliveries")).toBe("/webhooks/{id}/deliveries");
  });
});

afterEach(() => {
  configureProductName(null);
});

describe("the v1 OpenAPI document", () => {
  const api = integrationApi();
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/api/v1", api.app);

  async function load(): Promise<JsonSchema> {
    const res = await app.request("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    return (await res.json()) as JsonSchema;
  }

  it("names the product the installation is branded with", async () => {
    const standard = (await load()).info as JsonSchema;
    expect(standard.title).toBe("Restow Integration API");

    configureProductName("Acme Backup");
    const branded = new Hono();
    branded.onError(errorHandler);
    branded.route("/api/v1", integrationApi().app);
    const res = await branded.request("/api/v1/openapi.json");
    const document = (await res.json()) as JsonSchema;
    const info = document.info as JsonSchema;
    expect(info.title).toBe("Acme Backup Integration API");
    expect(info.description).toContain("REST API of Acme Backup for RMM, PSA");
    expect(JSON.stringify(document)).not.toMatch(/Restow(?!-)/);
  });

  it("is public and documents every operation of the surface exactly once", async () => {
    const document = await load();
    expect(document.openapi).toBe("3.1.0");
    const paths = document.paths as Record<string, Record<string, JsonSchema>>;
    const documented = Object.entries(paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(documented.sort()).toEqual(
      [
        "GET /tenant",
        "GET /status",
        "GET /storage",
        "GET /objects",
        "GET /endpoints",
        "GET /users",
        "POST /users/{id}/protection",
        "GET /jobs",
        "POST /jobs/backup",
        "GET /jobs/{id}",
        "GET /jobs/{id}/events",
        "GET /verify/latest",
        "POST /verify",
        "POST /restore",
        "GET /archive/status",
        "GET /archive/report",
        "POST /webhooks",
        "GET /webhooks",
        "PATCH /webhooks/{id}",
        "DELETE /webhooks/{id}",
        "POST /webhooks/{id}/secret",
        "POST /webhooks/{id}/test",
        "GET /webhooks/{id}/deliveries",
      ].sort(),
    );
    const ids = api.operations.map((operation) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names the scope of every operation and the tenant header of tenant operations", async () => {
    const paths = (await load()).paths as Record<string, Record<string, JsonSchema>>;
    const status = paths["/status"]?.get as JsonSchema;
    expect(status.security).toEqual([{ apiKey: ["status:read"] }]);
    expect(status.parameters).toContainEqual({ $ref: "#/components/parameters/TenantHeader" });
  });

  it("documents paging bounds, optional bodies and problem responses", async () => {
    const paths = (await load()).paths as Record<string, Record<string, JsonSchema>>;
    const jobs = paths["/jobs"]?.get as JsonSchema;
    expect(jobs.parameters).toContainEqual({
      name: "limit",
      in: "query",
      required: false,
      schema: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      description: "Page size, at most 500.",
    });
    const backup = paths["/jobs/backup"]?.post as JsonSchema;
    expect((backup.requestBody as JsonSchema).required).toBe(false);
    const restore = paths["/restore"]?.post as JsonSchema;
    const restoreBody = restore.requestBody as {
      required: boolean;
      content: Record<string, { schema: JsonSchema }>;
    };
    expect(restoreBody.required).toBe(true);
    expect(restoreBody.content["application/json"]?.schema.required).toEqual(
      expect.arrayContaining(["snapshotId", "target", "reason"]),
    );
    expect(Object.keys(restore.responses as object)).toEqual(
      expect.arrayContaining(["202", "401", "403", "409", "422", "429"]),
    );
    const removal = paths["/webhooks/{id}"]?.delete as JsonSchema;
    expect((removal.responses as Record<string, JsonSchema>)["204"]).toEqual({
      description: "Removed.",
    });
  });

  it("names shared response shapes as components and refers to them", async () => {
    const document = await load();
    const schemas = (document.components as { schemas: Record<string, JsonSchema> }).schemas;
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining(["Problem", "Status", "Job", "JobDetail", "DirectoryUser", "Webhook"]),
    );
    const paths = document.paths as Record<string, Record<string, JsonSchema>>;
    const jobResponse = (paths["/jobs/{id}"]?.get?.responses as Record<string, JsonSchema>)["200"];
    expect(jobResponse).toEqual({
      description: "The job.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/JobDetail" } } },
    });
    // Every reference resolves.
    const refs = JSON.stringify(document).match(/#\/components\/schemas\/[A-Za-z]+/g) ?? [];
    for (const ref of new Set(refs)) {
      expect(schemas[ref.split("/").at(-1) as string]).toBeDefined();
    }
  });

  it("carries the contract version and the running build", async () => {
    const info = (await load()).info as JsonSchema;
    expect(info.version).toBe("1.0.0");
    expect(info["x-restow-build"]).toBe("1.4.0");
  });
});
