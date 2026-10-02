import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import type {
  LoadedTenantRow,
  ProviderAlert,
  ProviderView as ProviderData,
  UnavailableTenantRow,
} from "@/features/dashboard/api";
import { widgetView } from "@/features/dashboard/presenters";
import { ALERTS_COLLAPSED, AlertList } from "./alert-list.js";
import { ProviderView } from "./provider-view.js";
import { TenantMatrix, readinessFacet, sortTenantRows } from "./tenant-matrix.js";

/**
 * The provider view rendered to static markup: tiles, alerts and the tenant
 * matrix in every state. Router links become plain anchors.
 */

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      search,
      className,
      children,
    }: {
      to: string;
      search?: Record<string, string>;
      className?: string;
      children: React.ReactNode;
    }) => {
      const query = new URLSearchParams(search ?? {}).toString();
      return (
        <a href={query ? `${to}?${query}` : to} className={className}>
          {children}
        </a>
      );
    },
  };
});

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function row(name: string, overrides: Partial<LoadedTenantRow> = {}): LoadedTenantRow {
  return {
    id: `id-${name.toLowerCase()}`,
    name,
    slug: name.toLowerCase(),
    status: "active",
    kind: "customer",
    loaded: true,
    readiness: "green",
    protectedObjects: 10,
    ready: 10,
    needsAttention: 0,
    notRestorable: 0,
    unverified: 0,
    noBackup: 0,
    failures24h: 0,
    failuresPrevious24h: 0,
    lastBackupAt: new Date(Date.now() - 3_600_000).toISOString(),
    mailboxes: 8,
    mailboxCap: null,
    physicalBytes: 1_000_000,
    storageError: false,
    ...overrides,
  };
}

/** A tenant whose figures could not be read, as the server sends it. */
function unread(name: string): UnavailableTenantRow {
  return {
    id: `id-${name.toLowerCase()}`,
    name,
    slug: name.toLowerCase(),
    status: "active",
    kind: "customer",
    loaded: false,
    readiness: null,
    protectedObjects: null,
    ready: null,
    needsAttention: null,
    notRestorable: null,
    unverified: null,
    noBackup: null,
    failures24h: null,
    failuresPrevious24h: null,
    lastBackupAt: null,
    mailboxes: 6,
    mailboxCap: null,
    physicalBytes: null,
    storageError: null,
  };
}

const alert = (tenantName: string, overrides: Partial<ProviderAlert> = {}): ProviderAlert => ({
  tenantId: `id-${tenantName.toLowerCase()}`,
  tenantName,
  kind: "unverified",
  severity: "warning",
  count: 2,
  since: null,
  ...overrides,
});

const VIEW: ProviderData = {
  kpis: {
    tenants: 3,
    suspendedTenants: 1,
    unavailableTenants: 1,
    tenantsNotReady: 1,
    readiness: { total: 20, green: 14, yellow: 1, red: 2, unverified: 3, noBackup: 0 },
    protectedObjects: 20,
    unverifiedObjects: 3,
    failures24h: 2,
    failuresPrevious24h: 5,
    mailboxes: 22,
    physicalBytes: 2_000_000,
  },
  tenants: [
    row("Contoso", { readiness: "red", unverified: 3, failures24h: 2, failuresPrevious24h: 5 }),
    row("Fabrikam", { status: "suspended" }),
    unread("Tailspin"),
  ],
  alerts: [
    alert("Contoso", { kind: "failed_jobs", severity: "destructive", count: 2 }),
    alert("Contoso", { count: 3 }),
    alert("Tailspin", { kind: "unavailable", count: null }),
  ],
};

const handlers = {
  onRetry: () => {},
  retrying: false,
  onOpenTenant: () => {},
  onTenantDetails: () => {},
  onOpenReadiness: () => {},
};

