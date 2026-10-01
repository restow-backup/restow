import { describe, expect, it } from "vitest";

import { chronological, compactTimelineLabels, restorePointTime } from "./restore-point-label.js";

/** A restore point finished at `completedAt`, given in the test machine's local time. */
function at(id: string, local: string) {
  const date = new Date(local);
  return { id, completedAt: date.toISOString(), createdAt: date.toISOString() };
}

describe("chronological", () => {
  it("turns the API's newest-first order into oldest-first without re-sorting", () => {
    expect(chronological(["c", "b", "a"])).toEqual(["a", "b", "c"]);
  });

  it("leaves the input untouched", () => {
    const input = ["c", "b", "a"];
    chronological(input);
    expect(input).toEqual(["c", "b", "a"]);
  });
});

describe("restorePointTime", () => {
  it("prefers the completion time and falls back to the creation time", () => {
    expect(
      restorePointTime({ completedAt: "2026-09-20T10:05:00Z", createdAt: "2026-09-20T10:00:00Z" }),
    ).toBe("2026-09-20T10:05:00Z");
    expect(restorePointTime({ completedAt: null, createdAt: "2026-09-20T10:00:00Z" })).toBe(
      "2026-09-20T10:00:00Z",
    );
  });
});

describe("compactTimelineLabels", () => {
  const now = new Date("2026-09-30T12:00:00");

  it("labels the first restore point of a day with its date and later ones the same day with their time", () => {
    const labels = compactTimelineLabels(
      [
        at("a", "2026-09-27T02:00:00"),
        at("b", "2026-09-28T02:00:00"),
        at("c", "2026-09-28T14:30:00"),
        at("d", "2026-09-29T02:00:00"),
      ],
      "en-GB",
      now,
    );
    // The short month name differs between ICU versions ("Sep", "Sept").
    expect(labels.get("a")).toMatch(/^27 Sep/);
    expect(labels.get("b")).toMatch(/^28 Sep/);
    expect(labels.get("c")).toBe("14:30");
    expect(labels.get("d")).toMatch(/^29 Sep/);
  });

  it("adds the year once a restore point is from an earlier year", () => {
    const labels = compactTimelineLabels(
      [at("old", "2025-12-30T02:00:00"), at("new", "2026-01-02T02:00:00")],
      "en-GB",
      now,
    );
    expect(labels.get("old")).toBe("30 Dec 2025");
    expect(labels.get("new")).toBe("2 Jan");
  });

  it("follows the UI language", () => {
    const labels = compactTimelineLabels([at("a", "2026-09-27T02:00:00")], "de", now);
    expect(labels.get("a")).toMatch(/^27\. Sep/);
  });

  it("labels every restore point, even without a usable time", () => {
    const labels = compactTimelineLabels(
      [{ id: "broken", completedAt: null, createdAt: "not a date" }],
      "en-GB",
      now,
    );
    expect(labels.get("broken")).toBe("");
  });
});
