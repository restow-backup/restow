import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorHandler, ProblemError } from "./problem.js";

function app(error: Error) {
  const hono = new Hono();
  hono.get("/api/v1/thing", () => {
    throw error;
  });
  hono.onError(errorHandler);
  return hono;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the global error handler", () => {
  it("logs an unexpected error with its route and stack, and answers a bare 500", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await app(new TypeError("cannot read properties of undefined")).request(
      "/api/v1/thing?token=secret-value",
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ detail: "An unexpected error occurred." });
    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(line).toMatchObject({
      level: "error",
      method: "GET",
      path: "/api/v1/thing",
      errorName: "TypeError",
      errorMessage: "cannot read properties of undefined",
    });
    expect(line.stack.length).toBeGreaterThan(0);
    expect(String(log.mock.calls[0]?.[0])).not.toContain("secret-value");
  });

  it("does not log a known problem", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await app(new ProblemError(409, "Conflict", { detail: "busy" })).request(
      "/api/v1/thing",
    );
    expect(response.status).toBe(409);
    expect(log).not.toHaveBeenCalled();
  });
});
