import { describe, expect, it } from "vitest";
import { type SnapshotRetentionPolicy, resolvePolicyFor } from "../retention/index.js";
import { jobRetentionAssignments, withJobRetention } from "./retention.js";

const tiers = [{ fromDays: 0, toDays: null, keepEveryDays: 0 }] as const;
const policy = (id: string, ids: string[] | null, isDefault = false): SnapshotRetentionPolicy => ({
  policyId: id,
  tiers,
  protectedObjectIds: ids,
  isDefault,
});

describe("job retention", () => {
  const tenantDefault = policy("default", null, true);
  const longTerm = policy("long", ["pinned"]);

  it("gives the job's objects the policy the job names", () => {
    const merged = withJobRetention(
      [tenantDefault, longTerm],
      [{ retentionPolicyId: "long", protectedObjectIds: ["a", "b"] }],
    );
    expect(resolvePolicyFor(merged, "a")?.policyId).toBe("long");
    expect(resolvePolicyFor(merged, "b")?.policyId).toBe("long");
    expect(resolvePolicyFor(merged, "other")?.policyId).toBe("default");
  });

  it("leaves an object with a policy of its own on that policy", () => {
    const own = policy("own", ["a"]);
    const merged = withJobRetention(
      [tenantDefault, own, longTerm],
      [{ retentionPolicyId: "long", protectedObjectIds: ["a", "b"] }],
    );
    expect(resolvePolicyFor(merged, "a")?.policyId).toBe("own");
    expect(resolvePolicyFor(merged, "b")?.policyId).toBe("long");
  });

  it("ignores a policy that is gone", () => {
    const merged = withJobRetention(
      [tenantDefault],
      [{ retentionPolicyId: "missing", protectedObjectIds: ["a"] }],
    );
    expect(merged).toEqual([tenantDefault]);
    expect(resolvePolicyFor(merged, "a")?.policyId).toBe("default");
  });

  it("changes nothing without assignments", () => {
    expect(withJobRetention([tenantDefault, longTerm], [])).toEqual([tenantDefault, longTerm]);
  });
});

describe("job retention assignments", () => {
  const objects = [
    { id: "a", imported: false },
    { id: "b", imported: false },
    { id: "imported", imported: true },
  ];

  it("lists the objects of every job that names a policy", () => {
    const assignments = jobRetentionAssignments(
      [
        { id: "all", scopeMode: "all", retentionPolicyId: "p1" },
        { id: "some", scopeMode: "selected", retentionPolicyId: "p2" },
        { id: "plain", scopeMode: "selected", retentionPolicyId: null },
      ],
      [{ jobId: "some", protectedObjectId: "b" }],
      objects,
    );
    expect(assignments).toEqual([
      { retentionPolicyId: "p1", protectedObjectIds: ["a"] },
      { retentionPolicyId: "p2", protectedObjectIds: ["b"] },
    ]);
  });
});
