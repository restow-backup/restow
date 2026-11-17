import type { BillingCorrectionRow, BillingPeriodRow, BillingPeriodTenantRow } from "@restow/db";
import { describe, expect, it } from "vitest";
import { PERIOD_CSV_COLUMNS, periodCsv } from "./billing-periods.js";

const period: BillingPeriodRow = {
  id: "cccccccc-3333-4333-8333-333333333333",
  period: "2026-10",
  timeZone: "Europe/Berlin",
  startsAt: new Date("2026-09-30T22:00:00.000Z"),
  endsAt: new Date("2026-10-31T23:00:00.000Z"),
  closedAt: new Date("2026-10-31T23:00:30.000Z"),
  currency: "EUR",
  storageUnit: "TB",
  storageBilling: "exact",
  prices: { mailboxPrice: 2 },
  perTenantOverrides: false,
  days: 31,
  sampledDays: 31,
  total: 20,
  createdAt: new Date("2026-10-31T23:00:30.000Z"),
};

const tenant = (over: Partial<BillingPeriodTenantRow>): BillingPeriodTenantRow => ({
  id: "dddddddd-4444-4444-8444-444444444444",
  periodId: period.id,
  tenantId: "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f",
  name: "Contoso",
  customerNumber: "K-1001",
  kind: "customer",
  status: "active",
  complete: true,
  sampledDays: 31,
  lines: [],
  total: null,
  createdAt: period.createdAt,
  ...over,
});

const correction: BillingCorrectionRow = {
  id: "eeeeeeee-5555-4555-8555-555555555555",
  periodId: period.id,
  tenantId: "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f",
  lineType: "mailboxes",
  amount: -2,
  reason: "=SUM(A1) test mailbox",
  actor: "owner@provider.example",
  apiKeyId: null,
  createdAt: new Date("2026-11-02T08:00:00.000Z"),
};

describe("the CSV of a closed month", () => {
  it("has one row per tenant and line, one per correction, and a tenant without lines once", () => {
    const csv = periodCsv({
      period,
      tenants: [
        tenant({
          lines: [
            {
              type: "mailboxes",
              quantity: 10,
              unit: "mailbox",
              unitPrice: 2,
              priceSource: "installation",
              amount: 20,
              peakDate: "2026-10-14",
            },
          ],
          total: 20,
        }),
        tenant({
          tenantId: "9b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b",
          name: "Fabrikam, Inc.",
          customerNumber: null,
        }),
      ],
      corrections: [correction],
    });
    expect(csv.startsWith("\uFEFF")).toBe(true);
    const lines = csv.slice(1).trimEnd().split("\r\n");
    expect(lines[0]).toBe(PERIOD_CSV_COLUMNS.join(","));
    expect(lines.slice(1)).toEqual([
      "2026-10,0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f,Contoso,K-1001,customer,active,31,31,line,mailboxes,10,mailbox,2,installation,20,2026-10-14,EUR,,",
      // A spreadsheet formula in a reason is neutralised.
      "2026-10,0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f,Contoso,K-1001,customer,active,31,31,correction,mailboxes,,,,,-2,,EUR,'=SUM(A1) test mailbox,2026-11-02T08:00:00.000Z",
      '2026-10,9b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b,"Fabrikam, Inc.",,customer,active,31,31,line,,,,,,,,EUR,,',
    ]);
  });
});
