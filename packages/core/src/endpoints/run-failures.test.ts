import { describe, expect, it } from "vitest";
import { catalogEntry, isFailureCode } from "../failures/index.js";
import { ENDPOINT_RUN_ERROR_CODES } from "./run-errors.js";
import {
  agentStoppedCause,
  backupOverdueCause,
  classifyRunError,
  failureOfRun,
  repositoryDamagedCause,
  silentCause,
} from "./run-failures.js";

describe("explaining the agent's run errors", () => {
  it("maps every code the agent sends to a cause the catalog knows", () => {
    const expected: Record<string, string> = {
      no_paths: "endpoint.no_paths",
      pre_hook_failed: "endpoint.pre_hook_failed",
      post_hook_failed: "endpoint.post_hook_failed",
      timeout: "endpoint.timeout",
      target_not_empty: "endpoint.target_not_empty",
      invalid_task: "endpoint.invalid_task",
      hash_mismatch: "endpoint.hash_mismatch",
      missing: "endpoint.file_missing",
      not_regular: "endpoint.file_not_regular",
      read_error: "endpoint.read_error",
      interrupted: "endpoint.interrupted",
      agent_stopped: "endpoint.agent_stopped",
      source_unreadable: "endpoint.source_unreadable",
      source_is_mount_point: "endpoint.source_is_mount_point",
    };
    for (const [agentCode, code] of Object.entries(expected)) {
      const cause = classifyRunError({ code: agentCode, message: "m" });
      expect(cause.code, agentCode).toBe(code);
      expect(isFailureCode(cause.code)).toBe(true);
      expect(catalogEntry(cause.code), code).not.toBeNull();
    }
  });

  it("reads restic's exit codes", () => {
    const of = (code: string, message = "") => classifyRunError({ code, message });
    expect(of("restic_exit_10").code).toBe("endpoint.repository_missing");
    expect(of("restic_exit_11")).toMatchObject({
      code: "endpoint.repository_locked",
      transient: true,
    });
    expect(of("restic_exit_12").code).toBe("endpoint.repository_password");
    expect(of("restic_exit_3").code).toBe("endpoint.read_error");
    expect(of("restic_exit_1", "dial tcp 10.0.0.5:443: connect: connection refused")).toMatchObject(
      {
        code: "endpoint.network",
        transient: true,
      },
    );
    expect(of("restic_exit_1", "unexpected HTTP response (403): 403 Forbidden").code).toBe(
      "endpoint.repository_refused",
    );
    expect(of("restic_exit_1", "something odd")).toMatchObject({
      code: "endpoint.restic_failed",
      params: { exitCode: 1 },
    });
  });

  it("keeps the path and a redacted message for the technical details", () => {
    const cause = classifyRunError({
      code: "target_not_empty",
      path: "/srv/restore",
      message: "target /srv/restore is not empty; Authorization: Bearer abcdefghijklmnop",
    });
    expect(cause.params.path).toBe("/srv/restore");
    expect(cause.technical.path).toBe("/srv/restore");
    expect(JSON.stringify(cause.technical)).not.toContain("abcdefghijklmnop");
    expect(cause.technical.agentCode).toBe("target_not_empty");
  });

  it("explains a run by the error that decides what to do first", () => {
    const cause = failureOfRun([
      { code: "read_error", message: "a" },
      { code: "read_error", message: "b" },
      { code: "pre_hook_failed", message: "dump failed" },
    ]);
    expect(cause?.code).toBe("endpoint.pre_hook_failed");
    expect(cause?.params.count).toBe(3);
    expect(failureOfRun([{ code: "read_error", message: "a" }])?.params.count).toBeUndefined();
    expect(failureOfRun([])).toBeNull();
    expect(failureOfRun([{ message: "no code at all" }])?.code).toBe("endpoint.restic_failed");
  });

  it("explains the file system snapshot codes", () => {
    const failed = classifyRunError({
      code: "snapshot_failed",
      path: "C:\\",
      message: "The shadow copy of C:\\ could not be created (VSS_E_SNAPSHOT_SET_IN_PROGRESS).",
    });
    expect(failed.code).toBe("endpoint.snapshot_failed");
    expect(failed.transient).toBe(true);
    expect(failed.params.path).toBe("C:\\");
    const unavailable = classifyRunError({ code: "snapshot_unavailable", message: "VSS error" });
    expect(unavailable.code).toBe("endpoint.snapshot_unavailable");
    expect(unavailable.transient).toBe(false);
    // A machine-wide VSS failure (the service disabled, access denied) is fixed on the machine,
    // not by waiting: the step is the service check, never "wait for the next run".
    const steps = catalogEntry("endpoint.snapshot_unavailable")
      ?.steps({})
      .map((s) => s.id);
    expect(steps).toContain("check_endpoint_snapshot_service");
    expect(steps).not.toContain("wait_endpoint_retry");
    expect(
      failureOfRun([
        { code: "snapshot_failed", path: "D:\\", message: "VSS_E_SNAPSHOT_SET_IN_PROGRESS" },
        {
          code: "snapshot_unavailable",
          message:
            "The file system snapshot (Volume Shadow Copy) cannot be used on this machine: the Volume Shadow Copy service (VSS) is disabled (C:\\: VSS error: UNKNOWN (0x80070422)).",
        },
      ]),
    ).toMatchObject({ code: "endpoint.snapshot_unavailable", transient: false });
    // "No snapshot at all" decides before the files restic could not read.
    expect(
      failureOfRun([
        { code: "archival", message: "open C:\\x.pst: in use" },
        { code: "snapshot_unavailable", message: "VSS error" },
      ])?.code,
    ).toBe("endpoint.snapshot_unavailable");
    // A shadow copy left behind is never the explanation.
    expect(
      failureOfRun([
        { code: "snapshot_cleanup_failed", path: "C:\\", message: "not deleted" },
        { code: "read_error", message: "a" },
      ])?.code,
    ).toBe("endpoint.read_error");
    expect(failureOfRun([{ code: "snapshot_cleanup_failed", message: "not deleted" }])).toBeNull();
  });

  it("explains a layout that could not be recorded, and never by a layout the server refused", () => {
    const capture = classifyRunError({
      code: "layout_capture_failed",
      message: "lsblk: not found",
    });
    expect(capture.code).toBe("endpoint.layout_capture_failed");
    expect(capture.transient).toBe(false);
    expect(
      failureOfRun([
        { code: "layout_rejected", message: "control character" },
        { code: "layout_capture_failed", message: "lsblk: not found" },
      ])?.code,
    ).toBe("endpoint.layout_capture_failed");
    expect(failureOfRun([{ code: "layout_rejected", message: "too large" }])).toBeNull();
    expect(failureOfRun([{ code: "layout_too_large", message: "600 KiB" }])).toBeNull();
    // An LVM or btrfs snapshot speaks the same codes as a shadow copy.
    expect(
      failureOfRun([{ code: "snapshot_failed", path: "/home", message: "lvcreate failed" }])
        ?.params,
    ).toEqual({ path: "/home" });
  });

  it("explains a backup path that exists but was not backed up", () => {
    const locked = classifyRunError({
      code: "source_unreadable",
      path: "E:\\",
      message:
        "The backup path E:\\ cannot be read: This drive is locked by BitLocker Drive Encryption.",
    });
    expect(locked.code).toBe("endpoint.source_unreadable");
    expect(locked.transient).toBe(false);
    expect(locked.params.path).toBe("E:\\");
    const mount = classifyRunError({
      code: "source_is_mount_point",
      path: "C:\\Mnt\\Data",
      message: "x",
    });
    expect(mount.code).toBe("endpoint.source_is_mount_point");
    expect(mount.transient).toBe(false);
    // A whole folder missing decides before a file restic could not read.
    expect(
      failureOfRun([
        { code: "archival", message: "open C:\\x.pst: in use" },
        { code: "source_unreadable", path: "E:\\", message: "locked" },
      ])?.code,
    ).toBe("endpoint.source_unreadable");
    expect(ENDPOINT_RUN_ERROR_CODES).toContain("source_unreadable");
    expect(ENDPOINT_RUN_ERROR_CODES).toContain("source_is_mount_point");
  });

  it("knows the causes the server derives itself", () => {
    expect(agentStoppedCause().code).toBe("endpoint.agent_stopped");
    expect(silentCause(2.6).params).toEqual({ ageHours: 3 });
    expect(backupOverdueCause(7.2).params).toEqual({ ageDays: 7 });
    expect(repositoryDamagedCause("pack damaged").technical.message).toBe("pack damaged");
    for (const cause of [
      agentStoppedCause(),
      silentCause(3),
      backupOverdueCause(8),
      repositoryDamagedCause(),
    ]) {
      expect(catalogEntry(cause.code)).not.toBeNull();
    }
  });
});
