import { describe, expect, it } from "vitest";

import { splitAddressCredentials } from "./api.js";
import { capabilityView, connectionStateView, ratingView, reachabilityView } from "./presenters.js";

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
      reachabilityView(true).tone,
      reachabilityView(false).tone,
      reachabilityView(null).tone,
    ];
    expect(tones).not.toContain("success");
    expect(ratingView("red").tone).toBe("destructive");
    expect(capabilityView("missing").tone).toBe("warning");
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
