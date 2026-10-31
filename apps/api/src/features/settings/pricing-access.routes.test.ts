import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler, notFoundHandler } from "../../problem.js";

/**
 * Who may read or change a price. The prices are the provider's business figures: only members of
 * the provider team (provider admins) get them. This runs every route that serves or changes a
 * price through the real routers and session middleware, with better-auth's session lookup, the
 * database handles and the services replaced at their module boundary, as a tenant's own
 * administrator, a tenant's end user, a tenant or provider API key, and nobody signed in, and
 * proves that none of them gets an answer (and that no service is even asked). The same through
 * the real application, with real sessions and a real database, is in tenant-pricing.pg.test.ts.
 */

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getPricing: vi.fn(),
  updatePricing: vi.fn(),
  loadPricingEstimate: vi.fn(),
  getTenantPricing: vi.fn(),
  updateTenantPricing: vi.fn(),
  memberships: [] as unknown[],
}));

vi.mock("../../auth.js", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("../../db.js", () => {
  // Membership and provider-team lookups: `select().from().where()` resolves to the rows.
  const chain = (): unknown =>
    new Proxy(() => undefined, {
      get: (_target, property) =>
        property === "then"
          ? (resolve: (value: unknown) => void) => resolve(mocks.memberships)
          : () => chain(),
    });
  const db = { select: chain };
  return { db, providerDb: db, authDb: db };
});
vi.mock("./pricing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pricing.js")>()),
  getPricing: mocks.getPricing,
  updatePricing: mocks.updatePricing,
}));
vi.mock("./pricing-estimate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pricing-estimate.js")>()),
  loadPricingEstimate: mocks.loadPricingEstimate,
}));
vi.mock("./tenant-pricing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tenant-pricing.js")>()),
  getTenantPricing: mocks.getTenantPricing,
  updateTenantPricing: mocks.updateTenantPricing,
}));
vi.mock("../../lib/features.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/features.js")>()),
  requireFeature: vi.fn(async () => undefined),
}));

const { settingsRoutes } = await import("./routes.js");
const { tenantsRoutes } = await import("../tenants/routes.js");

const TENANT = "5a0c7c1e-8d2b-4c3a-9f1e-2b3c4d5e6f70";

function app() {
  const root = new Hono();
  root.onError(errorHandler);
  root.notFound(notFoundHandler);
  root.route("/api/v1/settings", settingsRoutes);
  root.route("/api/v1/tenants", tenantsRoutes);
  return root;
}

function signedIn(role: "admin" | "user") {
  mocks.getSession.mockResolvedValue({
    session: {
      id: "session-id",
      authMethod: "passkey",
      impersonatedBy: null,
      activeOrganizationId: "org-1",
      createdAt: new Date(),
    },
    user: {
      id: `${role}-id`,
      email: `${role}@example.test`,
      role,
      banned: false,
      twoFactorEnabled: false,
    },
  });
}

async function call(method: string, path: string, key?: string, body?: unknown) {
  const headers = new Headers({ "content-type": "application/json" });
  if (key) {
    headers.set("authorization", `Bearer ${key}`);
  }
  const response = await app().request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, text };
}

/** Every route that serves or changes a price, with a valid request for it. */
const PRICE_ROUTES: [string, string, unknown?][] = [
  ["GET", "/api/v1/settings/pricing"],
  ["PUT", "/api/v1/settings/pricing", { mailboxPrice: 2 }],
  ["GET", "/api/v1/settings/pricing/estimate"],
  ["GET", `/api/v1/settings/pricing/estimate?tenant=${TENANT}`],
  ["GET", `/api/v1/tenants/${TENANT}/pricing`],
  ["PUT", `/api/v1/tenants/${TENANT}/pricing`, { mailboxPrice: 1 }],
];

const SECRET_FIGURE = 4711.42;

function priceServicesNotAsked() {
  expect(mocks.getPricing).not.toHaveBeenCalled();
  expect(mocks.updatePricing).not.toHaveBeenCalled();
  expect(mocks.loadPricingEstimate).not.toHaveBeenCalled();
  expect(mocks.getTenantPricing).not.toHaveBeenCalled();
  expect(mocks.updateTenantPricing).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memberships = [];
  const answer = { currency: "EUR", total: SECRET_FIGURE, mailboxPrice: SECRET_FIGURE };
  mocks.getPricing.mockResolvedValue(answer);
  mocks.updatePricing.mockResolvedValue(answer);
  mocks.loadPricingEstimate.mockResolvedValue(answer);
  mocks.getTenantPricing.mockResolvedValue(answer);
  mocks.updateTenantPricing.mockResolvedValue(answer);
});

describe("who gets a price", () => {
  for (const [method, path, body] of PRICE_ROUTES) {
    const route = `${method} ${path.replace(TENANT, ":id")}`;

    it(`${route}: 401 without a session`, async () => {
      mocks.getSession.mockResolvedValue(null);
      const response = await call(method, path, undefined, body);
      expect(response.status).toBe(401);
      expect(response.text).not.toContain(String(SECRET_FIGURE));
      priceServicesNotAsked();
    });

    it(`${route}: 403 for a tenant's own administrator`, async () => {
      signedIn("user");
      mocks.memberships = [{ organizationId: "org-1", role: "owner" }];
      const response = await call(method, path, undefined, body);
      expect(response.status).toBe(403);
      expect(response.text).not.toContain(String(SECRET_FIGURE));
      priceServicesNotAsked();
    });

    it(`${route}: 403 for a tenant's end user`, async () => {
      signedIn("user");
      mocks.memberships = [{ organizationId: "org-1", role: "member" }];
      const response = await call(method, path, undefined, body);
      expect(response.status).toBe(403);
      expect(response.text).not.toContain(String(SECRET_FIGURE));
      priceServicesNotAsked();
    });

    it(`${route}: nothing for an API key, a tenant's or the provider's`, async () => {
      // A key is no session: it reaches none of these routes, whatever it belongs to.
      mocks.getSession.mockResolvedValue(null);
      for (const key of ["rsk_contoso_0123456789abcdef", "rsk_provider_0123456789abcdef"]) {
        const response = await call(method, path, key, body);
        expect([401, 403], key).toContain(response.status);
        expect(response.text).not.toContain(String(SECRET_FIGURE));
      }
      priceServicesNotAsked();
    });
  }

  for (const [method, path, body] of PRICE_ROUTES.filter(([, path]) =>
    path.includes("/settings/"),
  )) {
    it(`${method} ${path.replace(TENANT, ":id")}: a key is refused even beside a provider admin's session`, async () => {
      signedIn("admin");
      const response = await call(method, path, "rsk_provider_0123456789abcdef", body);
      expect(response.status).toBe(403);
      priceServicesNotAsked();
    });
  }

  it("serves a provider admin every one of them", async () => {
    signedIn("admin");
    for (const [method, path, body] of PRICE_ROUTES) {
      const response = await call(method, path, undefined, body);
      expect(response.status, `${method} ${path}`).toBe(200);
      expect(response.text).toContain(String(SECRET_FIGURE));
    }
  });
});
