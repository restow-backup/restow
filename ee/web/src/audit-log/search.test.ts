import { describe, expect, it } from "vitest";

import {
  calendarDay,
  hasFilters,
  localDayStart,
  nextAuditSearch,
  parseAuditSearch,
  toAuditQuery,
} from "./search";

const TENANT = "0f1e2d3c-4b5a-4978-8899-aabbccddeeff";
const ENTRY = "11111111-2222-4333-8444-555555555555";

describe("parseAuditSearch", () => {
  it("keeps valid values and trims text", () => {
    expect(
      parseAuditSearch({
        tenant: TENANT,
        action: "restore.requested",
        actor: "  anna@contoso.example ",
        target: "mailbox",
        from: "2026-09-01",
        to: "2026-09-21",
        entry: ENTRY,
      }),
    ).toEqual({
      tenant: TENANT,
      action: "restore.requested",
      actor: "anna@contoso.example",
      target: "mailbox",
      from: "2026-09-01",
      to: "2026-09-21",
      entry: ENTRY,
    });
    expect(parseAuditSearch({ tenant: "installation" })).toEqual({ tenant: "installation" });
  });

  it("drops anything that is not one of ours", () => {
    expect(
      parseAuditSearch({
        tenant: "acme",
        action: "restore.%",
        actor: "   ",
        target: 42,
        from: "2026-02-30",
        to: "21.09.2026",
        entry: "not-an-id",
        page: 3,
      }),
    ).toEqual({});
  });

  it("puts an inverted day range the right way round", () => {
    expect(parseAuditSearch({ from: "2026-09-21", to: "2026-09-01" })).toEqual({
      from: "2026-09-01",
      to: "2026-09-21",
    });
  });
});

describe("calendarDay", () => {
  it("accepts real days only", () => {
    expect(calendarDay("2028-02-29")).toBe("2028-02-29");
    expect(calendarDay("2026-02-29")).toBeUndefined();
    expect(calendarDay("2026-13-01")).toBeUndefined();
    expect(calendarDay(20260901)).toBeUndefined();
  });
});

describe("nextAuditSearch", () => {
  const current = { action: "restore", entry: ENTRY };

  it("closes the drawer when a filter changes", () => {
    expect(nextAuditSearch(current, { actor: "anna" })).toEqual({
      action: "restore",
      actor: "anna",
    });
    expect(nextAuditSearch(current, { action: undefined })).toEqual({});
  });

  it("keeps the filters when an entry opens or closes", () => {
    expect(nextAuditSearch({ action: "restore" }, { entry: ENTRY })).toEqual(current);
    expect(nextAuditSearch(current, { entry: undefined })).toEqual({ action: "restore" });
  });
});

describe("hasFilters", () => {
  it("counts the tenant filter only where it applies", () => {
    expect(hasFilters({}, true)).toBe(false);
    expect(hasFilters({ entry: ENTRY }, true)).toBe(false);
    expect(hasFilters({ tenant: TENANT }, true)).toBe(true);
    expect(hasFilters({ tenant: TENANT }, false)).toBe(false);
    expect(hasFilters({ to: "2026-09-01" }, false)).toBe(true);
  });
});

describe("toAuditQuery", () => {
  it("turns local calendar days into an inclusive instant window", () => {
    const query = toAuditQuery({ from: "2026-09-01", to: "2026-09-21" }, false);
    expect(query).toEqual({
      from: new Date(2026, 8, 1).toISOString(),
      to: new Date(2026, 8, 22).toISOString(),
    });
  });

  it("passes the tenant filter for provider admins only", () => {
    const search = { tenant: TENANT, action: "tenant.member", actor: "ops", target: "bob" };
    expect(toAuditQuery(search, true)).toEqual(search);
    expect(toAuditQuery(search, false)).toEqual({
      action: "tenant.member",
      actor: "ops",
      target: "bob",
    });
  });

  it("rolls over month ends", () => {
    expect(localDayStart("2026-12-31", 1)).toEqual(new Date(2027, 0, 1));
  });
});
