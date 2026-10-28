import { describe, expect, it } from "vitest";

import {
  dateInputValue,
  expiryNeedsAction,
  expiryState,
  isCalendarDate,
  SECRET_URGENT_DAYS,
  SECRET_WARNING_DAYS,
} from "./credential-expiry";

/**
 * The badge and the warnings read the same stages as the reminders (packages/core
 * entra/expiry.test.ts holds the same boundaries): 31 days is fine, 30 the first reminder,
 * 8 still amber, 7 the second reminder, the end instant expired. Days are calendar days (UTC)
 * from the start of today.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-23T10:00:00.000Z");
const inDays = (days: number) => new Date(NOW + days * DAY).toISOString();

describe("expiryState", () => {
  it("is unknown without a readable date", () => {
    expect(expiryState(null, NOW)).toEqual({ kind: "unknown" });
    expect(expiryState(undefined, NOW)).toEqual({ kind: "unknown" });
    expect(expiryState("not a date", NOW)).toEqual({ kind: "unknown" });
  });

  it("uses the thresholds of the reminders", () => {
    expect(SECRET_WARNING_DAYS).toBe(30);
    expect(SECRET_URGENT_DAYS).toBe(7);
  });

  it("is valid beyond 30 days, amber at 30, red at 7, expired from the end on", () => {
    expect(expiryState(inDays(31), NOW)).toEqual({ kind: "valid", date: inDays(31) });
    expect(expiryState(inDays(30), NOW)).toEqual({ kind: "soon", days: 30, urgent: false });
    expect(expiryState(inDays(8), NOW)).toEqual({ kind: "soon", days: 8, urgent: false });
    expect(expiryState(inDays(7), NOW)).toEqual({ kind: "soon", days: 7, urgent: true });
    expect(expiryState(new Date(NOW + 1).toISOString(), NOW)).toEqual({
      kind: "soon",
      days: 0,
      urgent: true,
    });
    expect(expiryState(new Date(NOW).toISOString(), NOW)).toEqual({ kind: "expired" });
    expect(expiryState(inDays(-1), NOW)).toEqual({ kind: "expired" });
  });

  it("counts calendar days (UTC) like core, so the number matches the printed date", () => {
    const noted = "2026-12-01T00:00:00.000Z";
    expect(expiryState(noted, Date.parse("2026-11-30T10:00:00.000Z"))).toEqual({
      kind: "soon",
      days: 1,
      urgent: true,
    });
    expect(expiryState(noted, Date.parse("2026-11-24T10:00:00.000Z"))).toEqual({
      kind: "soon",
      days: 7,
      urgent: true,
    });
    expect(expiryState(noted, Date.parse("2026-11-01T23:00:00.000Z"))).toEqual({
      kind: "soon",
      days: 30,
      urgent: false,
    });
    expect(expiryState(noted, Date.parse("2026-10-31T23:00:00.000Z"))).toEqual({
      kind: "valid",
      date: noted,
    });
  });

  it("asks for action only within the reminder window", () => {
    expect(expiryNeedsAction(expiryState(inDays(31), NOW))).toBe(false);
    expect(expiryNeedsAction(expiryState(null, NOW))).toBe(false);
    expect(expiryNeedsAction(expiryState(inDays(30), NOW))).toBe(true);
    expect(expiryNeedsAction(expiryState(inDays(-1), NOW))).toBe(true);
  });
});

describe("date input", () => {
  it("accepts real calendar days only", () => {
    expect(isCalendarDate("2027-03-01")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2027-02-30")).toBe(false);
    expect(isCalendarDate("2027-3-1")).toBe(false);
    expect(isCalendarDate("")).toBe(false);
  });

  it("turns a stored date into the input's value", () => {
    expect(dateInputValue("2027-03-01T00:00:00.000Z")).toBe("2027-03-01");
    expect(dateInputValue(null)).toBe("");
    expect(dateInputValue("soon")).toBe("");
  });
});
