import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler, notFoundHandler } from "../../../problem.js";

/**
 * Route tests of /settings/microsoft-app: the real router and session
 * middleware, with better-auth's session lookup, the database handles and the
 * feature service replaced at their module boundary. Who may reach the
 * endpoints, and which requests are refused before the service runs.
 */

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getMicrosoftApp: vi.fn(),
  saveMicrosoftApp: vi.fn(),
  testMicrosoftApp: vi.fn(),
  removeMicrosoftApp: vi.fn(),
  memberships: [] as unknown[],
}));

vi.mock("../../../auth.js", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("../../../db.js", () => {
  // Membership lookups of non-provider users: `select().from().where()` resolves to the rows.
  const chain = (): unknown =>
    new Proxy(() => undefined, {
      get: (_target, property) =>
        property === "then"
          ? (resolve: (value: unknown) => void) => resolve(mocks.memberships)
          : () => chain(),
    });
  const db = { select: chain };
  return { db, providerDb: db };
});
vi.mock("./service.js", () => ({
  getMicrosoftApp: mocks.getMicrosoftApp,
  saveMicrosoftApp: mocks.saveMicrosoftApp,
  testMicrosoftApp: mocks.testMicrosoftApp,
  removeMicrosoftApp: mocks.removeMicrosoftApp,
}));

const { settingsRoutes } = await import("../routes.js");

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";

function app() {
  const root = new Hono();
  root.onError(errorHandler);
  root.notFound(notFoundHandler);
  root.route("/api/v1/settings", settingsRoutes);
  return root;
}

function signedIn(role: "admin" | "user") {
  mocks.getSession.mockResolvedValue({
    session: { authMethod: "passkey", impersonatedBy: null, activeOrganizationId: "org-1" },
    user: {
      id: `${role}-id`,
      email: `${role}@provider.test`,
      role,
      banned: false,
      twoFactorEnabled: false,
    },
  });
}

async function call(method: string, path: string, init: { body?: unknown; key?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (init.key) {
    headers.set("authorization", `Bearer ${init.key}`);
  }
  const response = await app().request(`/api/v1/settings${path}`, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null, text };
}

const ENDPOINTS: [string, string, unknown?][] = [
  ["GET", "/microsoft-app"],
  ["PUT", "/microsoft-app", { clientId: CLIENT_ID, clientSecret: "value" }],
  ["POST", "/microsoft-app/test", {}],
  ["DELETE", "/microsoft-app"],
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memberships = [];
  mocks.getMicrosoftApp.mockResolvedValue({ source: "none" });
  mocks.saveMicrosoftApp.mockResolvedValue({ source: "database" });
  mocks.removeMicrosoftApp.mockResolvedValue({ source: "none" });
  mocks.testMicrosoftApp.mockResolvedValue({ ok: true });
});

describe("who may use /settings/microsoft-app", () => {
  for (const [method, path, body] of ENDPOINTS) {
    it(`${method} ${path}: 401 without a session`, async () => {
      mocks.getSession.mockResolvedValue(null);
      expect((await call(method, path, { body })).status).toBe(401);
    });

    it(`${method} ${path}: 403 for a tenant admin or tenant user`, async () => {
      signedIn("user");
      mocks.memberships = [{ organizationId: "org-1", role: "owner" }];
      expect((await call(method, path, { body })).status).toBe(403);
      mocks.memberships = [{ organizationId: "org-1", role: "member" }];
      expect((await call(method, path, { body })).status).toBe(403);
    });

    it(`${method} ${path}: 403 for an API key, even a provider key`, async () => {
      signedIn("admin");
      const response = await call(method, path, { body, key: "rsk_provider_0123456789abcdef" });
      expect(response.status).toBe(403);
      expect(response.body.type).toBe("urn:restow:problem:session-required");
    });
  }

  it("serves provider admins", async () => {
    signedIn("admin");
    expect(await call("GET", "/microsoft-app")).toMatchObject({
      status: 200,
      body: { source: "none" },
    });
    expect(mocks.getMicrosoftApp).toHaveBeenCalledOnce();
    expect((await call("DELETE", "/microsoft-app")).status).toBe(200);
    expect(mocks.removeMicrosoftApp.mock.calls[0]?.[1]).toMatchObject({
      id: "admin-id",
      email: "admin@provider.test",
    });
  });
});

describe("PUT /settings/microsoft-app validation", () => {
  beforeEach(() => signedIn("admin"));

  function reasons(body: { issues?: { path: unknown[]; message: string }[] }) {
    return (body.issues ?? []).map((issue) => `${issue.path.join(".")}:${issue.message}`);
  }

  it("refuses a client id that is not a GUID", async () => {
    const response = await call("PUT", "/microsoft-app", {
      body: { clientId: "Restow", clientSecret: "value" },
    });
    expect(response.status).toBe(422);
    expect(reasons(response.body)).toEqual(["clientId:guid"]);
    expect(mocks.saveMicrosoftApp).not.toHaveBeenCalled();
  });

  it("recognises the secret's ID pasted instead of its value", async () => {
    const response = await call("PUT", "/microsoft-app", {
      body: { clientId: CLIENT_ID, clientSecret: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    });
    expect(reasons(response.body)).toEqual(["clientSecret:secretIsId"]);
    expect(response.text).not.toContain("aaaaaaaa-bbbb");
  });

  it("refuses a secret and a certificate at once, unknown fields, plain-http and non-Microsoft authorities", async () => {
    const both = await call("PUT", "/microsoft-app", {
      body: { clientId: CLIENT_ID, clientSecret: "value", certificatePem: "pem" },
    });
    expect(reasons(both.body)).toEqual(["certificatePem:credentialConflict"]);

    const http = await call("PUT", "/microsoft-app", {
      body: { clientId: CLIENT_ID, authorityHost: "http://login.example.com" },
    });
    expect(reasons(http.body)).toEqual(["authorityHost:authorityHost"]);

    // Well-formed https, but not one of Microsoft's own login hosts (MEDIUM-1: this
    // value later drives outbound token requests and customer consent links).
    const untrusted = await call("PUT", "/microsoft-app", {
      body: { clientId: CLIENT_ID, authorityHost: "https://169.254.169.254" },
    });
    expect(reasons(untrusted.body)).toEqual(["authorityHost:authorityHost"]);

    const extra = await call("PUT", "/microsoft-app", {
      body: { clientId: CLIENT_ID, clientSecretId: "x" },
    });
    expect(extra.status).toBe(422);
    expect(mocks.saveMicrosoftApp).not.toHaveBeenCalled();
  });

  it("hands a valid save to the service, normalised", async () => {
    const response = await call("PUT", "/microsoft-app", {
      body: {
        clientId: CLIENT_ID.toUpperCase(),
        clientSecret: "  Xy7~value  ",
        secretExpiresAt: "2028-09-23",
        homeTenantId: "Contoso.OnMicrosoft.com",
        authorityHost: "https://login.microsoftonline.us/",
      },
    });
    expect(response.status).toBe(200);
    expect(mocks.saveMicrosoftApp.mock.calls[0]?.[1]).toEqual({
      clientId: CLIENT_ID,
      clientSecret: "Xy7~value",
      certificatePem: undefined,
      secretExpiresAt: "2028-09-23T00:00:00.000Z",
      homeTenantId: "contoso.onmicrosoft.com",
      authorityHost: "https://login.microsoftonline.us",
    });
  });
});

describe("POST /settings/microsoft-app/test", () => {
  beforeEach(() => signedIn("admin"));

  it("accepts an empty body and a tenant to test in", async () => {
    await call("POST", "/microsoft-app/test");
    expect(mocks.testMicrosoftApp.mock.calls[0]?.[1]).toEqual({ tenantId: null });
    await call("POST", "/microsoft-app/test", { body: { tenantId: "Contoso.com" } });
    expect(mocks.testMicrosoftApp.mock.calls[1]?.[1]).toEqual({ tenantId: "contoso.com" });
  });

  it("refuses a malformed tenant", async () => {
    const response = await call("POST", "/microsoft-app/test", {
      body: { tenantId: "not a tenant" },
    });
    expect(response.status).toBe(422);
    expect(mocks.testMicrosoftApp).not.toHaveBeenCalled();
  });
});
