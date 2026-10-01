import { describe, expect, it } from "vitest";

import { parseSettingsSearch, sectionSearch } from "@/features/settings/presenters";

import { UPDATES_SECTION, isUpdatesTab, updatesTabLink } from "./settings-link";

describe("the link to Settings, Updates", () => {
  it("points at the settings page with the updates section", () => {
    const link = updatesTabLink();
    expect(link.to).toBe("/settings");
    expect(link.search).toEqual({ section: "updates" });
  });

  it("is a section the settings page accepts", () => {
    expect(parseSettingsSearch({ section: UPDATES_SECTION })).toEqual({ section: "updates" });
    expect(sectionSearch("updates")).toEqual({ section: "updates" });
  });

  it("recognizes the tab from a location", () => {
    expect(isUpdatesTab("/settings", { section: "updates" })).toBe(true);
    expect(isUpdatesTab("/settings/", { section: "updates" })).toBe(true);
    expect(isUpdatesTab("/settings", {})).toBe(false);
    expect(isUpdatesTab("/settings", { section: "mail" })).toBe(false);
    expect(isUpdatesTab("/jobs", { section: "updates" })).toBe(false);
    expect(isUpdatesTab("/settings", undefined)).toBe(false);
    expect(isUpdatesTab("/settings", null)).toBe(false);
  });
});
