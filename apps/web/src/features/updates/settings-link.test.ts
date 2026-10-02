import { describe, expect, it } from "vitest";

import { installationSections } from "@/features/installation/sections";

import { UPDATES_SECTION, isUpdatesTab, updatesTabLink } from "./settings-link";

describe("the link to Installation, Updates", () => {
  it("points at the updates section of the installation page", () => {
    const link = updatesTabLink();
    expect(link.to).toBe("/installation/updates");
    expect(link.search).toEqual({});
  });

  it("is a section the installation page has", () => {
    expect(installationSections().map((section) => section.id)).toContain(UPDATES_SECTION);
  });

  it("recognizes the page from a location", () => {
    expect(isUpdatesTab("/installation/updates")).toBe(true);
    expect(isUpdatesTab("/installation/updates/")).toBe(true);
    expect(isUpdatesTab("/installation/mail")).toBe(false);
    expect(isUpdatesTab("/installation")).toBe(false);
    // The address the page had before 0.2.0 only redirects.
    expect(isUpdatesTab("/settings")).toBe(false);
    expect(isUpdatesTab("/updates")).toBe(false);
  });
});
