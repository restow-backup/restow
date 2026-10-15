import type { FileShare, FileShareRun } from "@restow/db";
import { describe, expect, it } from "vitest";
import { shareSpecOf } from "./dispatch.js";
import { eventsOf, runQueueName } from "./finish.js";

const share = {
  id: "s1",
  tenantId: "t1",
  name: "Data",
  protocol: "nfs",
  server: "nfs.example.test",
  exportPath: "/srv/data",
  shareName: null,
  subfolder: "Finance",
  nfsVersion: null,
  smbVersion: null,
  smbDomain: null,
  smbEncryption: false,
  username: null,
} as unknown as FileShare;

const run = (values: Partial<FileShareRun>): FileShareRun =>
  ({
    id: "r1",
    tenantId: "t1",
    kind: "backup",
    trigger: "schedule",
    status: "succeeded",
    stats: {},
    errorMessage: null,
    failure: null,
    backupJobId: null,
    finishedAt: new Date("2026-10-10T22:00:00Z"),
    ...values,
  }) as FileShareRun;

describe("file share run helpers", () => {
  it("names the webhook queue of a run", () => {
    expect(runQueueName({ kind: "backup", trigger: "schedule" })).toBe("file-share-backup");
    expect(runQueueName({ kind: "restore", trigger: "manual" })).toBe("file-share-restore");
    expect(runQueueName({ kind: "restore", trigger: "copy" })).toBe("file-share-copy");
  });

  it("raises backup.failed, restore.failed and restore.completed with the share as subject", () => {
    expect(eventsOf(run({}), share)).toEqual([]);
    const failed = eventsOf(run({ status: "failed", errorMessage: "share.auth_failed" }), share);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      event: "backup.failed",
      level: "error",
      details: { fileShareId: "s1", objectName: "Data", runId: "r1" },
    });
    expect(eventsOf(run({ kind: "restore", status: "failed" }), share)[0]?.event).toBe(
      "restore.failed",
    );
    expect(
      eventsOf(
        run({ kind: "restore", status: "warning", stats: { restore: { restored: 3 } } }),
        share,
      )[0]?.event,
    ).toBe("restore.completed");
    // A copy that copied nothing, or was up to date, raises nothing.
    expect(
      eventsOf(run({ kind: "restore", trigger: "copy", stats: { upToDate: true } }), share),
    ).toEqual([]);
    expect(
      eventsOf(
        run({ kind: "restore", trigger: "copy", stats: { restore: { restored: 0 } } }),
        share,
      ),
    ).toEqual([]);
    expect(
      eventsOf(
        run({ kind: "restore", trigger: "copy", stats: { restore: { deleted: 2 } } }),
        share,
      ),
    ).toHaveLength(1);
  });

  it("builds the mounter's share with defaults for the versions", () => {
    expect(shareSpecOf(share, "10.0.0.1", null)).toEqual({
      protocol: "nfs",
      server: "nfs.example.test",
      address: "10.0.0.1",
      export: "/srv/data",
      subfolder: "Finance",
      nfsVersion: "4.1",
    });
    expect(
      shareSpecOf(
        {
          ...share,
          protocol: "smb",
          shareName: "data",
          username: "u",
          exportPath: null,
        } as FileShare,
        "10.0.0.1",
        "pw",
      ),
    ).toMatchObject({
      protocol: "smb",
      share: "data",
      username: "u",
      password: "pw",
      smbVersion: "3.1.1",
      seal: false,
    });
  });
});
