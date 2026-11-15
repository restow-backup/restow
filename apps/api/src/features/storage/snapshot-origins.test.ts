import { describe, expect, it } from "vitest";
import {
  persistentOfRecorded,
  recordedOfPersistent,
  type SnapshotOrigin,
  snapshotOnListing,
} from "./snapshot-origins.js";

/**
 * restic's persistent ids of restore points a promotion carried over (docs/STORAGE.md,
 * "Promoting a copy"): lookups that stay deterministic over several promotions.
 */
const id = (tag: string) => tag.padEnd(64, "0");

describe("snapshot origins", () => {
  // Two promotions: C1 (c1 → a1), then C2 (c2 → a1); newest first, as they are loaded.
  const origins: SnapshotOrigin[] = [
    { snapshotId: id("c2"), persistentId: id("a1") },
    { snapshotId: id("c1"), persistentId: id("a1") },
  ];

  it("names the id the records name now, whatever the order of the origins", () => {
    const recorded = new Set([id("c2")]);
    const isRecorded = (snapshotId: string) => recorded.has(snapshotId);
    expect(recordedOfPersistent(origins, id("a1"), isRecorded)).toBe(id("c2"));
    expect(recordedOfPersistent([...origins].reverse(), id("a1"), isRecorded)).toBe(id("c2"));
    // Nothing recorded: the newest origin, then the persistent id itself.
    expect(recordedOfPersistent(origins, id("a1"))).toBe(id("c2"));
    expect(recordedOfPersistent(origins, id("b9"))).toBe(id("b9"));
  });

  it("finds a recorded id on another copy by its persistent id, full or abbreviated", () => {
    const listed = [{ id: id("e1"), original: id("a1") }];
    expect(persistentOfRecorded(origins, id("c1"))).toBe(id("a1"));
    expect(snapshotOnListing(listed, id("c2").slice(0, 8), origins)).toBe(id("e1"));
    expect(snapshotOnListing(listed, id("c9"), origins)).toBeNull();
  });
});
