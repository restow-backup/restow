import { describe, expect, it } from "vitest";
import type { DatedSnapshot } from "../retention-policy.js";
import { applyGroupedRetention, retentionGroupsOf, sqlRetentionGroup } from "./retention-groups.js";

function id(n: number): string {
  return n.toString(16).padStart(64, "0");
}

function daily(start: number, count: number, offset: number): DatedSnapshot[] {
  return Array.from({ length: count }, (_, day) => ({
    id: id(start + day),
    time: new Date(Date.UTC(2026, 10, 1 + day, offset)),
  }));
}

describe("retention groups", () => {
  it("puts every snapshot in the group of the run that reported it", () => {
    const files = daily(1, 3, 1);
    const sql = daily(100, 3, 2);
    const groups = retentionGroupsOf(
      [...files, ...sql],
      [
        ...files.map((snapshot) => ({ snapshotId: snapshot.id.slice(0, 8 + 56), group: "files" })),
        ...sql.map((snapshot) => ({
          snapshotId: snapshot.id,
          group: sqlRetentionGroup("sqlexpress"),
        })),
      ],
    );
    expect([...groups.keys()].sort()).toEqual(["files", "sql:SQLEXPRESS"]);
    expect(groups.get("sql:SQLEXPRESS")).toHaveLength(3);
  });

  it("keeps the rules per group, so SQL snapshots never push file backups out", () => {
    const files = daily(1, 10, 1);
    const sql = daily(100, 10, 2);
    const decision = applyGroupedRetention(
      [...files, ...sql],
      [
        ...files.map((snapshot) => ({ snapshotId: snapshot.id, group: "files" })),
        ...sql.map((snapshot) => ({ snapshotId: snapshot.id, group: "sql:SQLEXPRESS" })),
      ],
      { keepDaily: 3, keepWeekly: 0, keepMonthly: 0 },
      "UTC",
    );
    expect(decision.groups).toEqual({
      files: { keep: 3, remove: 7 },
      "sql:SQLEXPRESS": { keep: 3, remove: 7 },
    });
    expect(decision.keep).toEqual([id(109), id(10), id(108), id(9), id(107), id(8)]);
  });
});
