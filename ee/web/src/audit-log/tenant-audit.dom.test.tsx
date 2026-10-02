// @vitest-environment happy-dom
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type Mounted,
  enableActEnvironment,
  flush,
  json,
  mount,
  newQueryClient,
  sessionAs,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import { AuditPage, TenantAuditSection } from "./audit-page";
import { auditNavItems, auditTenantSections } from "./index";

/**
 * The audit log on a tenant's page: the section lists only that tenant's log
 * for a provider admin and for the tenant's own admin, the temporary menu entry
 * for tenant admins is gone, and the old address leads a tenant admin there.
 */

enableActEnvironment();

const MUELLER = {
  id: "mueller",
  name: "Müller GmbH",
  slug: "mueller",
  kind: "customer" as const,
  customerNumber: null,
  role: "tenant_admin" as const,
  status: "active" as const,
};

let mounted: Mounted | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function stubApi(): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      urls.push(`${url.pathname}${url.search}`);
      const path = url.pathname.replace(/^\/api\/v1/, "");
      if (path === "/audit") {
        return json({ items: [], next: null });
      }
      if (path === "/audit/actions") {
        return json({ items: [] });
      }
      if (path === "/audit/verify") {
        return json({
          status: "empty",
          verifiedAt: "2026-09-30T12:00:00.000Z",
          durationMs: 4,
          chains: [],
        });
      }
      throw new Error(`Unrouted request: ${path}`);
    }),
  );
  return urls;
}

async function openAt(path: string, session: ReturnType<typeof sessionAs>) {
  const root = createRootRoute();
  const audit = createRoute({ getParentRoute: () => root, path: "/audit", component: AuditPage });
  const section = createRoute({
    getParentRoute: () => root,
    path: "/tenants/$tenantId/$section",
    component: function Section() {
      const { tenantId } = section.useParams();
      return createElement(TenantAuditSection, { tenant: { id: tenantId } });
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([audit, section]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  mounted = mount(<RouterProvider router={router} />, {
    session,
    queryClient: newQueryClient(),
  });
  await flush(6);
  return router;
}

describe("the audit log as a section of the tenant page", () => {
  it("sits between Members and Master data, locked below Business, and no menu entry is left for tenant admins", () => {
    expect(auditTenantSections).toHaveLength(1);
    const [section] = auditTenantSections;
    expect(section?.id).toBe("audit");
    // Members is 110 and Master data 130 in the core's order.
    expect(section?.order).toBe(120);
    expect(section?.lock).toBeDefined();
    expect(auditNavItems.map((item) => item.id)).toEqual(["audit"]);
    expect(auditNavItems[0]?.roles).toEqual(["provider_admin"]);
  });

  it("limits a provider admin's view to the tenant whose page it is", async () => {
    const urls = stubApi();
    await openAt(
      "/tenants/mueller/audit",
      sessionAs({ activeTenant: MUELLER, tenants: [MUELLER] }),
    );
    const listed = urls.filter((url) => url.includes("/audit?"));
    expect(listed.length).toBeGreaterThan(0);
    for (const url of listed) {
      expect(url).toContain("tenant=mueller");
    }
    // No tenant filter to choose: the page already is about one tenant.
    expect(document.body.textContent).toContain("Müller GmbH");
    expect(document.querySelector("h1")).toBeNull();
  });

  it("shows a tenant's own admin the log of their tenant, which the API narrows to it", async () => {
    const urls = stubApi();
    await openAt(
      "/tenants/mueller/audit",
      sessionAs({
        isProviderAdmin: false,
        providerRole: null,
        role: "tenant_admin",
        activeTenant: MUELLER,
        tenants: [MUELLER],
      }),
    );
    const listed = urls.filter((url) => url.includes("/audit?"));
    expect(listed.length).toBeGreaterThan(0);
    // The tenant admin's request names no tenant: the server decides it from the session.
    for (const url of listed) {
      expect(url).not.toContain("tenant=");
    }
  });
});

describe("the old address of the audit log", () => {
  it("leads a tenant admin to the audit section of their tenant's page", async () => {
    stubApi();
    const router = await openAt(
      "/audit",
      sessionAs({
        isProviderAdmin: false,
        providerRole: null,
        role: "tenant_admin",
        activeTenant: MUELLER,
        tenants: [MUELLER],
      }),
    );
    expect(router.state.location.pathname).toBe("/tenants/mueller/audit");
  });

  it("stays the installation-wide log for a provider admin", async () => {
    stubApi();
    const router = await openAt("/audit", sessionAs({ activeTenant: MUELLER, tenants: [MUELLER] }));
    expect(router.state.location.pathname).toBe("/audit");
  });
});
