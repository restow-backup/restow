import { describe, expect, it } from "vitest";
import {
  catalogChangeOf,
  catalogNodeOf,
  catalogPathFits,
  catalogPlan,
  versionAlive,
  versionIn,
} from "./catalog.js";

const change = (path: string, modifier: string) =>
  JSON.stringify({ message_type: "change", path, modifier });

describe("file share catalog (8.5)", () => {
  it("turns restic diff lines into changes below the share root", () => {
    expect(catalogChangeOf(change("/share/a.txt", "+"))).toEqual({ path: "a.txt", action: "open" });
    expect(catalogChangeOf(change("/share/b/c", "-"))).toEqual({ path: "b/c", action: "close" });
    expect(catalogChangeOf(change("/share/d", "M"))).toEqual({ path: "d", action: "both" });
    expect(catalogChangeOf(change("/share/d", "T"))).toEqual({ path: "d", action: "both" });
    expect(catalogChangeOf(change("/share/folder/", "+"))).toBeNull();
    expect(catalogChangeOf(change("/.restow/acls.jsonl.gz", "M"))).toBeNull();
    expect(catalogChangeOf('{"message_type":"statistics"}')).toBeNull();
    expect(catalogChangeOf("garbage")).toBeNull();
    expect(catalogChangeOf(change("/tmp/s/x", "+"), "/tmp/s")).toEqual({
      path: "x",
      action: "open",
    });
  });

  it("turns restic ls lines into files", () => {
    const node = JSON.stringify({
      name: "Q3.xlsx",
      type: "file",
      path: "/share/Finance/Q3.xlsx",
      size: 4096,
      mtime: "2026-10-09T08:12:00Z",
      struct_type: "node",
    });
    expect(catalogNodeOf(node)).toEqual({
      path: "Finance/Q3.xlsx",
      name: "Q3.xlsx",
      size: 4096,
      mtime: new Date("2026-10-09T08:12:00Z"),
    });
    expect(catalogNodeOf(JSON.stringify({ type: "dir", path: "/share/Finance" }))).toBeNull();
    expect(
      catalogNodeOf(JSON.stringify({ struct_type: "snapshot", paths: ["/share"] })),
    ).toBeNull();
    expect(
      catalogNodeOf(JSON.stringify({ type: "file", path: "/.restow/manifest.json" })),
    ).toBeNull();
  });

  it("plans closes and opens once per path", () => {
    expect(
      catalogPlan([
        { path: "a", action: "open" },
        { path: "b", action: "close" },
        { path: "c", action: "both" },
        { path: "c", action: "both" },
      ]),
    ).toEqual({ close: ["b", "c"], open: ["a", "c"] });
  });

  it("knows which restore points hold a version", () => {
    expect(versionIn({ firstSeq: 2, endSeq: 4 }, 1)).toBe(false);
    expect(versionIn({ firstSeq: 2, endSeq: 4 }, 3)).toBe(true);
    expect(versionIn({ firstSeq: 2, endSeq: 4 }, 4)).toBe(false);
    expect(versionIn({ firstSeq: 2, endSeq: null }, 9)).toBe(true);
    expect(versionAlive({ firstSeq: 2, endSeq: 4 }, [1, 4, 5])).toBe(false);
    expect(versionAlive({ firstSeq: 2, endSeq: 4 }, [1, 3])).toBe(true);
    expect(catalogPathFits("x".repeat(2001))).toBe(false);
  });
});
