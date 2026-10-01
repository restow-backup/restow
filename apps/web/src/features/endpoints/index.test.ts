import { describe, expect, it } from "vitest";

import { i18n } from "@/i18n";
import { NAV_GROUPS, findActiveNavItem } from "@/lib/navigation";

import { detailRoute, fileRestoreRoute, inventoryRoute, navItems, routes } from "./index";
import {
  ENDPOINT_DETAIL_PATTERN,
  areaOfKind,
  endpointDetailTo,
  inventorySearch,
  parseInventorySearch,
} from "./paths";

describe("servers and endpoints section", () => {
  it("sits right after Mail & SaaS, with Inventory and File restore for administrators", () => {
    expect(NAV_GROUPS.indexOf("endpoints")).toBe(NAV_GROUPS.indexOf("mail") + 1);
    expect(navItems.map((item) => item.path)).toEqual(["/inventory", "/file-restore"]);
    for (const item of navItems) {
      expect(item).toMatchObject({ group: "endpoints" });
      expect(item).not.toHaveProperty("stage");
      expect(item.roles).toEqual(["provider_admin", "tenant_admin"]);
    }
  });

  it("has the inventory, one page per machine below it and file restore", () => {
    expect(routes).toEqual([inventoryRoute, detailRoute, fileRestoreRoute]);
    expect((detailRoute.options as { path?: string }).path).toBe(ENDPOINT_DETAIL_PATTERN);
    expect(navItems.map((item) => item.path)).not.toContain(ENDPOINT_DETAIL_PATTERN);
  });

  it("keeps Inventory highlighted on the page of a machine, so the breadcrumbs start there", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(findActiveNavItem(navItems, String(endpointDetailTo(id)))?.id).toBe("inventory");
    expect(String(endpointDetailTo(id))).toBe(`/inventory/${id}`);
  });

  it("filters the inventory by the chip in the URL, anything else shows every machine", () => {
    expect(parseInventorySearch({ kind: "server" })).toEqual({ kind: "server" });
    expect(parseInventorySearch({ kind: "client" })).toEqual({ kind: "client" });
    expect(parseInventorySearch({ kind: "agent" })).toEqual({});
    expect(parseInventorySearch({})).toEqual({});
    expect(areaOfKind(undefined)).toBe("agents");
    expect(areaOfKind("server")).toBe("servers");
    expect(areaOfKind("client")).toBe("clients");
    expect(inventorySearch("servers")).toEqual({ kind: "server" });
    expect(inventorySearch("agents")).toEqual({});
  });

  it("names the section and its entries in both languages", async () => {
    await i18n.changeLanguage("de");
    expect(i18n.t("nav.groups.endpoints")).toBe("Server & Endpunkte");
    expect(i18n.t("endpoints:nav.inventory")).toBe("Inventar");
    expect(i18n.t("endpoints:nav.fileRestore")).toBe("Datei-Restore");
    expect(i18n.t("endpoints:inventory.chips.agents")).toBe("Alle");
    await i18n.changeLanguage("en");
    expect(i18n.t("nav.groups.endpoints")).toBe("Servers & endpoints");
    expect(i18n.t("endpoints:nav.inventory")).toBe("Inventory");
    expect(i18n.t("endpoints:inventory.chips.clients")).toBe("Clients");
  });
});
