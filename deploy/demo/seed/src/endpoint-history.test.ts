import { describe, expect, it } from "vitest";
import { findReport, pollUntil } from "./endpoint-history.js";

const SNAPSHOT = "0123456789abcdef";

describe("findReport", () => {
  const detail = {
    reports: [
      { kind: "restore_test", origin: "server", snapshotId: "other", readiness: "green" },
      { kind: "repository_check", origin: "server", snapshotId: null, readiness: "green" },
      { kind: "restore_test", origin: "agent", snapshotId: SNAPSHOT, readiness: "green" },
      { kind: "restore_test", origin: "server", snapshotId: SNAPSHOT, readiness: "red" },
    ],
  };

  it("finds the report of exactly this kind, origin and snapshot", () => {
    expect(findReport(detail, "restore_test", "server", SNAPSHOT)?.readiness).toBe("red");
    expect(findReport(detail, "restore_test", "agent", SNAPSHOT)?.readiness).toBe("green");
  });

  it("with a start time, ignores a test that started before it", () => {
    const timed = {
      reports: [
        {
          kind: "restore_test",
          origin: "server",
          snapshotId: SNAPSHOT,
          readiness: "green",
          checkedAt: "2026-10-01T02:12:20.981Z",
        },
        {
          kind: "restore_test",
          origin: "server",
          snapshotId: SNAPSHOT,
          readiness: "red",
          checkedAt: "2026-10-01T02:12:02.509Z",
        },
      ],
    };
    const asked = new Date("2026-10-01T02:12:18.000Z");
    expect(findReport(timed, "restore_test", "server", SNAPSHOT, asked)?.readiness).toBe("green");
    // Before the second test exists, the earlier red one is not the answer.
    expect(
      findReport({ reports: timed.reports.slice(1) }, "restore_test", "server", SNAPSHOT, asked),
    ).toBeNull();
    // A report without a time never matches a start time.
    expect(findReport(detail, "restore_test", "server", SNAPSHOT, asked)).toBeNull();
    expect(findReport(timed, "restore_test", "server", SNAPSHOT)?.readiness).toBe("green");
  });

  it("finds nothing for a snapshot that was not tested", () => {
    expect(findReport(detail, "restore_test", "server", "unknown")).toBeNull();
    expect(findReport(detail, "repository_check", "agent", SNAPSHOT)).toBeNull();
  });
});

describe("pollUntil", () => {
  it("returns the first answer that is not null", async () => {
    let calls = 0;
    const value = await pollUntil(
      async () => {
        calls += 1;
        return calls === 3 ? "done" : null;
      },
      { timeoutMs: 1000, intervalMs: 1, what: "something" },
    );
    expect(value).toBe("done");
    expect(calls).toBe(3);
  });

  it("gives up with a message that says what it waited for", async () => {
    await expect(
      pollUntil(async () => null, { timeoutMs: 20, intervalMs: 5, what: "the restore test" }),
    ).rejects.toThrow("timed out waiting for the restore test");
  });
});
