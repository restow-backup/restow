import { describe, expect, it } from "vitest";
import type {
  EstimateTenantDto,
  PricingEstimateDto,
} from "../../../../apps/api/src/features/settings/pricing-estimate.js";
import { billingFromEstimate, billingLines, tenantByCustomerNumber } from "./billing.js";

const NOW = new Date("2026-11-15T12:00:00.000Z");

function entry(over: Partial<EstimateTenantDto> = {}): EstimateTenantDto {
  return {
    tenantId: "11111111-1111-4111-8111-111111111111",
    name: "Contoso",
    kind: "customer",
    mailboxes: 40,
    storedBytes: 250e9,
    billedBytes: 300e9,
    servers: 2,
    clients: 10,
    vms: 3,
    containers: 0,
    fileShares: null,
    mailboxPrice: 1.5,
    storagePrice: 0.05,
    serverPrice: 12,
    clientPrice: 4,
    vmPrice: null,
    containerPrice: 2,
    fileSharePrice: null,
    overridden: {
      mailbox: false,
      storage: true,
      server: false,
      client: true,
      vm: false,
      container: false,
      fileShare: false,
    },
    amount: {
      mailboxes: 60,
      storage: 15,
      servers: 24,
      clients: 40,
      vms: null,
      containers: 0,
      fileShares: null,
      total: 139,
    },
    ...over,
  } as EstimateTenantDto;
}

function estimate(tenants: EstimateTenantDto[]): PricingEstimateDto {
  return {
    currency: "EUR",
    storageUnit: "GB",
    storageBilling: "block_100gb",
    global: {} as PricingEstimateDto["global"],
    perTenantOverrides: true,
    hasPrices: true,
    tenants,
    total: 139,
    missing: 0,
  };
}

describe("the billing lines of a tenant", () => {
  it("has one line per priced quantity, with the price's source and the billed storage", () => {
    expect(billingLines(entry(), "GB")).toEqual([
      {
        type: "mailboxes",
        quantity: 40,
        unit: "mailbox",
        unitPrice: 1.5,
        priceSource: "installation",
        amount: 60,
      },
      // The billed bytes (rounded up to 100 GB blocks), in the price's unit.
      {
        type: "storage",
        quantity: 300,
        unit: "GB",
        unitPrice: 0.05,
        priceSource: "tenant",
        amount: 15,
      },
      {
        type: "servers",
        quantity: 2,
        unit: "unit",
        unitPrice: 12,
        priceSource: "installation",
        amount: 24,
      },
      {
        type: "clients",
        quantity: 10,
        unit: "unit",
        unitPrice: 4,
        priceSource: "tenant",
        amount: 40,
      },
      // A priced line with no units is still a line (0 units); unpriced quantities are none.
      {
        type: "containers",
        quantity: 0,
        unit: "unit",
        unitPrice: 2,
        priceSource: "installation",
        amount: 0,
      },
    ]);
  });

  it("names customer number and status, leaves out tenants being deleted and marks missing figures", () => {
    const missing = entry({
      tenantId: "22222222-2222-4222-8222-222222222222",
      name: "Fabrikam",
      mailboxes: null,
      storedBytes: null,
      billedBytes: null,
      servers: null,
      clients: null,
      vms: null,
      containers: null,
      amount: {
        mailboxes: null,
        storage: null,
        servers: null,
        clients: null,
        vms: null,
        containers: null,
        fileShares: null,
        total: null,
      },
    });
    const gone = entry({ tenantId: "33333333-3333-4333-8333-333333333333" });
    const facts = new Map([
      [entry().tenantId, { customerNumber: "K-1001", status: "active" as const }],
      [missing.tenantId, { customerNumber: null, status: "suspended" as const }],
    ]);
    const billing = billingFromEstimate(estimate([entry(), missing, gone]), facts, NOW);
    expect(billing).toMatchObject({
      generatedAt: NOW.toISOString(),
      currency: "EUR",
      storageBilling: "block_100gb",
      total: 139,
    });
    expect(
      billing.tenants.map((t) => [t.name, t.customerNumber, t.status, t.complete, t.total]),
    ).toEqual([
      ["Contoso", "K-1001", "active", true, 139],
      ["Fabrikam", null, "suspended", false, null],
    ]);
    expect(billing.tenants[1]?.lines).toEqual([]);
    expect(tenantByCustomerNumber(facts, " k-1001 ")).toBe(entry().tenantId);
    expect(tenantByCustomerNumber(facts, "K-9")).toBeUndefined();
  });
});
