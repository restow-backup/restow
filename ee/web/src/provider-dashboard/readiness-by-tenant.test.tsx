import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { LoadedTenantRow, ProviderView, UnavailableTenantRow } from "@/features/dashboard/api";
import { WidgetUnavailableError } from "@/features/dashboard/presenters";
import { i18n } from "@/i18n";

import {
  ReadinessByTenant,
  countInState,
  ratedObjects,
  tenantsInState,
} from "./readiness-by-tenant.js";

/**
 * Recovery readiness under "All tenants": the tenants that have objects in a
 * state, built from the provider view. No list of objects across tenants.
 */

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
      <a href={to}>{children}</a>
    ),
  };
});

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function row(name: string, over: Partial<LoadedTenantRow> = {}): LoadedTenantRow {
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
    lastBackupAt: null,
    mailboxes: 5,
    mailboxCap: null,
    physicalBytes: 1,
    storageError: false,
    staleAfterHours: 48,
    machines: 0,
    machinesWithoutJob: 0,
    machinesFailed: 0,
    ...over,
  };
}

const unread = (name: string): UnavailableTenantRow => ({
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
  mailboxes: 3,
  mailboxCap: null,
  physicalBytes: null,
  storageError: null,
  staleAfterHours: null,
  machines: null,
  machinesWithoutJob: null,
  machinesFailed: null,
});

const TENANTS = [
  row("Contoso", { ready: 8, notRestorable: 1, unverified: 1 }),
  row("Fabrikam", { ready: 5, notRestorable: 3 }),
  { ...row("Our company", { ready: 2, notRestorable: 1 }), kind: "internal" as const },
  row("Northwind"),
  unread("Tailspin"),
];

const DATA: ProviderView = {
  kpis: {
    tenants: 4,
    suspendedTenants: 0,
    unavailableTenants: 1,
    tenantsNotReady: 2,
    readiness: { total: 31, green: 25, yellow: 0, red: 5, unverified: 1, noBackup: 0 },
    protectedObjects: 31,
    unverifiedObjects: 1,
    failures24h: 0,
    failuresPrevious24h: 0,
    mailboxes: 20,
    physicalBytes: 4,
  },
  tenants: TENANTS,
  alerts: [],
};

const handlers = { onRetry: () => {}, retrying: false, onStateChange: () => {} };
const slot = (
  state?: "red" | "green",
  over: Partial<Parameters<typeof ReadinessByTenant>[0]> = {},
) =>
  render(
    <ReadinessByTenant
      view={{ kind: "ready", data: DATA }}
      state={state}
      onOpenReadiness={() => {}}
      {...handlers}
      {...over}
    />,
  );

describe("which tenants are listed for a state", () => {
  it("counts a tenant's objects per state", () => {
    const tenant = row("T", {
      ready: 4,
      needsAttention: 2,
      notRestorable: 1,
      unverified: 3,
      noBackup: 5,
    });
    expect(
      ["green", "yellow", "red", "unverified", "no_backup"].map((state) =>
        countInState(tenant, state as never),
      ),
    ).toEqual([4, 2, 1, 3, 5]);
    expect(ratedObjects(tenant)).toBe(15);
  });

  it("lists the tenants that have objects in the state, the most first, the own organisation on top", () => {
    expect(tenantsInState(TENANTS, "red").map((tenant) => tenant.name)).toEqual([
      "Our company",
      "Fabrikam",
      "Contoso",
    ]);
  });

  it("lists every tenant that has objects when no state is chosen, and never an unread one", () => {
    const names = tenantsInState(TENANTS, undefined).map((tenant) => tenant.name);
    expect(names).toEqual(["Our company", "Contoso", "Fabrikam", "Northwind"]);
    expect(tenantsInState([row("Empty", { ready: 0 })], undefined)).toEqual([]);
  });
});

describe("the page", () => {
  it("counts every state on its chip from the sums of the provider view", () => {
    const html = slot();
    const figure = (state: string) =>
      new RegExp(`data-state="${state}"[^>]*>.*?font-mono[^>]*>([^<]*)<`, "s").exec(html)?.[1];
    expect(figure("all")).toBe("31");
    expect(figure("green")).toBe("25");
    expect(figure("red")).toBe("5");
    expect(figure("unverified")).toBe("1");
    expect(figure("no_backup")).toBe("0");
  });

  it("filters the table to the state and presses its chip", () => {
    const html = slot("red");
    expect(html).toMatch(/aria-pressed="true"[^>]*data-state="red"/);
    expect(html).toContain("Fabrikam");
    expect(html).toContain("Contoso");
    expect(html).not.toContain("Northwind");
    expect(html).not.toContain("Tailspin");
    // The own organisation is a row like the others, marked.
    expect(html).toContain('data-flag="internal"');
  });

  it("shows a count only as a link where there is one, and says how to get into a tenant", () => {
    const html = slot("red");
    const fabrikam = html.slice(
      html.indexOf("Fabrikam"),
      html.indexOf("</tr>", html.indexOf("Fabrikam")),
    );
    expect(fabrikam).toContain('data-count="red"');
    // Fabrikam has nothing unverified: the 0 is text.
    expect(fabrikam).not.toContain('data-count="unverified"');
    expect(html).toContain("Switch to Fabrikam and show: Not restorable");
    expect(html).toContain("A click on a row, a name or a count switches into that tenant");
  });

  it("says how many tenants could not be read and are missing", () => {
    expect(slot()).toContain('data-flag="incomplete"');
    expect(slot()).toContain("1 tenant could not be read and is missing here.");
    const complete = render(
      <ReadinessByTenant
        view={{
          kind: "ready",
          data: {
            ...DATA,
            kpis: { ...DATA.kpis, unavailableTenants: 0 },
            tenants: TENANTS.slice(0, 4),
          },
        }}
        state={undefined}
        onOpenReadiness={() => {}}
        {...handlers}
      />,
    );
    expect(complete).not.toContain('data-flag="incomplete"');
  });

  it("says so when no tenant has objects in the state", () => {
    const html = slot("green", {
      view: {
        kind: "ready",
        data: { ...DATA, tenants: [row("Contoso", { ready: 0, notRestorable: 2 })] },
      },
    });
    expect(html).toContain("No tenant has objects in this state");
  });

  it("has loading and error states", () => {
    expect(slot(undefined, { view: { kind: "loading" } })).toContain('data-state="loading"');
    const failed = slot(undefined, {
      view: { kind: "error", error: new WidgetUnavailableError() },
    });
    expect(failed).toContain('data-state="error"');
    expect(failed).toContain("The tenants could not be loaded");
  });
});
