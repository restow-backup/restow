import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import { type SessionContextValue, type SessionTenant, StaticSessionProvider } from "@/lib/session";

import type { Capacity } from "./api.js";
import { ALPHA, ALPHA_DETAIL, BETA, CAPACITY } from "./fixtures.js";
import { ResourcesPage } from "./resources-page.js";

/**
 * Capacity planning in a real DOM: the installation's figures on top, a table that opens
 * with the repository that runs full soonest and sorts by its column headers, the filter near
 * quota or full, a row that opens in place and loads the tenant's repositories only then, the
 * empty states that say why a cell has no day, and an estimate that is never green.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OWN: SessionTenant = {
  id: "alpha",
  name: "Alpha AG",
  slug: "alpha",
  kind: "customer",
  customerNumber: null,
  role: "tenant_admin",
  status: "active",
};

let answer: Capacity = CAPACITY;
let failing = false;
const requests: string[] = [];

function session(role: "provider_admin" | "tenant_admin" = "provider_admin"): SessionContextValue {
  return {
    status: "authenticated",
    user: { id: "u1", name: "Alex", email: "alex@example.test" },
    role,
    features: ["dashboard.allTenants"],
    extensions: {},
    isProviderAdmin: role === "provider_admin",
    tenants: [OWN],
    activeTenant: OWN,
    setActiveTenant: vi.fn(),
    scope: "all",
    canViewAllTenants: true,
    setScopeAll: vi.fn(),
    version: null,
    signOut: async () => {},
    refresh: async () => {},
    error: null,
  } as SessionContextValue;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  answer = CAPACITY;
  failing = false;
  requests.length = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (failing) {
      return new Response(JSON.stringify({ title: "Boom", status: 500 }), {
        status: 500,
        headers: { "content-type": "application/problem+json" },
      });
    }
    const body = url.endsWith("/capacity") ? answer : { ...ALPHA_DETAIL, tenantId: "alpha" };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

async function render(value: SessionContextValue = session()) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <StaticSessionProvider value={value}>
            <ResourcesPage />
          </StaticSessionProvider>
        </QueryClientProvider>
      </I18nextProvider>,
    );
    await tick();
  });
  await act(async () => {
    await tick();
  });
}

const rows = () => [...document.querySelectorAll<HTMLElement>("tr[data-tenant]")];
const order = () => rows().map((row) => row.getAttribute("data-tenant"));
const rowOf = (id: string) => document.querySelector<HTMLElement>(`tr[data-tenant="${id}"]`);
const cell = (id: string, slot: string) =>
  rowOf(id)?.querySelector<HTMLElement>(`[data-slot="resources-${slot}"]`);
const text = (element: Element | null | undefined) =>
  element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const header = (key: string) =>
  document.querySelector<HTMLButtonElement>(`[data-slot="resources-sort"][data-sort="${key}"]`);

async function click(element: Element | null | undefined) {
  await act(async () => {
    (element as HTMLElement | null)?.click();
    await tick();
  });
}

describe("the key figures", () => {
  it("shows what is stored, the growth, the system disk, the first day and the tenants near quota", async () => {
    await render();
    const kpis = text(document.querySelector('[data-slot="resources-kpis"]'));
    expect(kpis).toContain("Stored in total");
    expect(kpis).toContain("150 GB");
    expect(kpis).toContain("Over 7 tenants");
    expect(kpis).toContain("Growth per day");
    expect(kpis).toContain("3.45 GB per day");
    expect(kpis).toContain("4 of 7 tenants have one");
    expect(kpis).toContain("System disk");
    expect(kpis).toContain("74.5 GB free");
    expect(kpis).toContain("Shrinks by 1.86 GB per day.");
    expect(kpis).toContain("Full around December 9, 2026 (estimate).");
    expect(kpis).toContain("Runs full first");
    expect(kpis).toContain("In about 40 days");
    expect(kpis).toContain("Alpha AG, around December 9, 2026 (estimate).");
    expect(kpis).toContain("Tenants near their quota");
    expect(kpis).toContain("1 tenant runs full within 90 days at the estimate.");
  });

  it("says so when there is no growth, no day and no system disk", async () => {
    answer = {
      ...CAPACITY,
      kpis: {
        ...CAPACITY.kpis,
        growthBytesPerDay: null,
        growthTenants: 0,
        systemDisk: null,
        earliestFull: null,
        tenantsNearQuota: 0,
        tenantsNearFull: 0,
      },
    };
    await render();
    const kpis = text(document.querySelector('[data-slot="resources-kpis"]'));
    expect(kpis).toContain("Not enough history yet");
    expect(kpis).toContain("Not measured");
    expect(kpis).toContain("No date");
    expect(kpis).toContain("No tenant runs full within 90 days at the estimate.");
  });
});

describe("the table", () => {
  it("opens with the repository that runs full soonest, the rows without a day after it", async () => {
    await render();
    expect(order()).toEqual(["alpha", "beta", "broken", "delta", "epsilon", "gamma", "zeta"]);
    expect(header("full")?.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    expect(header("growth")?.closest("th")?.getAttribute("aria-sort")).toBe("none");
    // The requests: the overview only, no tenant's repositories.
    expect(requests.filter((url) => url.endsWith("/capacity"))).toHaveLength(1);
    expect(requests.some((url) => /\/capacity\/./.test(url))).toBe(false);
  });

  it("says what a tenant stores, how it grows and what is left", async () => {
    await render();
    expect(text(cell("alpha", "stored"))).toContain("93.1 GB");
    expect(text(cell("alpha", "stored"))).toContain("55.9 GB + 37.3 GB");
    expect(text(cell("alpha", "growth"))).toContain("1.4 GB per day");
    expect(text(cell("alpha", "growth"))).toContain("over 30 days");
    expect(text(cell("alpha", "free"))).toContain("74.5 GB of 186 GB");
    expect(text(cell("zeta", "growth"))).toContain("over 7 days");
    expect(text(cell("delta", "growth"))).toContain("Not enough history");
    expect(text(cell("delta", "free"))).toBe("Not shown");
  });

  it("words a day as an estimate, with the band from three months of history on", async () => {
    await render();
    const alpha = cell("alpha", "full");
    expect(text(alpha)).toContain("In about 40 days");
    expect(text(alpha)).toContain("Around December 9, 2026");
    expect(alpha?.querySelector("[data-full-state]")?.getAttribute("data-full-state")).toBe("date");
    const beta = cell("beta", "full");
    expect(text(beta)).toContain("In about 8 months");
    expect(text(beta)).toContain("Between July 10, 2027 and January 1, 2030");
    // The column says estimate once, for all.
    expect(text(document.querySelector("thead"))).toContain("Full (estimate)");
  });

  it("warns for a day within three months and never wears green", async () => {
    await render();
    // A warning for Alpha (40 days), plain text for Beta (253 days).
    expect(
      cell("alpha", "full")?.querySelector('[data-slot="status-badge"], [data-tone]'),
    ).not.toBeNull();
    expect(
      cell("beta", "full")?.querySelector('[data-slot="status-badge"], [data-tone]'),
    ).toBeNull();
    const html = document.querySelector('[data-slot="resources-table"]')?.innerHTML ?? "";
    expect(html).not.toMatch(/success/);
  });

  it("says why a cell has no day: S3, the shared default, no history, other data, no figures", async () => {
    await render();
    const state = (id: string) =>
      cell(id, "full")?.querySelector("[data-full-state]")?.getAttribute("data-full-state");
    expect(state("gamma")).toBe("s3");
    expect(text(cell("gamma", "full"))).toBe("S3: no limit known");
    expect(state("delta")).toBe("shared_default");
    expect(text(cell("delta", "full"))).toBe("Shared default repository");
    expect(state("epsilon")).toBe("no_history");
    expect(text(cell("epsilon", "full"))).toBe("Not enough history");
    expect(state("zeta")).toBe("other_data");
    expect(text(cell("zeta", "full"))).toContain("No date yet");
    expect(state("broken")).toBe("unavailable");
    expect(text(cell("broken", "stored"))).toBe("Figures not available");
  });

  it("shows the quota level in words, not in colour alone", async () => {
    await render();
    expect(text(cell("alpha", "quota"))).toContain("Machines");
    expect(text(cell("alpha", "quota"))).toContain("Near the budget");
    expect(text(cell("alpha", "quota"))).toContain("90 % of 41 GB");
    expect(text(cell("beta", "quota"))).toBe("No quota");
  });
});

describe("sorting", () => {
  it("sorts by growth, the fastest first, and again the other way", async () => {
    await render();
    await click(header("growth"));
    expect(order().slice(0, 4)).toEqual(["alpha", "beta", "zeta", "gamma"]);
    expect(header("growth")?.closest("th")?.getAttribute("aria-sort")).toBe("descending");
    expect(header("full")?.closest("th")?.getAttribute("aria-sort")).toBe("none");
    await click(header("growth"));
    expect(order().slice(0, 2)).toEqual(["gamma", "beta"]);
    expect(header("growth")?.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
  });

  it("sorts by what is stored and by name", async () => {
    await render();
    await click(header("stored"));
    expect(order().slice(0, 3)).toEqual(["alpha", "beta", "zeta"]);
    await click(header("name"));
    expect(order()[0]).toBe("alpha");
    await click(header("name"));
    expect(order()[0]).toBe("zeta");
  });
});

describe("the filter", () => {
  async function chooseFilter(label: string) {
    await click(document.querySelector('[data-slot="resources-filter"]'));
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((element) =>
      element.textContent?.includes(label),
    );
    await click(option);
  }

  it("narrows the table to the tenants near their quota or heading for their limit", async () => {
    await render();
    await chooseFilter("Near quota or full");
    expect(order()).toEqual(["alpha"]);
    expect(text(document.querySelector("output"))).toBe("1 of 7 tenants");
    await chooseFilter("All tenants");
    expect(order()).toHaveLength(7);
  });

  it("explains an empty result", async () => {
    answer = { ...CAPACITY, tenants: [BETA] };
    await render();
    await chooseFilter("Near quota or full");
    expect(order()).toEqual([]);
    expect(text(document.querySelector('[data-slot="empty-state"]'))).toContain(
      "No tenant is near its quota or heading for its limit",
    );
  });
});

describe("a row", () => {
  it("opens in place, loading that tenant's repositories only then, and closes again", async () => {
    await render();
    const toggle = rowOf("alpha")?.querySelector<HTMLButtonElement>(
      '[data-slot="resources-toggle"]',
    );
    const panel = document.querySelector<HTMLElement>(
      `#${CSS.escape(toggle?.getAttribute("aria-controls") ?? "none")}`,
    );
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(panel?.hidden).toBe(true);

    await click(toggle);
    await act(async () => {
      await tick();
    });
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(panel?.hidden).toBe(false);
    expect(requests.filter((url) => url.endsWith("/capacity/alpha"))).toHaveLength(1);

    const body = text(panel);
    // The growth over three horizons, what it is read from, the estimate and the limit.
    expect(text(panel?.querySelector('[data-horizon="7"]'))).toBe("1.86 GB per day");
    expect(text(panel?.querySelector('[data-horizon="30"]'))).toBe("1.4 GB per day");
    expect(text(panel?.querySelector('[data-horizon="90"]'))).toBe("Not enough history");
    expect(body).toContain("From the daily measurements of the last 30 days");
    expect(text(panel?.querySelector('[data-slot="resources-forecast"]'))).toBe(
      "A straight line through the last 30 days: 1.86 GB per day.",
    );
    expect(body).toContain("74.5 GB free on the repository's filesystem, 186 GB in total.");
    // The repositories.
    expect(text(panel?.querySelector('[data-slot="resources-targets"]'))).toContain("Primary");
    expect(text(panel?.querySelector('[data-slot="resources-targets"]'))).toContain(
      "Fails its check",
    );
    const web01 = panel?.querySelector('[data-repository="m1"]');
    expect(text(web01)).toContain("web01");
    expect(text(web01)).toContain("Near the budget");
    expect(text(web01)).toContain("Budget 41 GB");
    expect(text(web01)).toContain("954 MB per day (over 7 days)");
    expect(text(panel?.querySelector('[data-repository="m2"]'))).toContain("Not measured yet");
    expect(text(panel?.querySelector('[data-repository="m2"]'))).toContain(
      "Growth appears after a week of daily measurements.",
    );
    expect(body).toContain("3 more repositories are not listed.");

    await click(toggle);
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(panel?.hidden).toBe(true);
  });

  it("says in an opened row why a tenant has no limit to read", async () => {
    await render();
    for (const [id, limit] of [
      ["gamma", "s3"],
      ["delta", "shared_default"],
    ] as const) {
      await click(rowOf(id)?.querySelector('[data-slot="resources-toggle"]'));
      expect(
        rowOf(id)?.nextElementSibling?.querySelector(`[data-limit="${limit}"]`),
      ).not.toBeNull();
    }
    expect(text(rowOf("delta")?.nextElementSibling)).toContain("which other tenants use as well");
  });
});

describe("the page", () => {
  it("shows the one tenant of an installation without the all-tenants view, and says so", async () => {
    answer = { ...CAPACITY, scope: "tenant", tenants: [ALPHA] };
    await render();
    expect(order()).toEqual(["alpha"]);
    expect(text(document.querySelector('[data-slot="resources-scope"]'))).toContain(
      "comes with Service Provider",
    );
  });

  it("explains an installation without tenants", async () => {
    answer = { ...CAPACITY, tenants: [] };
    await render();
    expect(text(document.querySelector('[data-slot="empty-state"]'))).toContain("No tenants yet");
  });

  it("offers a retry when the figures cannot be loaded, and asks nothing of a tenant admin", async () => {
    failing = true;
    await render();
    expect(document.body.textContent).toContain("The capacity figures could not be loaded.");
    // No tile: zeros and "no date" would read as measurements during an outage.
    expect(document.querySelector('[data-slot="resources-kpis"]')).toBeNull();
    expect(document.body.textContent).not.toContain("0 B");
    expect(document.body.textContent).not.toContain("No date");
    act(() => root?.unmount());
    host?.remove();
    requests.length = 0;
    await render(session("tenant_admin"));
    expect(requests).toEqual([]);
    expect(document.querySelector('[data-slot="resources-page"]')).toBeNull();
  });

  it("reads in German too", async () => {
    await i18n.changeLanguage("de");
    try {
      await render();
      expect(text(document.querySelector('[data-slot="resources-kpis"]'))).toContain(
        "Insgesamt gespeichert",
      );
      expect(text(cell("alpha", "full"))).toContain("In etwa 40 Tagen");
      expect(text(cell("gamma", "full"))).toBe("S3: keine Grenze bekannt");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
