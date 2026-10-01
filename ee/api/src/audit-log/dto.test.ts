import { describe, expect, it } from "vitest";
import type { AuditEntryDto } from "./dto.js";
import { redactAuditEntryForDemo } from "./dto.js";

const ENTRY: AuditEntryDto = {
  id: "e1",
  tenantId: "t1",
  tenantName: "Tenant",
  actor: "someone@example.test",
  actorUserId: "u1",
  action: "restore.requested",
  target: "r1",
  targetType: "restore_job",
  targetLabel: null,
  onBehalfOf: null,
  ip: "203.0.113.7",
  details: null,
  prevHash: "prev",
  chainHash: "hash",
  hashValid: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("redactAuditEntryForDemo", () => {
  it("replaces a stored ip with null, leaving everything else untouched", () => {
    expect(redactAuditEntryForDemo(ENTRY)).toEqual({ ...ENTRY, ip: null });
  });

  it("leaves an already-null ip alone (and the same object, not a copy)", () => {
    const withoutIp = { ...ENTRY, ip: null };
    expect(redactAuditEntryForDemo(withoutIp)).toBe(withoutIp);
  });
});
