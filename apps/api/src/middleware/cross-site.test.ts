import type { Database } from "@restow/db";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { errorHandler } from "../problem.js";
import { type ScriptedDb, scriptedDb } from "../routes/v1/testing/scripted-db.js";

/**
 * Cross-site request protection of the session routes, through the real
 * middlewares: better-auth's session lookup and the database are replaced at
 * their module boundary. A provider admin is signed in throughout, so the
 * session itself never stands in the way; what decides is where the request
 * comes from and what its body is.
 */

const state = vi.hoisted(() => ({
  getSession: vi.fn(),
  db: null as unknown,
}));

vi.mock("../auth.js", () => ({ auth: { api: { getSession: state.getSession } } }));
vi.mock("../db.js", () => {
  const pool = new Proxy(
    {},
    { get: (_target, property) => (state.db as Record<PropertyKey, unknown>)[property] },
  );
  return { db: pool, providerDb: pool };
});

const { requireProviderAdmin, requireSession, requireTenant } = await import("./session.js");
const { requireTenantOrApiKey } = await import("./apiKey.js");

const TENANT = "5a0c7c1e-8d2b-4c3a-9f1e-2b3c4d5e6f70";
const APP_ORIGIN = "https://restow.example.com";
const COOKIE = { cookie: "better-auth.session_token=signed-session-token" };
const API_KEY = `rsk_contoso_${"A".repeat(40)}`;

const tenantRow = {
  id: TENANT,
  name: "Contoso",
  slug: "contoso",
  organizationId: "org-contoso",
  status: "active",
};

/** What the browser adds to a request made by the Restow web app itself. */
const SAME_ORIGIN = { origin: APP_ORIGIN, "sec-fetch-site": "same-origin" };

/** The request as the API sees it behind the Caddy edge. */
const BEHIND_EDGE = { "x-forwarded-proto": "https", "x-forwarded-host": "restow.example.com" };

const JSON_BODY = { "content-type": "application/json" };

let script: ScriptedDb;

/** No settings row: no public origin stored by the setup wizard. */
const NO_SETTINGS: unknown[][] = [[]];

/** The provider team lookup of the signed-in provider admin: no row, so an owner. */
const NO_TEAM_ROW: unknown[] = [];

function app(results: unknown[][] = NO_SETTINGS) {
  script = scriptedDb(results);
  state.db = script.db as Database;
  const hono = new Hono();
  hono.onError(errorHandler);
  const ok = (c: { json: (body: unknown) => Response }) => c.json({ ok: true });
  hono.post("/session", requireSession, ok);
  hono.delete("/session", requireSession, ok);
  hono.get("/session", requireSession, ok);
  hono.post("/provider", requireProviderAdmin, ok);
  hono.patch("/tenant", requireTenant("tenant_admin"), ok);
  hono.post("/either", requireTenantOrApiKey("restore:write"), ok);
  return hono;
}

function send(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  const { method = "POST", headers = {}, body } = init;
  const withLength =
    body === undefined ? headers : { "content-length": String(body.length), ...headers };
  return app().request(`http://api.internal:3000${path}`, {
    method,
    headers: { ...COOKIE, ...withLength },
    body,
  });
}

async function problemOf(response: Response): Promise<{ type: string; title: string }> {
  return (await response.json()) as { type: string; title: string };
}

const publicUrl = config.publicUrl;

beforeEach(() => {
  vi.clearAllMocks();
  config.publicUrl = undefined;
  state.getSession.mockResolvedValue({
    session: { id: "session-id", userId: "ops-id", authMethod: "passkey", impersonatedBy: null },
    user: { id: "ops-id", email: "ops@provider.example", role: "admin", banned: false },
  });
});

afterEach(() => {
  config.publicUrl = publicUrl;
});

