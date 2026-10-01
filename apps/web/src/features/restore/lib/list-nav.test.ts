import { describe, expect, it } from "vitest";

import { moveActivePath } from "./list-nav";

const entries = [{ path: "a" }, { path: "b" }, { path: "c" }];

describe("moveActivePath", () => {
  it("opens the first row on the first down-press and the last on the first up-press", () => {
    expect(moveActivePath(entries, null, "down")).toBe("a");
    expect(moveActivePath(entries, null, "up")).toBe("c");
  });

  it("steps to the next or previous row", () => {
    expect(moveActivePath(entries, "a", "down")).toBe("b");
    expect(moveActivePath(entries, "b", "down")).toBe("c");
    expect(moveActivePath(entries, "c", "up")).toBe("b");
    expect(moveActivePath(entries, "b", "up")).toBe("a");
  });

  it("stops at the edges instead of wrapping around", () => {
    expect(moveActivePath(entries, "c", "down")).toBe("c");
    expect(moveActivePath(entries, "a", "up")).toBe("a");
  });

  it("returns null for an empty list", () => {
    expect(moveActivePath([], null, "down")).toBeNull();
    expect(moveActivePath([], "a", "down")).toBeNull();
  });

  it("treats an active path no longer in the list like nothing being open", () => {
    expect(moveActivePath(entries, "gone", "down")).toBe("a");
    expect(moveActivePath(entries, "gone", "up")).toBe("c");
  });
});
