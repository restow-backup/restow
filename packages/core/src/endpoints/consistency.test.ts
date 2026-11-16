import { describe, expect, it } from "vitest";
import { MAX_LIVE_FILESYSTEMS, parseRunConsistency } from "./consistency.js";

describe("parseRunConsistency", () => {
  it("keeps a report as the agent sends it", () => {
    expect(
      parseRunConsistency({ method: "vss", state: "partial", liveFilesystems: ["C:\\"] }),
    ).toEqual({ method: "vss", state: "partial", liveFilesystems: ["C:\\"] });
    expect(parseRunConsistency({ state: "off" })).toEqual({ state: "off" });
  });

  it("drops what it does not know and bounds the list", () => {
    expect(parseRunConsistency(undefined)).toBeNull();
    expect(parseRunConsistency([])).toBeNull();
    expect(parseRunConsistency({ state: "perfect" })).toBeNull();
    expect(parseRunConsistency({ method: "zfs", state: "used" })).toEqual({ state: "used" });
    const many = Array.from({ length: 50 }, (_, i) => `V${i}:\\`);
    const parsed = parseRunConsistency({
      method: "vss",
      state: "partial",
      liveFilesystems: [...many, 7, ""],
    });
    expect(parsed?.liveFilesystems).toHaveLength(MAX_LIVE_FILESYSTEMS);
  });
});
