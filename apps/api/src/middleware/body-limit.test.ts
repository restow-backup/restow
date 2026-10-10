import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../app.js";
import { MAX_DOWNLOAD_BODY_BYTES } from "../features/endpoints/schemas.js";
import { errorHandler } from "../problem.js";
import { parseJsonBody } from "../schemas.js";
import {
  BODY_LIMIT_RULES,
  BULK_BODY_LIMIT,
  DEFAULT_BODY_LIMIT,
  PAYLOAD_TOO_LARGE_PROBLEM,
  bodyLimitFor,
  requestBodyLimit,
} from "./body-limit.js";

/** A chunked body (no Content-Length) of `size` bytes in 64 KiB pieces. */
function chunkedBody(size: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      const piece = Math.min(64 * 1024, size - sent);
      controller.enqueue(new Uint8Array(piece).fill(0x20));
      sent += piece;
    },
  });
}

function testApp() {
  const app = new Hono();
  app.onError(errorHandler);
  app.use("*", requestBodyLimit);
  const reached: string[] = [];
  app.post("/api/v1/echo", async (c) => {
    reached.push("echo");
    const input = await parseJsonBody(c.req, z.object({ text: z.string() }));
    return c.json({ length: input.text.length });
  });
  app.post("/api/v1/raw", async (c) => {
    reached.push("raw");
    const text = await c.req.text();
    return c.json({ length: text.length });
  });
  app.all("/agent/restic/:id/*", async (c) => {
    const bytes = await c.req.arrayBuffer();
    return c.json({ length: bytes.byteLength });
  });
  return { app, reached };
}

describe("bodyLimitFor", () => {
  it("is 1 MiB for everything not listed, the public routes included", () => {
    for (const [method, path] of [
      ["POST", "/api/v1/setup"],
      ["POST", "/api/v1/accounts/set-password"],
      ["POST", "/api/auth/sign-in/email"],
      ["POST", "/agent/v1/enroll"],
      ["POST", "/agent/v1/heartbeat"],
      ["PATCH", "/api/v1/settings"],
      // A listed path with another method, or with something appended, is not listed.
      ["PUT", "/api/v1/restore"],
      ["POST", "/api/v1/restore/x/cancel"],
    ] as const) {
      expect(bodyLimitFor(method, path), `${method} ${path}`).toBe(DEFAULT_BODY_LIMIT);
    }
  });

  it("lets the bulk routes send up to 16 MiB", () => {
    for (const [method, path] of [
      ["POST", "/api/v1/restore"],
      ["POST", "/api/v1/exports"],
      ["POST", "/api/v1/imports"],
      ["PUT", "/api/v1/directory/sources/0b0f/rules"],
      ["POST", "/api/v1/directory/sources/0b0f/accounts"],
      ["POST", "/api/v1/directory/sources/0b0f/accounts/import"],
      ["POST", "/agent/v1/runs/0b0f/finish"],
    ] as const) {
      expect(bodyLimitFor(method, path), `${method} ${path}`).toBe(BULK_BODY_LIMIT);
    }
    expect(bodyLimitFor("post", "/api/v1/endpoints/0b0f/downloads")).toBe(MAX_DOWNLOAD_BODY_BYTES);
  });

  it("leaves the streamed routes to their own caps", () => {
    expect(bodyLimitFor("PUT", "/agent/restic/0b0f/data/abc")).toBeNull();
    expect(bodyLimitFor("POST", "/agent/restic/0b0f/locks/abc")).toBeNull();
    expect(bodyLimitFor("POST", "/internal/file-shares/restic/0b0f/data/abc")).toBeNull();
    expect(bodyLimitFor("POST", "/internal/file-shares/v1/finish")).not.toBeNull();
    expect(bodyLimitFor("PUT", "/api/v1/imports/uploads/0b0f/segments/3")).toBeNull();
  });
});

describe("requestBodyLimit", () => {
  it("refuses a declared length over the limit before the route runs", async () => {
    const { app, reached } = testApp();
    const response = await app.request("/api/v1/echo", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(DEFAULT_BODY_LIMIT + 1),
      },
      body: "{}",
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      type: PAYLOAD_TOO_LARGE_PROBLEM,
      limitBytes: DEFAULT_BODY_LIMIT,
    });
    expect(reached).toEqual([]);
  });

  it("answers 413 when a chunked body passes the limit while the route reads it", async () => {
    const { app } = testApp();
    for (const path of ["/api/v1/echo", "/api/v1/raw"]) {
      const response = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chunkedBody(DEFAULT_BODY_LIMIT + 10),
        duplex: "half",
      } as RequestInit);
      expect(response.status, path).toBe(413);
      expect(((await response.json()) as { type: string }).type).toBe(PAYLOAD_TOO_LARGE_PROBLEM);
    }
  });

  it("hands a body within the limit to the route unchanged", async () => {
    const { app } = testApp();
    const text = "x".repeat(DEFAULT_BODY_LIMIT - 64);
    const chunked = await app.request("/api/v1/raw", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chunkedBody(DEFAULT_BODY_LIMIT),
      duplex: "half",
    } as RequestInit);
    expect(chunked.status).toBe(200);
    expect(await chunked.json()).toEqual({ length: DEFAULT_BODY_LIMIT });

    const declared = await app.request("/api/v1/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    expect(declared.status).toBe(200);
    expect(await declared.json()).toEqual({ length: text.length });
  });

  it("does not touch the restic data path", async () => {
    const { app } = testApp();
    const response = await app.request("/agent/restic/0b0f/data/abc", {
      method: "POST",
      body: chunkedBody(DEFAULT_BODY_LIMIT * 2),
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ length: DEFAULT_BODY_LIMIT * 2 });
  });
});

describe("the assembled application", () => {
  const app = buildApp();

  /** A concrete path for a route pattern: every parameter becomes "x". */
  const concrete = (path: string) => path.replace(/:[^/]+/g, "x").replace(/\*$/, "x");

  it("has a registered route for every exception, so a renamed route cannot keep a stale one", () => {
    for (const rule of BODY_LIMIT_RULES) {
      const registered = app.routes.some(
        (route) =>
          (rule.method === "*" || route.method === rule.method || route.method === "ALL") &&
          rule.path.test(concrete(route.path)),
      );
      expect(registered, `${rule.method} ${rule.path}`).toBe(true);
    }
  });

  it("refuses an oversized setup request with 413 before anything reads it", async () => {
    const response = await app.request("/api/v1/setup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(64 * 1024 * 1024),
      },
      body: "{}",
    });
    expect(response.status).toBe(413);
  });

  it("counts malformed enrollments in the enrollment limit", async () => {
    const enroll = (body: string) =>
      app.request("/agent/v1/enroll", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.231" },
        body,
      });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt++) {
      statuses.push((await enroll(attempt % 2 === 0 ? "not json" : "{}")).status);
    }
    // 20 failures (enrollFailures in agent-service.ts) block the address.
    expect(statuses.slice(0, 20).every((status) => status === 422)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});
