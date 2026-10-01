import { describe, expect, it } from "vitest";
import { catalogEntry, isFailureCode } from "../failures/index.js";
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
