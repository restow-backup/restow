import { describe, expect, it } from "vitest";

import { ALPHA, BETA, BROKEN, DELTA, EPSILON, GAMMA, tenantFixture, ZETA } from "./fixtures.js";
import {
  ariaSortOf,
  DEFAULT_SORT,
  daysUntilFull,
  fullView,
  growthHeadline,
  isCapacityFilter,
  isNearFull,
  matchesFilter,
  NEAR_FULL_DAYS,
  needsAttention,
  nextSort,
  sortTenants,
  spanOf,
} from "./presenters.js";

const ALL = [ZETA, BROKEN, GAMMA, ALPHA, DELTA, BETA, EPSILON];
const names = (rows: readonly { name: string }[]) => rows.map((row) => row.name);

describe("growthHeadline", () => {
  it("leads with the 30-day figure, else the 7-day one, else the 90-day one", () => {
    expect(growthHeadline({ days7: 1, days30: 2, days90: 3 })).toEqual({
      bytesPerDay: 2,
      days: 30,
    });
    expect(growthHeadline({ days7: 1, days30: null, days90: 3 })).toEqual({
      bytesPerDay: 1,
      days: 7,
    });
    expect(growthHeadline({ days7: null, days30: null, days90: 3 })).toEqual({
      bytesPerDay: 3,
      days: 90,
    });
    expect(growthHeadline({ days7: null, days30: null, days90: null })).toBeNull();
    // A flat or falling total is still a figure.
    expect(growthHeadline({ days7: 0, days30: null, days90: null })?.bytesPerDay).toBe(0);
    expect(growthHeadline({ days7: -5, days30: null, days90: null })?.bytesPerDay).toBe(-5);
  });
});

describe("sorting", () => {
  it("opens with the repository that runs full soonest, rows without a day last", () => {
    expect(names(sortTenants(ALL, DEFAULT_SORT))).toEqual([
      "Alpha AG",
      "Beta KG",
      // No day: by name.
      "Broken Ltd",
      "Delta SE",
      "Epsilon Ltd",
      "Gamma GmbH",
      "Zeta Inc",
    ]);
    expect(daysUntilFull(ALPHA)).toBe(40);
    expect(daysUntilFull(BROKEN)).toBeNull();
  });

  it("keeps the rows without a value last in either direction", () => {
    const desc = sortTenants(ALL, { key: "full", direction: "desc" });
    expect(names(desc).slice(0, 2)).toEqual(["Beta KG", "Alpha AG"]);
    const growth = sortTenants(ALL, { key: "growth", direction: "desc" });
    // Alpha 1.5 GB (30 days), Beta 1 GB, Zeta 1 GB (7 days), Gamma 0.2 GB; no growth last.
    expect(names(growth).slice(0, 4)).toEqual(["Alpha AG", "Beta KG", "Zeta Inc", "Gamma GmbH"]);
    expect(names(growth).slice(4)).toEqual(["Broken Ltd", "Delta SE", "Epsilon Ltd"]);
    const slowest = sortTenants(ALL, { key: "growth", direction: "asc" });
    expect(names(slowest).slice(0, 2)).toEqual(["Gamma GmbH", "Beta KG"]);
    expect(names(slowest).slice(4)).toEqual(["Broken Ltd", "Delta SE", "Epsilon Ltd"]);
  });

  it("sorts by what is stored, the largest first, and by name", () => {
    expect(names(sortTenants(ALL, { key: "stored", direction: "desc" })).slice(0, 3)).toEqual([
      "Alpha AG",
      "Beta KG",
      "Zeta Inc",
    ]);
    expect(names(sortTenants(ALL, { key: "name", direction: "asc" }))[0]).toBe("Alpha AG");
    expect(names(sortTenants(ALL, { key: "name", direction: "desc" }))[0]).toBe("Zeta Inc");
  });

  it("sorts by the monthly amount, the dearest first, and keeps the rows without one last", () => {
    const prices = new Map<string, number | null>([
      ["alpha", 40],
      ["beta", 90],
      ["gamma", null],
      ["zeta", 0],
    ]);
    const desc = names(sortTenants(ALL, { key: "price", direction: "desc" }, prices));
    expect(desc.slice(0, 3)).toEqual(["Beta KG", "Alpha AG", "Zeta Inc"]);
    const asc = names(sortTenants(ALL, { key: "price", direction: "asc" }, prices));
    expect(asc.slice(0, 3)).toEqual(["Zeta Inc", "Alpha AG", "Beta KG"]);
    // Gamma (null) and the tenants the estimate does not list come last in either direction.
    expect(desc.slice(3)).toEqual(asc.slice(3));
    expect(nextSort(DEFAULT_SORT, "price")).toEqual({ key: "price", direction: "desc" });
  });

  it("does not change the list it was given", () => {
    const before = [...ALL];
    sortTenants(ALL, DEFAULT_SORT);
    expect(ALL).toEqual(before);
  });

  it("starts a column in its first direction and turns it around when pressed again", () => {
    expect(nextSort(DEFAULT_SORT, "growth")).toEqual({ key: "growth", direction: "desc" });
    expect(nextSort({ key: "growth", direction: "desc" }, "growth")).toEqual({
      key: "growth",
      direction: "asc",
    });
    expect(nextSort(DEFAULT_SORT, "name")).toEqual({ key: "name", direction: "asc" });
    expect(nextSort(DEFAULT_SORT, "full")).toEqual({ key: "full", direction: "desc" });
    expect(ariaSortOf(DEFAULT_SORT, "full")).toBe("ascending");
    expect(ariaSortOf({ key: "stored", direction: "desc" }, "stored")).toBe("descending");
    expect(ariaSortOf(DEFAULT_SORT, "stored")).toBe("none");
  });
});

