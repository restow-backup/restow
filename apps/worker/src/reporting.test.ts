import { describe, expect, it } from "vitest";
import { jobFinishedNotification } from "./reporting.js";

const TENANT = "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f";

function failedJob(failure: unknown) {
  return {
    id: "j-1",
    queue: "backup" as const,
    status: "failed" as const,
    protectedObjectId: "o-1",
    completedAt: new Date("2026-09-29T10:00:00.000Z"),
    errorMessage: "GraphError: Graph GET failed with 403",
    failure: failure as never,
  };
}

describe("jobFinishedNotification", () => {
  it("carries the cause of a failed job with the ids of the steps to take", () => {
    const notification = jobFinishedNotification(
      TENANT,
      failedJob({
        v: 1,
        code: "graph.permission_missing",
        transient: false,
        params: { permission: "Mail.ReadWrite" },
        technical: { requestId: "r-1" },
        occurredAt: "2026-09-29T10:00:00.000Z",
        step: null,
        retry: null,
      }),
      "Alice",
    );
    expect(notification?.details).toMatchObject({
      errorMessage: "GraphError: Graph GET failed with 403",
      failure: {
        code: "graph.permission_missing",
        transient: false,
        params: { permission: "Mail.ReadWrite" },
        steps: ["grant_permission", "verify_permissions"],
      },
    });
    // The technical details (request ids and the like) stay out of alerts that leave the system.
    expect(JSON.stringify(notification?.details)).not.toContain("r-1");
  });

  it("raises nothing for a backup that Graph or the storage held back (throttled, unavailable)", () => {
    for (const code of ["graph.throttled", "graph.service_unavailable", "storage.rate_limited"]) {
      const failure = {
        v: 1,
        code,
        transient: true,
        params: {},
        technical: { httpStatus: 503 },
        occurredAt: "2026-10-27T07:11:41.290Z",
        step: null,
        retry: null,
      };
      expect(jobFinishedNotification(TENANT, failedJob(failure), "Alice")).toBeNull();
      // The same cause on a restore is still reported: someone waits for that restore.
      expect(
        jobFinishedNotification(
          TENANT,
          { ...failedJob(failure), queue: "restore" as const },
          "Alice",
        )?.event,
      ).toBe("restore.failed");
    }
  });

  it("raises backup.failed for a SharePoint site that is gone, with the steps for it", () => {
    const notification = jobFinishedNotification(
      TENANT,
      failedJob({
        v: 1,
        code: "graph.site_unavailable",
        transient: false,
        params: { resource: "sharepoint" },
        technical: {},
        occurredAt: "2026-09-29T10:00:00.000Z",
        step: null,
        retry: null,
      }),
      "Sales (SharePoint)",
    );
    expect(notification).toMatchObject({
      event: "backup.failed",
      level: "error",
      details: {
        objectName: "Sales (SharePoint)",
        failure: { code: "graph.site_unavailable", steps: ["sync_directory", "exclude_object"] },
      },
    });
  });

  it("says nothing new for a failed job without a cause, and never for a job that worked", () => {
    expect(jobFinishedNotification(TENANT, failedJob(null), "Alice")?.details).toMatchObject({
      failure: null,
    });
    const done = jobFinishedNotification(
      TENANT,
      { ...failedJob({ code: "x" }), status: "completed", queue: "restore" as const },
      "Alice",
    );
    expect(done?.details).toMatchObject({ failure: null });
  });

  it("raises restore.failed for a restore that completed but restored nothing while items failed", () => {
    const restore = { ...failedJob(null), status: "completed" as const, queue: "restore" as const };
    const nothing = jobFinishedNotification(
      TENANT,
      { ...restore, restoreResult: { restored: 0, skipped: 0, failures: 2, unverified: 0 } },
      "Alice",
    );
    expect(nothing).toMatchObject({
      event: "restore.failed",
      level: "error",
      message: "The restore job for Alice failed: Nothing was restored: 2 items failed.",
      details: {
        errorMessage: "Nothing was restored: 2 items failed.",
        failure: null,
        restoreOutcome: "nothingRestored",
      },
    });
    // Everything skipped, nothing failed: completed, but not worded as if something came back.
    const skipped = jobFinishedNotification(
      TENANT,
      { ...restore, restoreResult: { restored: 0, skipped: 5, failures: 0, unverified: 0 } },
      "Alice",
    );
    expect(skipped).toMatchObject({
      event: "restore.completed",
      level: "info",
      message:
        "The restore for Alice completed without restoring anything: every item was skipped.",
      details: { errorMessage: null, restoreOutcome: "allSkipped" },
    });
    // Restored items next to failed ones: a completed restore as before.
    const partial = jobFinishedNotification(
      TENANT,
      { ...restore, restoreResult: { restored: 4, skipped: 0, failures: 1, unverified: 0 } },
      "Alice",
    );
    expect(partial).toMatchObject({
      event: "restore.completed",
      message: "The restore for Alice completed.",
    });
    expect(partial?.details).not.toHaveProperty("restoreOutcome");
  });

  it("raises backup.succeeded for a backup that worked, nothing for other finished queues", () => {
    const backup = jobFinishedNotification(
      TENANT,
      { ...failedJob(null), status: "completed", queue: "backup" as const },
      "Alice",
    );
    expect(backup).toMatchObject({ event: "backup.succeeded", level: "info" });
    expect(
      jobFinishedNotification(
        TENANT,
        { ...failedJob(null), status: "completed", queue: "scrub" as const },
        "Alice",
      ),
    ).toBeNull();
  });
});
