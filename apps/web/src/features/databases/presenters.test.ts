import { describe, expect, it } from "vitest";

import { splitAddressCredentials } from "./api.js";
import {
  BAND_COLOR,
  bandCounts,
  capabilityView,
  connectionStateView,
  countTicks,
  formatLatency,
  ratingView,
  reachabilityView,
} from "./presenters.js";

describe("database presenters (docs/DATABASES.md 2.4)", () => {
  it("never shows green: nothing of this stage is a passed restore check", () => {
    const tones = [
      ...(["red", "overdue", "unverified", "not_protected", "green"] as const).map(
        (rating) => ratingView(rating).tone,
      ),
      ...(["granted", "missing", "partial", "unknown", "not_applicable"] as const).map(
        (state) => capabilityView(state).tone,
      ),
      ...(["ok", "attention", "red", "unchecked"] as const).map(
        (state) => connectionStateView(state).tone,
      ),
      ...(["reachable", "slow", "unreachable", "unknown"] as const).map(
        (reachability) => reachabilityView(reachability).tone,
      ),
    ];
    expect(tones).not.toContain("success");
    // A connection that answers is no proof either: the band of the last 24 hours has no green.
    expect(Object.values(BAND_COLOR).join(" ")).not.toContain("success");
    expect(ratingView("red").tone).toBe("destructive");
    expect(capabilityView("missing").tone).toBe("warning");
  });

  it("counts the band, rounds the axis and writes response times (8)", () => {
    const hour = (state: "ok" | "slow" | "down" | "mixed" | "none") => ({
      at: "2026-11-17T10:00:00.000Z",
      state,
      checks: 1,
      okChecks: 1,
    });
    expect(
      bandCounts([hour("ok"), hour("slow"), hour("down"), hour("mixed"), hour("none")]),
    ).toEqual({ ok: 2, problem: 2, none: 1 });
    expect(countTicks(0)).toEqual([0, 1]);
    expect(countTicks(87)).toEqual([0, 25, 50, 75, 100]);
    expect(formatLatency(null, "en")).toBe("–");
    expect(formatLatency(42.4, "en")).toBe("42 ms");
    expect(formatLatency(2350, "en")).toBe("2.4 s");
  });

  it("moves a user and a password out of a URL", () => {
    expect(splitAddressCredentials("mysql://root:p%40ss@db:3306/shop")).toEqual({
      address: "mysql://db:3306/shop",
      user: "root",
      password: "p@ss",
    });
    expect(splitAddressCredentials("db.example.com:5432")).toEqual({
      address: "db.example.com:5432",
      user: null,
      password: null,
    });
  });
});
