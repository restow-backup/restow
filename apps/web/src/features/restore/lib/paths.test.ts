import { describe, expect, it } from "vitest";

import { baseNameOf, breadcrumbOf, isWithin, joinPath, normalizePath, parentPathOf } from "./paths";

describe("paths", () => {
  it("normalizes and splits paths", () => {
    expect(normalizePath("/Inbox/Projects/")).toBe("Inbox/Projects");
    expect(normalizePath(undefined)).toBe("");
    expect(parentPathOf("Inbox/Projects")).toBe("Inbox");
    expect(parentPathOf("Inbox")).toBe("");
    expect(baseNameOf("Documents/report.docx")).toBe("report.docx");
    expect(joinPath("", "Inbox")).toBe("Inbox");
    expect(joinPath("Inbox/", "Projects")).toBe("Inbox/Projects");
  });

  it("builds breadcrumbs with cumulative paths", () => {
    expect(breadcrumbOf("a/b/c")).toEqual([
      { name: "a", path: "a" },
      { name: "b", path: "a/b" },
      { name: "c", path: "a/b/c" },
    ]);
    expect(breadcrumbOf("")).toEqual([]);
  });

  it("tests containment", () => {
    expect(isWithin("Inbox/Projects/x", "Inbox")).toBe(true);
    expect(isWithin("Inbox", "Inbox")).toBe(true);
    expect(isWithin("Inbox2/x", "Inbox")).toBe(false);
    expect(isWithin("anything", "")).toBe(true);
  });
});
