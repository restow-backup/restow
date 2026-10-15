import { describe, expect, it } from "vitest";

import type { PveRestorePoint } from "./api.js";
import { containerName, containerPoints } from "./container-files.js";

function point(over: Partial<PveRestorePoint>): PveRestorePoint {
  return {
    id: "p",
    sequence: 1,
    kind: "ct",
    archiveName: "ct/300/2026-10-14T22:00:00Z",
    origin: "restow",
    backupAt: "2026-10-14T22:00:00.000Z",
    byteSize: 10,
    disks: [],
    verify: null,
    ...over,
  };
}

describe("container file restore (#62)", () => {
  it("lists the browsable restore points with what they contain", () => {
    const points = containerPoints(
      {
        snapshots: [
          point({ id: "a", contents: ["/", "/mnt/data"], browsable: true, added: 3 }),
          // A server before 0.4.0 says nothing: a container's point holds its root.
          point({ id: "b" }),
          point({ id: "vm", kind: "vm", browsable: false, contents: null }),
          point({ id: "c", browsable: false }),
        ],
      },
      (time) => `at ${time}`,
    );
    expect(points).toEqual([
      {
        id: "a",
        time: "2026-10-14T22:00:00.000Z",
        shortId: "at 2026-10-14T22:00:00.000Z",
        contents: ["/", "/mnt/data"],
        byteSize: 10,
        added: 3,
      },
      {
        id: "b",
        time: "2026-10-14T22:00:00.000Z",
        shortId: "at 2026-10-14T22:00:00.000Z",
        contents: ["/"],
        byteSize: 10,
        added: null,
      },
    ]);
  });

  it("names a container by its PVE name, else by its VMID", () => {
    expect(containerName({ vmid: 300, name: "paperless" })).toBe("paperless");
    expect(containerName({ vmid: 300, name: null })).toBe("CT 300");
  });
});
