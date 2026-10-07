import { describe, expect, it } from "vitest";

import { navItems as dashboardNavItems } from "@/features/dashboard";
import { featureNavItems } from "@/features/registry";
import { navGroupOf } from "@/lib/navigation";
import { TENANT_ONLY_NAV_IDS, isTenantOnlyNavItem, isTenantOnlyPage } from "@/lib/scope";

const items = [...dashboardNavItems, ...featureNavItems];
const ids = items.map((item) => item.id);

describe("the pages that only exist per tenant", () => {
  it("names only entries the menu has, so a rename cannot leave a page undimmed", () => {
    for (const id of TENANT_ONLY_NAV_IDS) {
      expect(ids, id).toContain(id);
    }
  });

  it("covers jobs, history, restore, archive, exports, the machines and the tenant's settings", () => {
    for (const id of [
      "mail-jobs",
      "endpoint-jobs",
      "history",
      "warnings",
      "restore",
      "archive",
      "exports",
      "inventory",
      "file-restore",
      "tenant-settings",
      "organisation-settings",
    ]) {
      expect(isTenantOnlyNavItem(id), id).toBe(true);
    }
  });

  it("leaves the overview, recovery readiness, the list of tenants and everything under Installation open", () => {
    // Alerts look across tenants too: the deliveries of every tenant, each with its tenant.
    for (const id of ["dashboard", "verify", "tenants", "alerts"]) {
      expect(isTenantOnlyNavItem(id), id).toBe(false);
    }
    for (const item of items.filter((candidate) => navGroupOf(candidate) === "installation")) {
      expect(isTenantOnlyNavItem(item.id), item.id).toBe(false);
    }
  });

  it("decides by the menu entry of a page, and by address for the report pages that have none of their own", () => {
    expect(isTenantOnlyPage("restore", "/restore/jobs/42")).toBe(true);
    expect(isTenantOnlyPage("dashboard", "/")).toBe(false);
    expect(isTenantOnlyPage("verify", "/verify")).toBe(false);
    // A readiness report is one tenant's, though it sits below an entry that works across tenants.
    expect(isTenantOnlyPage("verify", "/verify/reports/abc")).toBe(true);
    expect(isTenantOnlyPage(null, "/account")).toBe(false);
  });
});
