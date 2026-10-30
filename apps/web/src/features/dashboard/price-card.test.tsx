import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PricingEstimate } from "@/features/pricing/api";
import { estimateKey } from "@/features/pricing/api";
import { ACME, estimateFixture, estimateTenant, noPriceEstimate } from "@/features/pricing/testing";
import { newQueryClient, sessionAs } from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { type SessionContextValue, StaticSessionProvider } from "@/lib/session";
import type { TenantWidgets } from "./api.js";
import { DashboardWidgets } from "./widget-registry.js";
import { PriceWidget } from "./widgets/price-widget.js";

/**
 * The price card on the status row (0.4.8): for a provider admin whose installation has a price
 * the row is readiness on the left half and, on the right half, "Last successful backup" and the
 * price card side by side; without a price, or for anybody else, the row is exactly what it was.
 */

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      className,
      children,
    }: {
      to: string;
      className?: string;
      children: React.ReactNode;
    }) => (
      <a href={to} className={className}>
        {children}
      </a>
    ),
  };
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const TENANT = { id: ACME, name: "Acme" } as SessionContextValue["activeTenant"];

function render(
  node: React.ReactNode,
  { session = sessionAs({ activeTenant: TENANT }), client = newQueryClient() } = {},
): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <StaticSessionProvider value={session}>{node}</StaticSessionProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

function seeded(estimate: PricingEstimate): QueryClient {
  const client = newQueryClient();
  client.setQueryData(estimateKey(ACME), estimate);
  return client;
}

const widgets: TenantWidgets = { readiness: { state: "error" }, lastBackup: { state: "error" } };

function row(
  isProviderAdmin: boolean,
  client: QueryClient,
  session = sessionAs({ activeTenant: TENANT }),
) {
  const html = render(
    <DashboardWidgets
      widgets={widgets}
      loading={false}
      canAdminister
      isProviderAdmin={isProviderAdmin}
      onRetry={() => {}}
      retrying={false}
      trendDays={14}
      onTrendDaysChange={() => {}}
    />,
    { session, client },
  );
  const section = /<section[^>]*data-section="status"[^>]*>(.*?)<\/section>/s.exec(html);
  const status = section?.[0] ?? "";
  return {
    status,
    columns: /<section[^>]*class="([^"]*)"/.exec(status)?.[1] ?? "",
    cells: [...status.matchAll(/<div data-slot="widget-cell" class="([^"]*)"/g)].map(
      (match) => match[1] ?? "",
    ),
    order: [...status.matchAll(/data-widget="(\w+)"/g)].map((match) => match[1]),
  };
}

/** The text of rendered markup, without its tags. */
function plain(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/<!-- -->/g, "");
}

