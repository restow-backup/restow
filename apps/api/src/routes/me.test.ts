import type { MiddlewareHandler } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerApiExtension, resetExtensionsForTesting } from "../extensions.js";
import type { SessionEnv, SessionVariables } from "../middleware/session.js";
import { me } from "./me.js";
import type { VersionInfo } from "./v1/version.js";

/**
 * GET /api/v1/me with the session, the tenant lookup and the version source
 * replaced at their module boundaries: the route's own mapping (roles,
 * states, active tenant, version, gated features, extension fields) is what
 * is under test. Extensions register through the real registry.
 */

const state = vi.hoisted(() => ({
  session: null as unknown as SessionVariables,
  rows: [] as {
    id: string;
    name: string;
    slug: string;
    status: "active" | "suspended" | "deleting";
    organizationId: string | null;
  }[],
  version: null as unknown as VersionInfo,
}));

vi.mock("../middleware/session.js", () => {
  const requireSession: MiddlewareHandler<SessionEnv> = async (c, next) => {
    c.set("auth", state.session.auth);
    c.set("user", state.session.user);
    c.set("isProviderAdmin", state.session.isProviderAdmin);
    c.set("memberships", state.session.memberships);
    await next();
  };
  return { requireSession };
});

vi.mock("../db.js", () => {
  // `select().from().orderBy()` and `select().from().where().orderBy()`.
  const rows = () => Promise.resolve(state.rows);
  const chain = { orderBy: rows, where: () => ({ orderBy: rows }) };
  return { db: {}, providerDb: { select: () => ({ from: () => chain }) } };
});

vi.mock("./v1.js", () => ({
  versionSource: { current: () => state.version },
}));

const CONTOSO_ORG = "org-contoso";
const FABRIKAM_ORG = "org-fabrikam";

function sessionOf(
  overrides: Partial<SessionVariables> & { activeOrganizationId?: string | null },
): SessionVariables {
  const { activeOrganizationId = null, ...rest } = overrides;
  return {
    auth: { session: { activeOrganizationId } } as unknown as SessionVariables["auth"],
    user: {
      id: "user-1",
      name: "Alex Example",
      email: "alex@example.test",
      role: "user",
    } as unknown as SessionVariables["user"],
    isProviderAdmin: false,
    providerAccess: null,
    memberships: [],
    ...rest,
  };
}

async function getMe(): Promise<Record<string, unknown>> {
  const response = await me.request("/");
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

afterEach(() => {
  resetExtensionsForTesting();
});

beforeEach(() => {
  state.rows = [
    {
      id: "t-contoso",
      name: "Contoso",
      slug: "contoso",
      status: "active",
      organizationId: CONTOSO_ORG,
    },
    {
      id: "t-fabrikam",
      name: "Fabrikam",
      slug: "fabrikam",
      status: "suspended",
      organizationId: FABRIKAM_ORG,
    },
  ];
  state.version = {
    running: "0.301.0",
    commit: "9272693",
    latest: "0.302.0",
    updateAvailable: true,
    releaseUrl: "https://example.test/releases/v0.302.0",
    updateCheck: "ok",
    checkedAt: "2026-09-23T10:00:00.000Z",
    channel: "stable",
    latestTag: null,
    publishedAt: null,
    checkError: null,
    maintenance: null,
  };
});

describe("GET /api/v1/me", () => {
  it("returns the running version from the shared version source", async () => {
    state.session = sessionOf({});
    const body = await getMe();
    expect(body.version).toEqual({
      running: "0.301.0",
      commit: "9272693",
      latest: "0.302.0",
      updateAvailable: true,
      releaseUrl: "https://example.test/releases/v0.302.0",
      updateCheck: "ok",
      checkedAt: "2026-09-23T10:00:00.000Z",
      channel: "stable",
      latestTag: null,
      publishedAt: null,
      checkError: null,
      maintenance: null,
    });
  });

  it("reports a build without a release tag honestly", async () => {
    state.session = sessionOf({});
    state.version = {
      running: null,
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
    const body = await getMe();
    expect(body.version).toMatchObject({ running: null, updateCheck: "disabled" });
  });

  it("lists each tenant with the member's role there and its status", async () => {
    state.session = sessionOf({
      memberships: [
        { organizationId: CONTOSO_ORG, role: "admin" },
        { organizationId: FABRIKAM_ORG, role: "member" },
      ],
      activeOrganizationId: FABRIKAM_ORG,
    });
    const body = await getMe();
    expect(body.role).toBe("tenant_admin");
    expect(body.tenants).toEqual([
      { id: "t-contoso", name: "Contoso", slug: "contoso", role: "tenant_admin", status: "active" },
      {
        id: "t-fabrikam",
        name: "Fabrikam",
        slug: "fabrikam",
        role: "tenant_user",
        status: "suspended",
      },
    ]);
    expect(body.activeTenantId).toBe("t-fabrikam");
    expect(body).not.toHaveProperty("edition");
  });

  it("reports no gated feature and no extension field without extensions", async () => {
    state.session = sessionOf({});
    const body = await getMe();
    expect(body.features).toEqual([]);
    expect(body.extensions).toEqual({});
  });

  it("reports what registered extensions enable and add", async () => {
    registerApiExtension({
      name: "test",
      featureGate: { isEnabled: async (_db, feature) => feature === "stats.allTenants" },
      sessionFields: [{ key: "plan", load: async ({ isProviderAdmin }) => ({ isProviderAdmin }) }],
    });
    state.session = sessionOf({});
    const body = await getMe();
    expect(body.features).toEqual(["stats.allTenants"]);
    expect(body.extensions).toEqual({ plan: { isProviderAdmin: false } });
  });

  it("gives provider admins every tenant", async () => {
    state.session = sessionOf({
      isProviderAdmin: true,
      user: {
        id: "admin-1",
        name: "Provider Admin",
        email: "admin@provider.test",
        role: "admin",
      } as unknown as SessionVariables["user"],
    });
    const body = await getMe();
    expect(body.role).toBe("provider_admin");
    expect((body.tenants as { id: string }[]).map((tenant) => tenant.id)).toEqual([
      "t-contoso",
      "t-fabrikam",
    ]);
    expect(body.activeTenantId).toBeNull();
  });
});
