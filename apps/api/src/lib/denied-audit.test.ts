import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { DEMO_READ_ONLY_PROBLEM } from "../middleware/demo-guard.js";
import type { TenantEnv } from "../middleware/session.js";
import { ProblemError, errorHandler } from "../problem.js";
import { type DeniedEvent, DeniedThrottle, deniedAudit } from "./denied-audit.js";

const USER = { id: "user-1", email: "tech@provider.example" };

function app(options: { signedIn?: boolean; now?: () => number } = {}) {
  const written: DeniedEvent[] = [];
  const hono = new Hono<TenantEnv>();
  hono.onError(errorHandler);
  hono.use(
    "*",
    deniedAudit({
      write: async (event) => {
        written.push(event);
      },
      now: options.now ?? (() => 0),
    }),
  );
  hono.use("*", async (c, next) => {
    if (options.signedIn !== false) {
      c.set("user", USER as never);
      c.set("tenantId", "tenant-1");
    }
    await next();
  });
  hono.delete("/api/v1/tenants/:id", () => {
    throw new ProblemError(403, "Insufficient role");
  });
  hono.post("/api/v1/backup", () => {
    throw new ProblemError(403, "Demo installation is read-only", { type: DEMO_READ_ONLY_PROBLEM });
  });
  hono.get("/api/v1/missing", () => {
    throw new ProblemError(404, "Not Found");
  });
  return { hono, written };
}

describe("deniedAudit", () => {
  it("records a signed-in user's 403 with the route pattern, never the raw URL", async () => {
    const { hono, written } = app();
    const response = await hono.request("/api/v1/tenants/<script>?x=1", { method: "DELETE" });
    expect(response.status).toBe(403);
    expect(written).toEqual([
      {
        userId: "user-1",
        actor: "tech@provider.example",
        tenantId: "tenant-1",
        method: "DELETE",
        route: "/api/v1/tenants/:id",
        reason: "Insufficient role",
        ip: null,
      },
    ]);
  });

  it("ignores anonymous requests, other statuses and the demo's read-only refusals", async () => {
    const anonymous = app({ signedIn: false });
    await anonymous.hono.request("/api/v1/tenants/a", { method: "DELETE" });
    expect(anonymous.written).toEqual([]);

    const signedIn = app();
    await signedIn.hono.request("/api/v1/backup", { method: "POST" });
    await signedIn.hono.request("/api/v1/missing");
    expect(signedIn.written).toEqual([]);
  });

  it("writes one entry per user, route and reason within the window", async () => {
    let time = 0;
    const { hono, written } = app({ now: () => time });
    for (let i = 0; i < 5; i++) {
      await hono.request(`/api/v1/tenants/t${i}`, { method: "DELETE" });
    }
    expect(written).toHaveLength(1);
    time = 11 * 60 * 1000;
    await hono.request("/api/v1/tenants/t9", { method: "DELETE" });
    expect(written).toHaveLength(2);
  });

  it("never turns the refusal into an error when recording fails", async () => {
    const hono = new Hono<TenantEnv>();
    hono.onError(errorHandler);
    hono.use(
      "*",
      deniedAudit({
        write: async () => {
          throw new Error("database down");
        },
      }),
    );
    hono.use("*", async (c, next) => {
      c.set("user", USER as never);
      await next();
    });
    hono.get("/x", () => {
      throw new ProblemError(403, "Provider role required");
    });
    expect((await hono.request("/x")).status).toBe(403);
  });
});

describe("deniedAudit with mounted feature routers", () => {
  it("sees refusals thrown inside a sub-app, with the sub-app's route pattern", async () => {
    const written: DeniedEvent[] = [];
    const root = new Hono<TenantEnv>();
    root.onError(errorHandler);
    root.use(
      "*",
      deniedAudit({
        write: async (event) => {
          written.push(event);
        },
      }),
    );
    const feature = new Hono<TenantEnv>();
    feature.use("*", async (c, next) => {
      c.set("user", USER as never);
      await next();
    });
    feature.post("/:id/restore", () => {
      throw new ProblemError(403, "Tenant not in your scope");
    });
    root.route("/api/v1/snapshots", feature);
    expect((await root.request("/api/v1/snapshots/abc/restore", { method: "POST" })).status).toBe(
      403,
    );
    expect(written).toMatchObject([
      { route: "/api/v1/snapshots/:id/restore", reason: "Tenant not in your scope" },
    ]);
  });
});

describe("DeniedThrottle", () => {
  it("allows a key again after the window", () => {
    const throttle = new DeniedThrottle(1000);
    expect(throttle.allow("a", 0)).toBe(true);
    expect(throttle.allow("a", 999)).toBe(false);
    expect(throttle.allow("b", 999)).toBe(true);
    expect(throttle.allow("a", 1000)).toBe(true);
  });
});