describe("a state-changing request from another site", () => {
  const attacks: [string, Record<string, string>][] = [
    [
      "a cross-site form post",
      { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    ],
    ["a request the browser marks cross-site", { "sec-fetch-site": "cross-site" }],
    ["a request from a sibling host of the same site", { "sec-fetch-site": "same-site" }],
    ["a request with a foreign Origin", { origin: "https://attacker.example" }],
    ["a request from an opaque origin", { origin: "null" }],
    ["a same-host request over another scheme", { origin: "http://restow.example.com" }],
  ];

  it.each(attacks)("refuses %s with 403 before looking at the session", async (_name, headers) => {
    const res = await send("/session", {
      headers: { ...BEHIND_EDGE, ...JSON_BODY, ...headers },
      body: '{"name":"x"}',
    });
    expect(res.status).toBe(403);
    expect(await problemOf(res)).toMatchObject({
      type: "urn:restow:problem:cross-site-request",
      title: "Cross-site request refused",
    });
    expect(state.getSession).not.toHaveBeenCalled();
  });

  it("is refused on every session gate", async () => {
    const attack = { origin: "https://attacker.example", "sec-fetch-site": "cross-site" };
    for (const [method, path] of [
      ["DELETE", "/session"],
      ["POST", "/provider"],
      ["PATCH", "/tenant"],
      ["POST", "/either"],
    ] as const) {
      const res = await send(path, { method, headers: { ...BEHIND_EDGE, ...attack } });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(state.getSession).not.toHaveBeenCalled();
  });

  it("may still read: safe methods are not state changes", async () => {
    const res = await send("/session", {
      method: "GET",
      headers: { "sec-fetch-site": "cross-site", origin: "https://attacker.example" },
    });
    expect(res.status).toBe(200);
  });
});

describe("a request body that is not JSON", () => {
  const bodies: [string, string, string][] = [
    ["text/plain", "text/plain;charset=UTF-8", '{"role":"tenant_admin"}'],
    ["a urlencoded form", "application/x-www-form-urlencoded", "role=tenant_admin"],
    ["a multipart form", "multipart/form-data; boundary=x", "--x--"],
  ];

  it.each(bodies)("is refused with 415 when sent as %s", async (_name, type, body) => {
    const res = await send("/session", {
      headers: { ...BEHIND_EDGE, ...SAME_ORIGIN, "content-type": type },
      body,
    });
    expect(res.status).toBe(415);
    expect(await problemOf(res)).toMatchObject({
      type: "urn:restow:problem:unsupported-media-type",
    });
    expect(state.getSession).not.toHaveBeenCalled();
  });

  it("is refused without Origin and Sec-Fetch-Site too", async () => {
    const res = await send("/session", {
      headers: { "content-type": "text/plain" },
      body: '{"role":"tenant_admin"}',
    });
    expect(res.status).toBe(415);
  });

  it("is refused when the length is unknown (chunked)", async () => {
    const res = await app().request("/session", {
      method: "POST",
      headers: { ...COOKIE, "transfer-encoding": "chunked", "content-type": "text/plain" },
      body: "{}",
    });
    expect(res.status).toBe(415);
  });
});

describe("requests the web app and other clients make", () => {
  it("accepts a same-origin JSON request behind the edge", async () => {
    const res = await send("/session", {
      headers: {
        ...BEHIND_EDGE,
        ...SAME_ORIGIN,
        "content-type": "application/json; charset=utf-8",
      },
      body: '{"name":"x"}',
    });
    expect(res.status).toBe(200);
  });

  it("accepts a same-origin request without the edge", async () => {
    const res = await app().request("http://localhost:3000/session", {
      method: "POST",
      headers: { ...COOKIE, origin: "http://localhost:3000", ...JSON_BODY },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  it("accepts bodyless changes (cancel, retry, delete)", async () => {
    for (const method of ["POST", "DELETE"]) {
      const res = await send("/session", {
        method,
        headers: { ...BEHIND_EDGE, ...SAME_ORIGIN, "content-length": "0" },
      });
      expect(res.status, method).toBe(200);
    }
  });

  it("accepts clients that are not browsers (no Origin, no Sec-Fetch-Site)", async () => {
    const res = await send("/session", { headers: JSON_BODY, body: '{"name":"x"}' });
    expect(res.status).toBe(200);
  });

  it("accepts the web app behind a proxy that rewrites the host", async () => {
    // The Vite dev server proxies /api with a rewritten Host and no forwarding headers;
    // the browser still reports its own origin as the one it called.
    // The team lookup, and a settings row nobody asks for.
    const res = await app([NO_TEAM_ROW, []]).request("http://localhost:3000/session", {
      method: "POST",
      headers: {
        ...COOKIE,
        origin: "http://localhost:5173",
        "sec-fetch-site": "same-origin",
        ...JSON_BODY,
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(script.pending()).toBe(1);
  });

  it("accepts the configured public origin from a browser without Sec-Fetch-Site", async () => {
    config.publicUrl = "http://localhost:5173";
    const res = await app([[], NO_TEAM_ROW]).request("http://localhost:3000/session", {
      method: "POST",
      headers: { ...COOKIE, origin: "http://localhost:5173", ...JSON_BODY },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  it("accepts the public origin stored by the setup wizard", async () => {
    const hono = app([[{ publicUrl: "http://localhost:5173" }], NO_TEAM_ROW]);
    const res = await hono.request("http://localhost:3000/session", {
      method: "POST",
      headers: { ...COOKIE, origin: "http://localhost:5173", ...JSON_BODY },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(script.pending()).toBe(0);
  });

  it("reaches the tenant gate for a same-origin change", async () => {
    const hono = app([NO_TEAM_ROW, [tenantRow]]);
    const res = await hono.request("http://api.internal:3000/tenant", {
      method: "PATCH",
      headers: {
        ...COOKIE,
        ...BEHIND_EDGE,
        ...SAME_ORIGIN,
        ...JSON_BODY,
        "x-restow-tenant": TENANT,
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(script.pending()).toBe(0);
  });

  it("leaves API-key requests to the key rules", async () => {
    const hono = app([
      // The key lookup, then the key's tenant.
      [
        {
          id: "key-id",
          tenantId: TENANT,
          scopes: ["restore:write"],
          expiresAt: null,
          revokedAt: null,
          lastUsedAt: new Date(),
          tenantStatus: "active",
        },
      ],
      [{ ...tenantRow, mailboxCap: null, createdAt: new Date() }],
    ]);
    const res = await hono.request("http://api.internal:3000/either", {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
        "content-type": "text/plain",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(state.getSession).not.toHaveBeenCalled();
  });
});