describe("provider view", () => {
  it("shows provider-wide figures, alerts and the tenant matrix", () => {
    const html = render(
      <ProviderView view={widgetView({ state: "ok", data: VIEW }, false)} {...handlers} />,
    );
    expect(html).toContain('data-state="ready"');
    expect(html).toContain("Tenants not ready");
    expect(html).toContain("1 suspended");
    expect(html).toContain("Protected mailboxes");
    expect(html).not.toContain("Unlimited");
    expect(html).toContain("Alerts across tenants");
    expect(html).toContain("2 jobs failed in the last 24 hours.");
    expect(html).toContain("Tenants by need for action");
    // Unverified backups are flagged in the matrix.
    expect(html).toContain('data-flag="unverified"');
    expect(html).toContain("3 unverified");
    expect(html).toContain("Suspended");
    expect(html).toContain("Not available");
    // The worst tenant comes first.
    expect(html.indexOf("Contoso")).toBeLessThan(html.indexOf("Fabrikam"));
  });

  it("has skeleton, error and empty states", () => {
    const loading = render(<ProviderView view={{ kind: "loading" }} {...handlers} />);
    expect(loading).toContain('data-state="loading"');
    expect(loading).toContain('data-slot="skeleton"');

    const failed = render(
      <ProviderView view={widgetView({ state: "error" }, false)} {...handlers} />,
    );
    expect(failed).toContain('data-state="error"');
    expect(failed).toContain("The provider view could not be loaded");
    expect(failed).toContain("Retry");

    const empty = render(
      <ProviderView
        view={widgetView({ state: "ok", data: { ...VIEW, tenants: [], alerts: [] } }, false)}
        {...handlers}
      />,
    );
    expect(empty).toContain('data-state="empty"');
    expect(empty).toContain("No tenants yet");
    expect(empty).toContain('href="/tenants"');
  });

  it("says when totals leave out tenants that could not be read", () => {
    const html = render(
      <ProviderView view={widgetView({ state: "ok", data: VIEW }, false)} {...handlers} />,
    );
    // Not ready, unverified, failures and storage are sums over the tenants read.
    expect(html.split('data-flag="incomplete"').length - 1).toBe(4);
    expect(html).toContain("Without 1 tenant whose figures could not be read.");

    const complete = render(
      <ProviderView
        view={widgetView(
          {
            state: "ok",
            data: {
              ...VIEW,
              kpis: { ...VIEW.kpis, unavailableTenants: 0 },
              tenants: VIEW.tenants.filter((tenant) => tenant.loaded),
            },
          },
          false,
        )}
        {...handlers}
      />,
    );
    expect(complete).not.toContain('data-flag="incomplete"');
  });

  it("compares failed jobs with the 24 hours before", () => {
    const html = render(
      <ProviderView view={widgetView({ state: "ok", data: VIEW }, false)} {...handlers} />,
    );
    // 2 now against 5 before: 3 fewer, which is good news, shown in the text colour, not green.
    expect(html).toContain("vs. the 24 hours before");
    expect(html).toMatch(/data-tone="positive"[^>]*class="[^"]*text-foreground[^"]*"[^>]*>.*?−3/);
    expect(html).not.toMatch(/data-tone="success"[^>]*>.*?−3/);
  });
});

