import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forgetActiveTenant, setActiveTenantId } from "./tenant";
import {
  TENANT_SECTION_IDS,
  activeTenantPagePath,
  parseTenantPagePath,
  tenantPageAfterSwitch,
  tenantPagePath,
  tenantRootPath,
} from "./tenant-paths";

beforeEach(() => {
  // The remembered tenant lives in the browser's storage; none here.
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
});

afterEach(() => {
  forgetActiveTenant();
  vi.unstubAllGlobals();
});

describe("tenantPagePath", () => {
  it("builds /tenants/<id>/<section> and encodes every segment", () => {
    expect(tenantPagePath("t1", "connections")).toBe("/tenants/t1/connections");
    expect(tenantPagePath("t 1", "connections", "sources", "a/b")).toBe(
      "/tenants/t%201/connections/sources/a%2Fb",
    );
    expect(tenantRootPath("t1")).toBe("/tenants/t1");
  });

  it("names the twelve sections of the core", () => {
    expect(TENANT_SECTION_IDS).toHaveLength(12);
  });
});

describe("activeTenantPagePath", () => {
  it("points into the tenant that is active", () => {
    setActiveTenantId("t9");
    expect(activeTenantPagePath("storage")).toBe("/tenants/t9/storage");
    expect(activeTenantPagePath("protection", "backup")).toBe("/tenants/t9/protection/backup");
    expect(activeTenantPagePath("connections", "imports", "new")).toBe(
      "/tenants/t9/connections/imports/new",
    );
  });

  it("falls back to the old address, which leads to the active tenant once the profile is in", () => {
    forgetActiveTenant();
    expect(activeTenantPagePath("storage")).toBe("/repositories");
    expect(activeTenantPagePath("connections")).toBe("/sources");
    expect(activeTenantPagePath("connections", "sources", "s 1")).toBe("/sources/s%201");
    expect(activeTenantPagePath("connections", "imports", "new")).toBe("/sources/import");
    expect(activeTenantPagePath("connections", "imports", "i1")).toBe("/imports/i1");
    expect(activeTenantPagePath("protection", "backup")).toBe("/backup");
    expect(activeTenantPagePath("protection")).toBe("/protected-objects");
    expect(activeTenantPagePath("jobs")).toBe("/schedules");
    expect(activeTenantPagePath("integrations", "webhooks", "w1")).toBe(
      "/integrations/webhooks/w1",
    );
    expect(activeTenantPagePath("members")).toBe("/members");
    // Sections that never had an address of their own lead to the list.
    expect(activeTenantPagePath("agents")).toBe("/tenants");
  });
});

describe("tenantPageAfterSwitch", () => {
  it("keeps the section of the page and drops what is below it", () => {
    expect(tenantPageAfterSwitch("/tenants/a/connections", "b")).toBe("/tenants/b/connections");
    expect(tenantPageAfterSwitch("/tenants/a/connections/sources/s1", "b")).toBe(
      "/tenants/b/connections",
    );
    expect(tenantPageAfterSwitch("/tenants/a/overview/", "b")).toBe("/tenants/b/overview");
  });

  it("leaves every other page alone", () => {
    expect(tenantPageAfterSwitch("/history", "b")).toBeNull();
    expect(tenantPageAfterSwitch("/tenants", "b")).toBeNull();
    expect(tenantPageAfterSwitch("/tenants/a", "b")).toBeNull();
  });
});

describe("parseTenantPagePath", () => {
  it("reads the tenant and the section of an address", () => {
    expect(parseTenantPagePath("/tenants/t1/members")).toEqual({
      tenantId: "t1",
      section: "members",
    });
    expect(parseTenantPagePath("/tenants/t%201")).toEqual({ tenantId: "t 1", section: null });
    expect(parseTenantPagePath("/history")).toBeNull();
    expect(parseTenantPagePath("/tenants")).toBeNull();
  });
});
