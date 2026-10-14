import { describe, expect, it } from "vitest";
import { addedBytes, backupType, followUpAverage, unreadableItems } from "./service.js";

/** How the interface names a restore point's sizes and kind (#58, #61). */
describe("restore point sizes", () => {
  it("takes a container's new data from restic and a VM's from its uploaded blocks", () => {
    expect(addedBytes("ct", { resticBytesAdded: 2_500_000, uploadedBytes: 0 })).toBe(2_500_000);
    expect(addedBytes("vm", { uploadedBytes: 4096, resticBytesAdded: 9 })).toBe(4096);
    expect(addedBytes("ct", {})).toBeNull();
    expect(addedBytes("vm", null)).toBeNull();
  });

  it("counts what a container backup could not read", () => {
    expect(unreadableItems({ resticUnreadable: 42 })).toBe(42);
    expect(unreadableItems({ resticUnreadable: 0 })).toBe(0);
    expect(unreadableItems({})).toBe(0);
  });

  it("names the first backup, incremental ones, and VMs that read whole disks again", () => {
    const ct = { kind: "ct", sequence: 1, disks: [] };
    expect(backupType(ct, 1)).toBe("first");
    expect(backupType({ ...ct, sequence: 5 }, 1)).toBe("incremental");
    // With the first one pruned the oldest kept point is still not "the first".
    expect(backupType({ ...ct, sequence: 5 }, 2)).toBe("incremental");
    expect(backupType(ct, null)).toBe("first");
    const vm = { kind: "vm", sequence: 3, disks: [{ bitmapMode: "reuse" }] };
    expect(backupType(vm, 1)).toBe("incremental");
    expect(backupType({ ...vm, disks: [{ bitmapMode: "new" }] }, 1)).toBe("full_read");
  });

  it("averages what the newest follow-up backups added, without the first one", () => {
    const points = [
      { sequence: 1, added: 9_000 },
      { sequence: 2, added: 100 },
      { sequence: 3, added: null },
      { sequence: 4, added: 300 },
    ];
    expect(followUpAverage(points, 1)).toEqual({ added: 200, points: 2 });
    // Only the newest ones count.
    expect(followUpAverage(points, 1, 1)).toEqual({ added: 300, points: 1 });
    // With the first backup pruned, the oldest kept point is still a follow-up.
    expect(followUpAverage(points.slice(1), 1)).toEqual({ added: 200, points: 2 });
    expect(followUpAverage([{ sequence: 1, added: 9_000 }], 1)).toBeNull();
    expect(followUpAverage([{ sequence: 2, added: null }], 1)).toBeNull();
    expect(followUpAverage(points, null)).toBeNull();
  });
});
