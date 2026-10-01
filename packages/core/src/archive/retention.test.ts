import { describe, expect, it } from "vitest";
import { type RetentionPolicy, isDueForDeletion, retentionUntil } from "./retention.js";

describe("retentionUntil", () => {
  it("from_capture: exactly N years after the capture date", () => {
    const policy: RetentionPolicy = { mode: "from_capture", years: 6 };
    const receivedAt = new Date("2024-03-15T10:00:00.000Z");
    expect(retentionUntil(receivedAt, policy)).toEqual(new Date("2030-03-15T10:00:00.000Z"));
  });

  it("end_of_year: AO §147(4) — clock starts at year end, runs N full years", () => {
    const policy: RetentionPolicy = { mode: "end_of_year", years: 10 };
    const receivedAt = new Date("2024-06-01T08:00:00.000Z");
    // Period starts end of 2024, runs 10 full years -> deletable from 1 Jan 2035.
    expect(retentionUntil(receivedAt, policy)).toEqual(new Date(Date.UTC(2035, 0, 1)));
  });

  it("end_of_year treats every day of the capture year alike (the year-end edge)", () => {
    const policy: RetentionPolicy = { mode: "end_of_year", years: 8 };
    const capturedNewYearsDay = new Date("2024-01-01T00:00:00.000Z");
    const capturedNewYearsEve = new Date("2024-12-31T23:59:59.999Z");
    expect(retentionUntil(capturedNewYearsDay, policy)).toEqual(
      retentionUntil(capturedNewYearsEve, policy),
    );
    expect(retentionUntil(capturedNewYearsEve, policy)).toEqual(new Date(Date.UTC(2033, 0, 1)));
  });

  it("unlimited retention (years: null) never expires, in either mode", () => {
    const receivedAt = new Date("2024-03-15T10:00:00.000Z");
    expect(retentionUntil(receivedAt, { mode: "from_capture", years: null })).toBeNull();
    expect(retentionUntil(receivedAt, { mode: "end_of_year", years: null })).toBeNull();
  });
});

describe("isDueForDeletion", () => {
  const now = new Date("2030-01-01T00:00:00.000Z");

  it("is due once the retention date has passed", () => {
    expect(isDueForDeletion(new Date("2029-12-31T23:59:59.999Z"), false, now)).toBe(true);
    expect(isDueForDeletion(new Date("2030-01-01T00:00:00.000Z"), false, now)).toBe(true);
  });

  it("is not due before the retention date", () => {
    expect(isDueForDeletion(new Date("2030-01-01T00:00:00.001Z"), false, now)).toBe(false);
  });

  it("a legal hold overrides retention regardless of how overdue the item is", () => {
    const longOverdue = new Date("2000-01-01T00:00:00.000Z");
    expect(isDueForDeletion(longOverdue, true, now)).toBe(false);
  });

  it("unlimited retention (null) is never due", () => {
    expect(isDueForDeletion(null, false, now)).toBe(false);
  });
});