describe("the status row", () => {
  it("is readiness on the left half and last backup and price side by side on the right", () => {
    const { columns, cells, order, status } = row(true, seeded(estimateFixture()));
    expect(order).toEqual(["readiness", "lastBackup", "price"]);
    // Wide: three columns in one row. Medium: readiness spans both columns above the two cards,
    // which stay side by side. The widths are the widget area's (a container query).
    expect(columns).toContain(
      "@[68rem]/widgets:grid-cols-[minmax(0,1.8fr)_minmax(0,1.25fr)_minmax(0,0.85fr)]",
    );
    expect(columns).toContain("@[42rem]/widgets:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]");
    expect(columns).not.toContain("lg:grid-cols-2");
    expect(cells).toHaveLength(3);
    expect(cells[0]).toContain("@[42rem]/widgets:col-span-2");
    expect(cells[0]).toContain("@[68rem]/widgets:col-span-1");
    expect(cells[1]).not.toContain("col-span");
    expect(cells[2]).not.toContain("col-span");
    // Narrow: no column classes below 42rem, so the cells wrap one below the other.
    expect(columns).not.toMatch(/(^|\s)(sm|md|lg):grid-cols/);
    expect(status).toContain('data-widget="price" data-state="ready"');
    expect(plain(status)).toContain("€36.80 / month");
  });

  it("also appears for a tenant that has a price only through its own", () => {
    const { order } = row(
      true,
      seeded(
        estimateFixture({
          global: { mailboxPrice: null, storagePrice: null },
          tenants: [estimateTenant({ overridden: { mailbox: true, storage: false } })],
        }),
      ),
    );
    expect(order).toContain("price");
  });

  it("is exactly the two cells it was without a price", () => {
    const { columns, cells, order } = row(true, seeded(noPriceEstimate()));
    expect(order).toEqual(["readiness", "lastBackup"]);
    expect(columns).toContain("lg:grid-cols-2");
    expect(cells).toHaveLength(2);
    expect(cells.join(" ")).not.toContain("col-span");
  });

  it("is unchanged while the estimate is not there yet, and for anybody but a provider admin", () => {
    expect(row(true, newQueryClient()).order).toEqual(["readiness", "lastBackup"]);
    const member = row(
      false,
      seeded(estimateFixture()),
      sessionAs({ isProviderAdmin: false, activeTenant: TENANT }),
    );
    expect(member.order).toEqual(["readiness", "lastBackup"]);
    expect(member.columns).toContain("lg:grid-cols-2");
  });

  it("shows the card in its error state when the estimate could not be read", async () => {
    // A failed query is tried again when it mounts; the server render must not.
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, retryOnMount: false, gcTime: Number.POSITIVE_INFINITY },
      },
    });
    await client
      .fetchQuery({ queryKey: estimateKey(ACME), queryFn: () => Promise.reject(new Error("boom")) })
      .catch(() => undefined);
    const { order, status } = row(true, client);
    expect(order).toEqual(["readiness", "lastBackup", "price"]);
    expect(status).toContain('data-widget="price" data-state="error"');
    expect(status).toContain("Retry");
  });
});

describe("the price card", () => {
  const card = (view: Parameters<typeof PriceWidget>[0]["view"]) =>
    render(
      <PriceWidget
        view={view}
        onRetry={() => {}}
        retrying={false}
        tenantId={ACME}
        tenantName="Acme"
      />,
    );

  it("shows a skeleton while loading", () => {
    const html = card({ kind: "loading" });
    expect(html).toContain('data-widget="price" data-state="loading"');
    expect(html).toContain('aria-busy="true"');
  });

  it("shows the total, the lines and the way to the prices", () => {
    const html = card({ kind: "ready", data: estimateFixture() });
    expect(plain(html)).toContain("€36.80 / month");
    expect(html).toContain("12 mailboxes × €2.50 = €30.00");
    expect(html).toContain("340 GB × €0.02 = €6.80");
    expect(html).toContain("Adjust prices");
    expect(html).toContain('href="/installation/pricing"');
    expect(html).not.toContain("Custom price");
    // The owner, where tenants may have prices of their own, can edit this tenant's.
    expect(html).toContain("Prices for this tenant");
  });

  it("marks a custom price, and offers no editing to anybody but the owner", () => {
    const data = estimateFixture({
      tenants: [estimateTenant({ overridden: { mailbox: true, storage: false } })],
    });
    expect(card({ kind: "ready", data })).toContain("Custom price");
    const html = render(
      <PriceWidget
        view={{ kind: "ready", data }}
        onRetry={() => {}}
        retrying={false}
        tenantId={ACME}
        tenantName="Acme"
      />,
      { session: sessionAs({ providerRole: "administrator", activeTenant: TENANT }) },
    );
    expect(html).not.toContain("Prices for this tenant");
  });

  it("says the figures are not available yet instead of leaving the row", () => {
    const html = card({
      kind: "ready",
      data: estimateFixture({
        tenants: [
          estimateTenant({
            mailboxes: null,
            storedBytes: null,
            amount: { mailboxes: null, storage: null, total: null },
          }),
        ],
        total: null,
        missing: 1,
      }),
    });
    expect(html).toContain("Figures not available yet");
    expect(html).not.toContain("/ month");
  });

  it("shows the widget error state with a retry", () => {
    const html = card({ kind: "error", error: new Error("boom") });
    expect(html).toContain('data-widget="price" data-state="error"');
    expect(html).toContain("Retry");
  });
});
