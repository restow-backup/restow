import { describe, expect, it } from "vitest";
import { TENANT_WIDGET_IDS } from "./dto.js";
import { WIDGET_AUDIENCE, widgetsFor } from "./service.js";

describe("which widgets a viewer gets", () => {
  it("gives admins every tenant widget in page order", () => {
    expect(widgetsFor(true)).toEqual([...TENANT_WIDGET_IDS]);
  });

  it("leaves out only the admin widgets for plain members", () => {
    expect(widgetsFor(false)).toEqual(
      TENANT_WIDGET_IDS.filter(
        (id) => id !== "mailboxUsage" && id !== "endpoints" && id !== "recentJobs",
      ),
    );
  });

  it("keeps the endpoints widget for admins, after the figures and before the trends", () => {
    expect(WIDGET_AUDIENCE.endpoints).toBe("admins");
    const order = widgetsFor(true);
    expect(order.indexOf("endpoints")).toBeGreaterThan(order.indexOf("protectedObjects"));
    expect(order.indexOf("endpoints")).toBeLessThan(order.indexOf("backupTrend"));
  });

  it("names an audience for every widget", () => {
    expect(Object.keys(WIDGET_AUDIENCE).sort()).toEqual([...TENANT_WIDGET_IDS].sort());
  });
});
