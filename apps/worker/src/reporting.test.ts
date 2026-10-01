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
});
