import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler, notFoundHandler } from "../../problem.js";

/**
 * Route test of PUT /settings/mail/not-needed (the Start checklist's "Not
 * needed"): the real router and session middleware, with better-auth's session
 * lookup, the database handles and the service replaced at their module
 * boundary. Who may reach it, what it accepts and what it hands to the service.
 */

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  setMailNotNeeded: vi.fn(),
  memberships: [] as unknown[],
}));

vi.mock("../../auth.js", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("../../db.js", () => {
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
vi.mock("./service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./service.js")>()),
  setMailNotNeeded: mocks.setMailNotNeeded,
}));

const { settingsRoutes } = await import("./routes.js");

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

async function put(body: unknown, key?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (key) {
    headers.set("authorization", `Bearer ${key}`);
  }
  const response = await app().request("/api/v1/settings/mail/not-needed", {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memberships = [];
  mocks.setMailNotNeeded.mockImplementation(async (_db: unknown, notNeeded: boolean) => ({
    notNeeded,
  }));
});

describe("PUT /settings/mail/not-needed", () => {
  it("401 without a session", async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await put({ notNeeded: true })).status).toBe(401);
    expect(mocks.setMailNotNeeded).not.toHaveBeenCalled();
  });

  it("403 for a tenant admin or tenant user", async () => {
    signedIn("user");
    mocks.memberships = [{ organizationId: "org-1", role: "owner" }];
    expect((await put({ notNeeded: true })).status).toBe(403);
    mocks.memberships = [{ organizationId: "org-1", role: "member" }];
    expect((await put({ notNeeded: true })).status).toBe(403);
    expect(mocks.setMailNotNeeded).not.toHaveBeenCalled();
  });

  it("403 for an API key, even a provider key", async () => {
    signedIn("admin");
    const response = await put({ notNeeded: true }, "rsk_provider_0123456789abcdef");
    expect(response.status).toBe(403);
    expect(response.body.type).toBe("urn:restow:problem:session-required");
  });

  it("marks and unmarks the mail as the signed-in provider admin", async () => {
    signedIn("admin");
    expect(await put({ notNeeded: true })).toMatchObject({
      status: 200,
      body: { notNeeded: true },
    });
    expect(await put({ notNeeded: false })).toMatchObject({
      status: 200,
      body: { notNeeded: false },
    });
    expect(mocks.setMailNotNeeded.mock.calls.map((call) => call[1])).toEqual([true, false]);
    expect(mocks.setMailNotNeeded.mock.calls[0]?.[2]).toMatchObject({
      id: "admin-id",
      email: "admin@provider.test",
    });
  });

  it("422 for a body that is not exactly { notNeeded: boolean }", async () => {
    signedIn("admin");
    for (const body of [{}, { notNeeded: "yes" }, { notNeeded: true, other: 1 }, []]) {
      expect((await put(body)).status, JSON.stringify(body)).toBe(422);
    }
    expect(mocks.setMailNotNeeded).not.toHaveBeenCalled();
  });
});