describe("tenant matrix", () => {
  const cellsOf = (html: string, name: string) => {
    const start = html.indexOf(name);
    const end = html.indexOf("</tr>", start);
    return html.slice(start, end);
  };

  it("shows an unread tenant's figures as not available, never as zeros", () => {
    const html = render(
      <TenantMatrix
        rows={[row("Contoso"), unread("Tailspin")]}
        onOpenTenant={() => {}}
        onTenantDetails={() => {}}
        onOpenReadiness={() => {}}
      />,
    );
    const tailspin = cellsOf(html, "Tailspin");
    // Cannot be restored, unverified, failures, last backup and storage: all unknown.
    expect(tailspin.split('data-figure="unavailable"').length - 1).toBe(5);
    expect(tailspin).toContain("Not available");
    expect(tailspin).not.toContain("No successful backup yet");
    expect(tailspin).not.toContain(" B<");
    expect(tailspin).not.toMatch(/>0</);
    // The licence count is read separately and stays known.
    expect(tailspin).toContain(">6<");

    const contoso = cellsOf(html, "Contoso");
    expect(contoso).not.toContain('data-figure="unavailable"');
  });

  it("puts unread tenants last in the default order", () => {
    const html = render(
      <TenantMatrix
        rows={[
          unread("Alpha"),
          row("Beta", { readiness: "green" }),
          row("Gamma", { readiness: "red" }),
        ]}
        onOpenTenant={() => {}}
        onTenantDetails={() => {}}
        onOpenReadiness={() => {}}
      />,
    );
    const order = ["Gamma", "Beta", "Alpha"].map((name) => html.indexOf(`>${name}<`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("alert list", () => {
  it("says so when there is nothing to report", () => {
    const html = render(<AlertList alerts={[]} onOpenTenant={() => {}} />);
    expect(html).toContain('data-state="empty"');
    expect(html).toContain("No alerts");
  });

  it("shows the first alerts and offers the rest", () => {
    const many = Array.from({ length: ALERTS_COLLAPSED + 3 }, (_, index) =>
      alert(`Tenant ${index}`),
    );
    const html = render(<AlertList alerts={many} onOpenTenant={() => {}} />);
    expect(html.split("data-alert=").length - 1).toBe(ALERTS_COLLAPSED);
    expect(html).toContain(`Show all ${many.length}`);
  });
});

describe("readiness facet", () => {
  it("separates unread tenants and tenants without objects", () => {
    expect(readinessFacet(row("A"))).toBe("green");
    expect(readinessFacet(row("A", { readiness: null }))).toBe("none");
    expect(readinessFacet(unread("A"))).toBe("unavailable");
  });
});

describe("the overview across all tenants", () => {
  const html = () =>
    render(<ProviderView view={widgetView({ state: "ok", data: VIEW }, false)} {...handlers} />);

  it("counts the objects of every state in one readiness tile and links each row to the tenants that have them", () => {
    const page = html();
    const tile = page.slice(page.indexOf('data-widget="provider-readiness"'));
    expect(tile).toContain("Recovery readiness, all tenants");
    // 14 of 20 objects are proven restorable.
    expect(tile).toContain("70%");
    expect(tile).toContain("of 20 protected objects proven restorable");
    const row = (segment: string) => {
      const start = tile.indexOf(`data-segment="${segment}"`);
      return tile.slice(start, tile.indexOf("</li>", start));
    };
    expect(row("green")).toContain('href="/verify?state=green&amp;scope=all"');
    expect(row("yellow")).toContain('href="/verify?state=yellow&amp;scope=all"');
    expect(row("red")).toContain('href="/verify?state=red&amp;scope=all"');
    expect(row("unverified")).toContain('href="/verify?state=unverified&amp;scope=all"');
    // No object without a backup anywhere: plain text with its 0.
    expect(row("noBackup")).not.toContain("href=");
    expect(row("noBackup")).toContain(">0<");
  });

  it("shows a skeleton for the tile while the figures load", () => {
    const loading = render(<ProviderView view={{ kind: "loading" }} {...handlers} />);
    expect(loading).toContain('data-widget="provider-readiness"');
    expect(loading).toContain('aria-busy="true"');
  });

  it("calls the table what it is and says a click switches into the tenant", () => {
    const page = html();
    expect(page).toContain("Tenants by need for action");
    expect(page).toContain("Click a row to switch into that tenant.");
    expect(page).toContain('data-slot="open-tenant"');
  });
});

describe("the tenants by what needs doing", () => {
  const names = (rows: ReturnType<typeof sortTenantRows>) => rows.map((tenant) => tenant.name);

  it("puts the operator's own organisation first, with its Internal badge, then the worst", () => {
    const rows = [
      row("Beta", { readiness: "green" }),
      row("Gamma", { readiness: "red", notRestorable: 2 }),
      { ...row("Our company", { readiness: "green" }), kind: "internal" as const },
      row("Alpha", { readiness: "yellow" }),
    ];
    expect(names(sortTenantRows(rows))).toEqual(["Our company", "Gamma", "Alpha", "Beta"]);
    const page = render(
      <TenantMatrix
        rows={rows}
        onOpenTenant={() => {}}
        onTenantDetails={() => {}}
        onOpenReadiness={() => {}}
      />,
    );
    const own = page.slice(
      page.indexOf("Our company"),
      page.indexOf("</tr>", page.indexOf("Our company")),
    );
    expect(own).toContain('data-flag="internal"');
    expect(own).toContain(">Internal<");
    // Only the own organisation carries it.
    expect(page.split('data-flag="internal"').length - 1).toBe(1);
    expect(page.indexOf("Our company")).toBeLessThan(page.indexOf("Gamma"));
  });

  it("orders by objects that cannot be restored, then unverified, then failed jobs, then name", () => {
    const sorted = sortTenantRows([
      row("D", { readiness: "red", notRestorable: 1, unverified: 5 }),
      row("C", { readiness: "red", notRestorable: 3 }),
      row("B", { readiness: "red", notRestorable: 1, unverified: 5, failures24h: 2 }),
      row("A", { readiness: "red", notRestorable: 1, unverified: 5, failures24h: 2 }),
    ]);
    expect(names(sorted)).toEqual(["C", "A", "B", "D"]);
  });

  it("keeps an unread tenant after every tenant it could read, and does not move the own organisation", () => {
    const own = { ...unread("Own"), kind: "internal" as const };
    expect(names(sortTenantRows([row("Beta"), unread("Alpha"), own]))).toEqual([
      "Own",
      "Beta",
      "Alpha",
    ]);
  });

  it("links the number of objects that cannot be restored, and only a number above zero", () => {
    const page = render(
      <TenantMatrix
        rows={[row("Contoso", { readiness: "red", notRestorable: 4 }), row("Fabrikam")]}
        onOpenTenant={() => {}}
        onTenantDetails={() => {}}
        onOpenReadiness={() => {}}
      />,
    );
    expect(page.split('data-flag="not-restorable"').length - 1).toBe(1);
    expect(page).toContain("Switch to Contoso and show the objects that cannot be restored");
  });
});
