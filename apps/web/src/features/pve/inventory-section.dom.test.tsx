// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import type { PveGuest, PveNode, PveOverview } from "./api";
import { PveInventorySection, groupByNode, guestProtection } from "./inventory-section";

/**
 * Proxmox VE in the inventory: one collapsible row per node, closed at first,
 * with what runs on it and how each VM and container stands with its backups.
 */

const session = { role: "tenant_admin" as string | null };
vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { canAccess: actual.canAccess, useSession: () => session };
});
vi.mock("@/features/endpoints/hooks", () => ({
  useTenantScope: () => ({ tenantId: "t-1", enabled: true }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
      <a href={String(to)} {...props}>
        {children}
      </a>
    ),
  };
});
const fetchOverview = vi.fn();
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, fetchOverview: () => fetchOverview() };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function node(name: string, online = true): PveNode {
  return {
    id: `n-${name}`,
    name,
    helperVersion: "0.3.2",
    pveVersion: "9.2",
    fleecingStorage: "local-lvm",
    lastSeenAt: "2026-10-10T10:00:00.000Z",
    online,
    problems: [],
    pluginLoaded: true,
    restoresAllowed: true,
  };
}

function guest(vmid: number, over: Partial<PveGuest> = {}): PveGuest {
  return {
    id: `g-${vmid}`,
    clusterId: "c-1",
    vmid,
    kind: "vm",
    name: `guest-${vmid}`,
    node: "pmx02",
    status: "running",
    template: false,
    privileged: false,
    present: true,
    diskBytes: 0,
    jobId: "j-1",
    jobName: "Nightly",
    lastBackupAt: "2026-10-10T03:00:00.000Z",
    lastSuccessAt: "2026-10-10T03:00:00.000Z",
    lastRunStatus: "succeeded",
    lastRunError: null,
    bitmapState: "incremental",
    attention: [],
    ...over,
  };
}

function overview(guests: PveGuest[], nodes = [node("pmx02")]): PveOverview {
  return {
    clusters: [{ id: "c-1", name: "lab", storageId: "restow", nodes }],
    guests,
    jobs: [],
    restorePool: "restow-restore",
  };
}

describe("guestProtection", () => {
  it("rates the worst state first", () => {
    expect(guestProtection(guest(100))).toBe("protected");
    expect(guestProtection(guest(101, { jobId: null }))).toBe("noJob");
    expect(guestProtection(guest(102, { lastRunStatus: "failed" }))).toBe("failed");
    expect(guestProtection(guest(103, { lastSuccessAt: null, lastRunStatus: null }))).toBe("never");
    expect(guestProtection(guest(104, { template: true }))).toBe("excluded");
    expect(guestProtection(guest(105, { present: false }))).toBe("excluded");
  });
});

describe("groupByNode", () => {
  it("groups by node name, sorts nodes and VMIDs, and keeps unknown nodes", () => {
    const groups = groupByNode(
      [node("pmx02"), node("pmx01")],
      [
        guest(200, { node: "pmx02" }),
        guest(100, { node: "pmx02" }),
        guest(300, { node: "pmx09" }),
        guest(400, { node: null }),
      ],
    );
    expect(groups.map((g) => [g.name, g.guests.map((x) => x.vmid)])).toEqual([
      ["pmx01", []],
      ["pmx02", [100, 200]],
      ["pmx09", [300]],
      ["", [400]],
    ]);
  });
});

describe("PveInventorySection", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function mount() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>
            <PveInventorySection />
          </I18nextProvider>
        </QueryClientProvider>,
      );
      for (let i = 0; i < 10; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
  }

  const slot = (name: string) => document.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  const text = () => document.body.textContent ?? "";

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    session.role = "tenant_admin";
  });

  it("shows each node closed, with counts, and its guests when opened", async () => {
    fetchOverview.mockResolvedValue(
      overview([
        guest(100, { name: "dns" }),
        guest(101, { name: "nextcloud", jobId: null, jobName: null }),
        guest(102, { name: "db", lastRunStatus: "failed", lastRunError: "fleecing full" }),
        guest(103, { name: "ct-web", kind: "ct", status: "stopped" }),
      ]),
    );
    await mount();
    await act(async () => {
      await vi.waitFor(() => expect(text()).toContain("pmx02"));
    });
    expect(text()).toContain("VMs and containers: 4");
    const counts = slot("pve-inventory-counts")?.textContent ?? "";
    expect(counts).toContain("Protected: 2");
    expect(counts).toContain("Failed: 1");
    expect(counts).toContain("No job: 1");
    expect(document.querySelectorAll('[data-slot="pve-inventory-guest"]')).toHaveLength(0);

    const trigger = slot("pve-inventory-node")?.querySelector("button");
    await act(async () => {
      trigger?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="pve-inventory-guest"]')];
    expect(rows.map((row) => row.querySelector("a")?.textContent)).toEqual([
      "dns",
      "nextcloud",
      "db",
      "ct-web",
    ]);
    expect(rows[0]?.querySelector("a")?.getAttribute("href")).toBe("/virtualization/g-100");
    expect(rows[1]?.textContent).toContain("No backup job");
    expect(rows[2]?.textContent).toContain("Last run failed");
    expect(rows[2]?.querySelector('[data-slot="pve-inventory-error"]')?.textContent).toBe(
      "fleecing full",
    );
    expect(rows[3]?.textContent).toContain("Stopped");
  });

  it("stays away for roles that may not open Proxmox VE and before a cluster is connected", async () => {
    session.role = "tenant_user";
    fetchOverview.mockResolvedValue(overview([guest(100)]));
    await mount();
    expect(slot("pve-inventory")).toBeNull();
    expect(fetchOverview).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();

    session.role = "tenant_admin";
    fetchOverview.mockResolvedValue(overview([], []));
    await mount();
    await act(async () => {
      await vi.waitFor(() => expect(fetchOverview).toHaveBeenCalled());
    });
    expect(slot("pve-inventory")).toBeNull();
  });
});
