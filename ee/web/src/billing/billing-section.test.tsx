import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import { billingKeys } from "./api";
import { BillingSection } from "./billing-section";
import { formatPeriod, parseAmount } from "./presenters";

/**
 * Installation › Billing (0.6.0): the months with the open one and the day it closes, a closed
 * month with its lines at the peak and the day of the peak, the days sampled against the days of
 * the month, its corrections, the CSV export, and corrections for the owner only.
 */

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: vi.fn().mockRejectedValue(new Error("no request expected")),
}));

let providerRole = "owner";
vi.mock("@/lib/session", () => ({
  useSession: () => ({
    status: "authenticated",
    isProviderAdmin: true,
    providerRole,
    providerAllTenants: true,
    activeTenant: null,
    role: "provider_admin",
    features: ["apiKeys.provider"],
    extensions: { edition: "service_provider" },
  }),
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const LIST = {
  items: [
    {
      period: "2026-10",
      status: "closed",
      timeZone: "Europe/Berlin",
      startsAt: "2026-09-30T22:00:00.000Z",
      endsAt: "2026-10-31T23:00:00.000Z",
      closedAt: "2026-10-31T23:00:30.000Z",
      currency: "EUR",
      tenants: 2,
      total: 47,
      correctedTotal: 45,
      corrections: 1,
    },
  ],
  open: {
    period: "2026-11",
    startsAt: "2026-10-31T23:00:00.000Z",
    closesAt: "2026-11-30T23:00:00.000Z",
  },
};

const MONTH = {
  period: "2026-10",
  status: "closed",
  timeZone: "Europe/Berlin",
  startsAt: "2026-09-30T22:00:00.000Z",
  endsAt: "2026-10-31T23:00:00.000Z",
  closedAt: "2026-10-31T23:00:30.000Z",
  generatedAt: "2026-10-31T23:00:30.000Z",
  currency: "EUR",
  storageBilling: "exact",
  days: 31,
  sampledDays: 29,
  total: 47,
  correctedTotal: 45,
  missing: 0,
  tenants: [
    {
      tenantId: "t-1",
      name: "Contoso",
      customerNumber: "K-1001",
      kind: "customer",
      status: "active",
      complete: true,
      sampledDays: 29,
      lines: [
        {
          type: "mailboxes",
          quantity: 12,
          unit: "mailbox",
          unitPrice: 2,
          priceSource: "installation",
          amount: 24,
          peakDate: "2026-10-14",
        },
        {
          type: "storage",
          quantity: 2.3,
          unit: "TB",
          unitPrice: 10,
          priceSource: "tenant",
          amount: 23,
          peakDate: "2026-10-30",
        },
      ],
      total: 47,
      corrections: [
        {
          id: "c-1",
          tenantId: "t-1",
          type: "mailboxes",
          amount: -2,
          reason: "One test mailbox",
          createdAt: "2026-11-02T08:00:00.000Z",
          createdBy: "owner@provider.example",
        },
      ],
      correctedTotal: 45,
    },
    {
      tenantId: "t-2",
      name: "Fabrikam",
      customerNumber: null,
      kind: "customer",
      status: "deleting",
      complete: true,
      sampledDays: 9,
      lines: [],
      total: null,
      corrections: [],
      correctedTotal: null,
    },
  ],
};

function render(node: React.ReactNode): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(billingKeys.list(), LIST);
  client.setQueryData(billingKeys.period("2026-10"), MONTH);
  client.setQueryData(["setup", "state"], undefined);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
    </QueryClientProvider>,
  );
}

describe("BillingSection", () => {
  it("lists the open month with the day it closes and the closed ones with their totals", () => {
    providerRole = "owner";
    const html = render(<BillingSection />);
    expect(html).toContain("November 2026");
    expect(html).toContain("closes on");
    expect(html).toContain("October 2026");
    expect(html).toContain("€47.00");
    expect(html).toContain("€45.00");
    // Accessible tables: a caption and column headers.
    expect(html).toContain("<caption");
    expect(html).toContain('scope="col"');
  });

  it("shows the newest closed month: peak, day of the peak, price source, sampled days, corrections", () => {
    providerRole = "owner";
    const html = render(<BillingSection />);
    expect(html).toContain('data-month="2026-10"');
    expect(html).toContain("Sampled on 29 of 31 days");
    expect(html).toContain("Some days have no sample");
    expect(html).toContain("Oct 14, 2026");
    expect(html).toContain("own price");
    expect(html).toContain("no customer number");
    expect(html).toContain("Deleted");
    expect(html).toContain("No price");
    expect(html).toContain("One test mailbox");
    expect(html).toContain("Export CSV");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Add correction/);
  });

  it("lets only the owner add a correction", () => {
    providerRole = "read_only";
    const html = render(<BillingSection />);
    expect(html).toContain("October 2026");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Add correction/);
    expect(html).toContain("needs the Owner role in the provider team");
  });
});

describe("billing presenters", () => {
  it("reads a correction amount with comma or point, never 0", () => {
    expect(parseAmount("-12,50")).toBe(-12.5);
    expect(parseAmount("7.25")).toBe(7.25);
    expect(parseAmount("0")).toBeNull();
    expect(parseAmount("12,34567")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
  });

  it("names a month in the UI language", () => {
    expect(formatPeriod("2026-10", "de")).toBe("Oktober 2026");
    expect(formatPeriod("2026-10", "en")).toBe("October 2026");
  });
});
