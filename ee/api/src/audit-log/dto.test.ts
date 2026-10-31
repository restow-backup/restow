import { describe, expect, it } from "vitest";
import type { AuditEntryDto } from "./dto.js";
import { redactAuditEntryForDemo, redactPricesForTenant } from "./dto.js";

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

describe("redactPricesForTenant", () => {
  it("drops the details of a tenant's price change, keeping the entry and its hash state", () => {
    const entry = {
      ...ENTRY,
      action: "tenant.pricing.updated",
      details: { before: {}, after: { mailboxPrice: 7.77 } },
    };
    expect(redactPricesForTenant(entry)).toEqual({ ...entry, details: null });
  });

  it("strips price figures from any other entry, however deep, and keeps the rest", () => {
    const entry = {
      ...ENTRY,
      action: "settings.pricing.updated",
      details: {
        currency: "EUR",
        list: [{ storagePrice: 1, keep: true }],
        after: { mailboxPrice: 2 },
      },
    };
    expect(redactPricesForTenant(entry).details).toEqual({
      currency: "EUR",
      list: [{ keep: true }],
      after: {},
    });
  });

  it("leaves an entry without details alone", () => {
    expect(redactPricesForTenant(ENTRY)).toBe(ENTRY);
  });
});
