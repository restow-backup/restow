import { describe, expect, it } from "vitest";
import { pveRunning } from "./read.js";

describe("pveRunning", () => {
  const row = {
    id: "run-1",
    kind: "backup" as const,
    startedAt: new Date("2026-10-02T10:00:00.000Z"),
    cancelRequestedAt: null,
    progress: {
      bytesDone: 1024,
      bytesTotal: null,
      bytesUploaded: 10,
      bytesPerSecond: 512,
      at: "2026-10-02T10:00:05.000Z",
    },
    guestId: "guest-1",
    vmid: 101,
    guestName: "files",
    guestKind: "ct" as const,
    jobName: "Every guest",
  };

  it("names the guest, the job and what the node reported last", () => {
    expect(pveRunning(row)).toEqual({
      id: "run-1",
      kind: "backup",
      guest: { id: "guest-1", vmid: 101, name: "files", kind: "ct" },
      jobName: "Every guest",
      startedAt: "2026-10-02T10:00:00.000Z",
      cancelling: false,
      progress: {
        bytesDone: 1024,
        bytesTotal: null,
        bytesUploaded: 10,
        bytesPerSecond: 512,
        at: "2026-10-02T10:00:05.000Z",
      },
    });
  });

  it("has no progress before the node's first report, and says when a stop was asked for", () => {
    const dto = pveRunning({
      ...row,
      progress: null,
      cancelRequestedAt: new Date("2026-10-02T10:01:00.000Z"),
      jobName: null,
    });
    expect(dto.progress).toBeNull();
    expect(dto.cancelling).toBe(true);
    expect(dto.jobName).toBeNull();
  });
});
