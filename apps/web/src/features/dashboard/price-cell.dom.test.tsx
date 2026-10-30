// @vitest-environment happy-dom
import type * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { estimateFixture, estimateTenant } from "@/features/pricing/testing";
import {
  flush,
  json,
  type Mounted,
  mount,
  routedFetch,
  sessionAs,
  waitFor,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { type SessionContextValue, StaticSessionProvider } from "@/lib/session";
import type { TenantWidgets } from "./api.js";
import { DashboardWidgets } from "./widget-registry.js";

import "@/features/pricing/i18n";

/**
 * The price card across a tenant switch (0.4.8): the status row keeps its three cells while the
 * next tenant's estimate loads, with the card as a skeleton (never the previous tenant's
 * figures), instead of collapsing to two cells and growing again.
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

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const tenant = (id: string, name: string) => ({ id, name }) as SessionContextValue["activeTenant"];

const widgets: TenantWidgets = { readiness: { state: "error" }, lastBackup: { state: "error" } };

let mounted: Mounted | undefined;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});

function Harness({ active }: { active: SessionContextValue["activeTenant"] }) {
  return (
    <StaticSessionProvider value={sessionAs({ activeTenant: active })}>
      <DashboardWidgets
        widgets={widgets}
        loading={false}
        canAdminister
        isProviderAdmin
        onRetry={() => {}}
        retrying={false}
        trendDays={14}
        onTrendDaysChange={() => {}}
      />
    </StaticSessionProvider>
  );
}

const order = (root: HTMLElement | undefined) =>
  [...(root?.querySelectorAll('[data-section="status"] [data-widget]') ?? [])].map(
    (element) => `${element.getAttribute("data-widget")}:${element.getAttribute("data-state")}`,
  );

describe("the price cell on a tenant switch", () => {
  it("keeps the third cell as a skeleton until the next tenant's estimate is there", async () => {
    let release: (() => void) | undefined;
    const second = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { mock } = routedFetch({
      "GET /settings/pricing/estimate": async (request) => {
        void request;
        return json(estimateFixture());
      },
    });
    let asked = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      asked += 1;
      if (String(input).includes(B)) {
        await second;
        return json(
          estimateFixture({
            tenants: [
              estimateTenant({
                tenantId: B,
                name: "Berg",
                amount: { mailboxes: 1, storage: 1, total: 99 },
              }),
            ],
          }),
        );
      }
      return mock(input, init);
    });
    mounted = mount(<Harness active={tenant(A, "Acme")} />);
    await waitFor(() => order(mounted?.container).includes("price:ready"), { what: "first card" });
    expect(order(mounted?.container)).toEqual([
      "readiness:error",
      "lastBackup:error",
      "price:ready",
    ]);

    await mounted.render(<Harness active={tenant(B, "Berg")} />);
    await flush(3);
    // The answer of B is pending: the row keeps its cells, the card waits.
    expect(asked).toBe(2);
    expect(order(mounted.container)).toEqual([
      "readiness:error",
      "lastBackup:error",
      "price:loading",
    ]);
    expect(mounted.container.textContent).not.toContain("€36.80");

    release?.();
    await waitFor(() => order(mounted?.container).includes("price:ready"), { what: "second card" });
    expect(mounted.container.textContent).toContain("€99.00");
  });
});
