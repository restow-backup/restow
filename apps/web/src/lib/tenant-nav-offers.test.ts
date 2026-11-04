import { describe, expect, it } from "vitest";

import { navItems as archiveNavItems } from "@/features/archive";

import { isTenantOffered } from "./tenant-nav-offers";

describe("isTenantOffered", () => {
  const archive = { tenantOffer: "archive" as const };

  it("shows an entry that depends on the tenant only once the tenant offers it", () => {
    expect(isTenantOffered(archive, { archive: true })).toBe(true);
    expect(isTenantOffered(archive, { archive: false })).toBe(false);
    // Still loading: hidden, so it never appears and vanishes again.
    expect(isTenantOffered(archive, null)).toBe(false);
  });

  it("leaves every other entry alone", () => {
    expect(isTenantOffered({}, null)).toBe(true);
    expect(isTenantOffered({}, { archive: false })).toBe(true);
  });

  it("keeps the entry Archive in the mail section, behind the tenant's archive", () => {
    expect(archiveNavItems).toEqual([
      expect.objectContaining({ id: "archive", group: "mail", tenantOffer: "archive" }),
    ]);
  });
});
