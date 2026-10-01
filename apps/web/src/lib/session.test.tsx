import { Building2, LayoutDashboard, ListChecks, Settings } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { RequireRole } from "@/components/require-role";
import { i18n } from "@/i18n";
import type { Me } from "@/lib/api";
import { type NavItem, groupNavItems } from "@/lib/navigation";

import {
  type SessionContextValue,
  StaticSessionProvider,
  buildTenantList,
  canAccess,
  hasFeature,
  readExtensions,
  readFeatures,
  readRunningVersion,
  resolveTenantView,
} from "./session.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

/** Admin of Contoso, plain user of Fabrikam: the setup of review finding 7. */
const me: Pick<Me, "role" | "tenants"> = {
  role: "tenant_admin",
  tenants: [
    { id: "contoso", name: "Contoso", slug: "contoso", role: "tenant_admin" },
    { id: "fabrikam", name: "Fabrikam", slug: "fabrikam", role: "tenant_user" },
  ],
};

const navItems: NavItem[] = [
  { id: "dashboard", path: "/", labelKey: "x", icon: LayoutDashboard, exact: true },
  { id: "restore", path: "/restore", labelKey: "x", icon: ListChecks },
  {
    id: "jobs",
    path: "/jobs",
    labelKey: "x",
    icon: ListChecks,
    roles: ["provider_admin", "tenant_admin"],
  },
  {
    id: "settings",
    path: "/settings",
    labelKey: "x",
    icon: Settings,
    roles: ["provider_admin"],
  },
  {
    id: "tenants",
    path: "/tenants",
    labelKey: "x",
    icon: Building2,
    roles: ["provider_admin"],
  },
];

function sessionValue(view: ReturnType<typeof resolveTenantView>): SessionContextValue {
  return {
    status: "authenticated",
    user: { id: "u1", name: "Alex Example", email: "alex@example.test" },
    role: view.role,
    features: [],
    extensions: {},
    isProviderAdmin: view.isProviderAdmin,
    tenants: view.tenants,
    activeTenant: view.activeTenant,
    setActiveTenant: () => {},
    version: null,
    signOut: async () => {},
    refresh: async () => {},
    error: null,
  };
}

function visibleIds(role: string | null): string[] {
  return groupNavItems(navItems, role, canAccess, { features: [], extensions: {} }).flatMap(
    (group) => group.items.map((item) => item.id),
  );
}

function renderGate(view: ReturnType<typeof resolveTenantView>): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <StaticSessionProvider value={sessionValue(view)}>
        <RequireRole roles={["provider_admin", "tenant_admin"]}>
          <p>operator page</p>
        </RequireRole>
      </StaticSessionProvider>
    </I18nextProvider>,
  );
}

describe("role in the active tenant (review finding 7)", () => {
  it("applies the tenant_user role while the tenant where the person is a user is active", () => {
    const view = resolveTenantView(me, undefined, ["fabrikam"]);
    expect(view.activeTenant?.id).toBe("fabrikam");
    expect(view.role).toBe("tenant_user");
    expect(visibleIds(view.role)).toEqual(["dashboard", "restore"]);

    const html = renderGate(view);
    expect(html).not.toContain("operator page");
    expect(html).toContain("You do not have permission for this action.");
    expect(html).toContain("Your role in Fabrikam: User.");
  });

  it("applies the tenant_admin role while the administered tenant is active", () => {
    const view = resolveTenantView(me, undefined, ["contoso"]);
    expect(view.role).toBe("tenant_admin");
    expect(visibleIds(view.role)).toEqual(["dashboard", "restore", "jobs"]);
    expect(renderGate(view)).toContain("operator page");
  });

  it("keeps provider admins provider admins in every tenant", () => {
    const view = resolveTenantView({ role: "provider_admin", tenants: me.tenants }, undefined, [
      "fabrikam",
    ]);
    expect(view.role).toBe("provider_admin");
    // Sections in menu order: Daily, Mail & SaaS, Tenants, Admin, then the catch-all.
    expect(visibleIds(view.role)).toEqual(["dashboard", "restore", "tenants", "settings", "jobs"]);
  });

  it("has no role before the profile loaded", () => {
    expect(resolveTenantView(undefined, undefined, []).role).toBeNull();
  });
});