describe("the filter near quota or full", () => {
  it("keeps a tenant with a quota near its budget or a day within three months", () => {
    // Alpha has both; Beta's day is 253 days away; Zeta's date is withheld.
    expect(names(ALL.filter((tenant) => matchesFilter(tenant, "attention")))).toEqual(["Alpha AG"]);
    expect(ALL.filter((tenant) => matchesFilter(tenant, "all"))).toHaveLength(ALL.length);
    const exceeded = tenantFixture("x", "X", { quotaLevel: "exceeded" });
    expect(needsAttention(exceeded)).toBe(true);
    const soon = tenantFixture("y", "Y", {
      full: {
        estimate: "2026-11-05",
        earliest: null,
        latest: null,
        estimateInDays: 6,
        nearest: "2026-11-05",
        nearestInDays: NEAR_FULL_DAYS,
      },
    });
    expect(needsAttention(soon)).toBe(true);
    // A tenant whose figures are not available is not judged.
    expect(needsAttention({ ...BROKEN, quotaLevel: "near" })).toBe(false);
  });

  it("knows its two values", () => {
    expect(isCapacityFilter("attention")).toBe(true);
    expect(isCapacityFilter("all")).toBe(true);
    expect(isCapacityFilter("quota")).toBe(false);
  });
});

describe("fullView", () => {
  it("names a day only where a limit is known and the history carries an estimate", () => {
    expect(fullView(ALPHA)).toEqual({
      kind: "date",
      inDays: 40,
      date: "2026-12-09",
      between: null,
      from: null,
    });
  });

  it("gives the band's days from three months of history on", () => {
    expect(fullView(BETA)).toEqual({
      kind: "date",
      inDays: 253,
      date: "2027-07-10",
      between: { earliest: "2027-07-10", latest: "2030-01-01" },
      from: null,
    });
    const onlyEarliest = tenantFixture("b", "B", {
      forecast: {
        basisDays: 90,
        slopeBytesPerDay: 1,
        band: { slowestBytesPerDay: 0, fastestBytesPerDay: 2 },
      },
      limit: { kind: "filesystem", freeBytes: 1, totalBytes: 2, dateWithheld: null },
      full: {
        estimate: null,
        earliest: "2027-01-01",
        latest: null,
        estimateInDays: null,
        nearest: "2027-01-01",
        nearestInDays: 63,
      },
    });
    expect(fullView(onlyEarliest)).toMatchObject({
      kind: "date",
      between: null,
      from: "2027-01-01",
    });
  });

  it("says why there is no day: S3, the shared default, an unknown limit, a short history, other data", () => {
    expect(fullView(GAMMA)).toEqual({ kind: "s3" });
    expect(fullView(DELTA)).toEqual({ kind: "shared_default" });
    expect(fullView(tenantFixture("u", "U"))).toEqual({ kind: "unknown_limit" });
    expect(fullView(EPSILON)).toEqual({ kind: "no_history" });
    expect(fullView(ZETA)).toEqual({ kind: "other_data" });
    expect(fullView(BROKEN)).toEqual({ kind: "unavailable" });
    // A limit and a history, but no growth: no day within ten years.
    const flat = tenantFixture("f", "F", {
      forecast: { basisDays: 30, slopeBytesPerDay: 0, band: null },
      limit: { kind: "filesystem", freeBytes: 1, totalBytes: 2, dateWithheld: null },
      full: {
        estimate: null,
        earliest: null,
        latest: null,
        estimateInDays: null,
        nearest: null,
        nearestInDays: null,
      },
    });
    expect(fullView(flat)).toEqual({ kind: "no_date" });
  });
});

describe("spanOf", () => {
  it("reads days up to four months, months up to two years, then years", () => {
    expect(spanOf(1)).toEqual({ unit: "days", count: 1 });
    expect(spanOf(119)).toEqual({ unit: "days", count: 119 });
    expect(spanOf(120)).toEqual({ unit: "months", count: 4 });
    expect(spanOf(500)).toEqual({ unit: "months", count: 16 });
    expect(spanOf(729)).toEqual({ unit: "months", count: 24 });
    expect(spanOf(730)).toEqual({ unit: "years", count: 2 });
    expect(spanOf(3650)).toEqual({ unit: "years", count: 10 });
    expect(spanOf(0)).toEqual({ unit: "days", count: 1 });
  });

  it("warns from ninety days on", () => {
    expect(isNearFull(90)).toBe(true);
    expect(isNearFull(91)).toBe(false);
  });
});
