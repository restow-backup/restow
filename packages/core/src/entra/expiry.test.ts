import { describe, expect, it } from "vitest";
import {
  daysLeft,
  isSecretExpiryAlertStage,
  parseExpiryDate,
  SECRET_EXPIRY_STAGES,
  SECRET_URGENT_DAYS,
  SECRET_WARNING_DAYS,
  secretExpiryAlertDue,
  secretExpiryStage,
  stageRank,
} from "./expiry.js";

const NOW = new Date("2026-10-28T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
/** An expiry `days` days (and a bit) after NOW, so the floor lands on `days`. */
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY_MS + 60_000).toISOString();

describe("secretExpiryStage", () => {
  it("has the thresholds the docs name", () => {
    expect(SECRET_WARNING_DAYS).toBe(30);
    expect(SECRET_URGENT_DAYS).toBe(7);
    expect(SECRET_EXPIRY_STAGES).toEqual(["soon30", "soon7", "expired"]);
  });

  it.each([
    [31, "ok"],
    [30, "soon30"],
    [8, "soon30"],
    [7, "soon7"],
    [0, "soon7"],
  ])("with %i whole days left is %s", (days, stage) => {
    expect(daysLeft(inDays(days), NOW)).toBe(days);
    expect(secretExpiryStage(inDays(days), NOW)).toBe(stage);
  });

  it("counts calendar days (UTC) at any hour, so the number matches the printed date", () => {
    const noted = "2026-12-01T00:00:00.000Z";
    // The day before, late morning and just before midnight: 1 day.
    expect(daysLeft(noted, new Date("2026-11-30T10:00:00.000Z"))).toBe(1);
    expect(daysLeft(noted, new Date("2026-11-30T23:59:00.000Z"))).toBe(1);
    expect(daysLeft(noted, new Date("2026-11-30T00:00:00.000Z"))).toBe(1);
    // A week before, at 10:00: 7 days, the second reminder (not 6).
    expect(daysLeft(noted, new Date("2026-11-24T10:00:00.000Z"))).toBe(7);
    expect(secretExpiryStage(noted, new Date("2026-11-24T10:00:00.000Z"))).toBe("soon7");
    expect(secretExpiryStage(noted, new Date("2026-11-23T10:00:00.000Z"))).toBe("soon30");
    // 30 calendar days before is the first reminder, 31 is not yet.
    expect(secretExpiryStage(noted, new Date("2026-11-01T10:00:00.000Z"))).toBe("soon30");
    expect(secretExpiryStage(noted, new Date("2026-10-31T23:00:00.000Z"))).toBe("ok");
    // A certificate that ends later today: 0 (today), not yet expired.
    expect(daysLeft("2026-11-30T18:00:00.000Z", new Date("2026-11-30T10:00:00.000Z"))).toBe(0);
    expect(
      secretExpiryStage("2026-11-30T18:00:00.000Z", new Date("2026-11-30T10:00:00.000Z")),
    ).toBe("soon7");
  });

  it("counts as expired from the instant of the end on", () => {
    expect(secretExpiryStage(NOW.toISOString(), NOW)).toBe("expired");
    expect(secretExpiryStage(inDays(-1), NOW)).toBe("expired");
    expect(daysLeft(new Date(NOW.getTime() - DAY_MS).toISOString(), NOW)).toBe(-1);
  });

  it("knows nothing about a missing or unreadable date", () => {
    expect(secretExpiryStage(null, NOW)).toBeNull();
    expect(secretExpiryStage(undefined, NOW)).toBeNull();
    expect(secretExpiryStage("", NOW)).toBeNull();
    expect(secretExpiryStage("soon", NOW)).toBeNull();
    expect(daysLeft("soon", NOW)).toBeNull();
  });

  it("takes the clock as a number too", () => {
    expect(secretExpiryStage(inDays(3), NOW.getTime())).toBe("soon7");
  });
});

describe("stageRank", () => {
  it("orders the stages by urgency", () => {
    expect(stageRank("ok")).toBe(0);
    expect(stageRank("soon30")).toBe(1);
    expect(stageRank("soon7")).toBe(2);
    expect(stageRank("expired")).toBe(3);
    expect(stageRank("nonsense")).toBe(0);
    expect(stageRank(null)).toBe(0);
    expect(isSecretExpiryAlertStage("soon7")).toBe(true);
    expect(isSecretExpiryAlertStage("ok")).toBe(false);
  });
});

describe("secretExpiryAlertDue", () => {
  const date = inDays(20);

  it("raises the current stage once per date", () => {
    expect(secretExpiryAlertDue(date, null, NOW)).toBe("soon30");
    expect(secretExpiryAlertDue(date, { expiresAt: date, stage: "soon30" }, NOW)).toBeNull();
    // Closer: the next stage is due, and only it.
    const later = new Date(NOW.getTime() + 15 * DAY_MS);
    expect(secretExpiryAlertDue(date, { expiresAt: date, stage: "soon30" }, later)).toBe("soon7");
    expect(secretExpiryAlertDue(date, { expiresAt: date, stage: "soon7" }, later)).toBeNull();
    const after = new Date(NOW.getTime() + 21 * DAY_MS);
    expect(secretExpiryAlertDue(date, { expiresAt: date, stage: "soon7" }, after)).toBe("expired");
    expect(secretExpiryAlertDue(date, { expiresAt: date, stage: "expired" }, after)).toBeNull();
  });

  it("raises no catch-up for a stage it never saw", () => {
    expect(secretExpiryAlertDue(inDays(5), null, NOW)).toBe("soon7");
    expect(secretExpiryAlertDue(inDays(-2), null, NOW)).toBe("expired");
  });

  it("starts over for a new date", () => {
    const old = inDays(-3);
    expect(secretExpiryAlertDue(inDays(25), { expiresAt: old, stage: "expired" }, NOW)).toBe(
      "soon30",
    );
  });

  it("takes the same instant in another spelling as the same date", () => {
    expect(
      secretExpiryAlertDue(
        "2026-11-10T00:00:00.000Z",
        { expiresAt: "2026-11-10T00:00:00Z", stage: "soon30" },
        NOW,
      ),
    ).toBeNull();
  });

  it("raises nothing while far off or unknown", () => {
    expect(secretExpiryAlertDue(inDays(90), null, NOW)).toBeNull();
    expect(secretExpiryAlertDue(null, null, NOW)).toBeNull();
    expect(secretExpiryAlertDue("garbage", { expiresAt: "garbage", stage: "soon30" }, NOW)).toBe(
      null,
    );
  });
});

describe("parseExpiryDate", () => {
  it("reads a calendar date as midnight UTC", () => {
    expect(parseExpiryDate("2027-03-01")).toBe("2027-03-01T00:00:00.000Z");
    expect(parseExpiryDate(" 2027-03-01T18:00:00+02:00 ")).toBe("2027-03-01T00:00:00.000Z");
  });

  it("refuses what is no date", () => {
    expect(parseExpiryDate("2027-02-30")).toBeNull();
    expect(parseExpiryDate("01.03.2027")).toBeNull();
    expect(parseExpiryDate("")).toBeNull();
    expect(parseExpiryDate(null)).toBeNull();
  });
});