describe("tenant list and states", () => {
  it("carries each tenant's status and treats rows without one as active", () => {
    const withStatus = {
      ...me,
      tenants: [
        { ...me.tenants[0], status: "suspended" },
        me.tenants[1],
      ] as unknown as Me["tenants"],
    };
    expect(buildTenantList(withStatus, undefined).map((tenant) => tenant.status)).toEqual([
      "suspended",
      "active",
    ]);
  });

  it("gives provider admins the provider list with its states", () => {
    const list = buildTenantList({ role: "provider_admin", tenants: [] }, [
      { id: "t1", name: "One", slug: "one", status: "deleting" } as never,
      { id: "t2", name: "Two", slug: "two" },
    ]);
    expect(list).toEqual([
      { id: "t1", name: "One", slug: "one", role: "tenant_admin", status: "deleting" },
      { id: "t2", name: "Two", slug: "two", role: "tenant_admin", status: "active" },
    ]);
  });

  it("does not activate a suspended tenant for a member when another one is open", () => {
    const suspendedFirst = {
      role: "tenant_user" as const,
      tenants: [
        { id: "a", name: "A", slug: "a", role: "tenant_user", status: "suspended" },
        { id: "b", name: "B", slug: "b", role: "tenant_user", status: "active" },
      ] as unknown as Me["tenants"],
    };
    expect(resolveTenantView(suspendedFirst, undefined, ["a"]).activeTenant?.id).toBe("b");
  });
});

describe("readRunningVersion", () => {
  it("reads the version block of /me", () => {
    expect(
      readRunningVersion({
        version: {
          running: "0.301.0",
          commit: "4f2a9c1",
          latest: "0.302.0",
          updateAvailable: true,
          releaseUrl: "https://example.test/r",
        },
      }),
    ).toEqual({
      running: "0.301.0",
      commit: "4f2a9c1",
      latest: "0.302.0",
      updateAvailable: true,
      releaseUrl: "https://example.test/r",
    });
  });

  it("reports an untagged build and tolerates servers without the field", () => {
    expect(readRunningVersion({ version: { running: null, updateAvailable: null } })).toEqual({
      running: null,
      commit: null,
      latest: null,
      updateAvailable: false,
      releaseUrl: null,
    });
    expect(readRunningVersion({})).toBeNull();
    expect(readRunningVersion(undefined)).toBeNull();
  });
});

describe("gated features and extension fields", () => {
  it("keeps only known features and tolerates servers without the field", () => {
    expect(
      readFeatures({ features: ["reports.timed", "unknown.feature", "tenants.additional", 7] }),
    ).toEqual(["tenants.additional", "reports.timed"]);
    expect(readFeatures({ features: "reports.timed" })).toEqual([]);
    expect(readFeatures({})).toEqual([]);
    expect(readFeatures(undefined)).toEqual([]);
  });

  it("passes the extension fields on unread, or an empty record", () => {
    expect(readExtensions({ extensions: { marker: "value", other: { a: 1 } } })).toEqual({
      marker: "value",
      other: { a: 1 },
    });
    expect(readExtensions({ extensions: ["marker"] })).toEqual({});
    expect(readExtensions({ extensions: null })).toEqual({});
    expect(readExtensions(undefined)).toEqual({});
  });

  it("tests a feature, false while the profile loads", () => {
    expect(hasFeature({ features: ["stats.allTenants"] }, "stats.allTenants")).toBe(true);
    expect(hasFeature({ features: ["stats.allTenants"] }, "reports.timed")).toBe(false);
    expect(hasFeature({ features: null }, "stats.allTenants")).toBe(false);
  });
});
