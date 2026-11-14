// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import type { PveGuest, PveJob } from "./api";
import { applySelectAll, jobGuestGroups, movingGuests, selectAllState } from "./job-guests";
import { JobDialog } from "./pve-page";

/**
 * The guests of the Proxmox VE job form: by node, with a search, "Select all" per node and for
 * every guest shown. "Select all" never ticks the Restow server's own guest, and a save puts
 * every changed guest into the job (or out of it) with one request.
 */

vi.mock("@/features/endpoints/hooks", () => ({
  useTenantScope: () => ({ tenantId: "t-1", enabled: true }),
}));
// The schedule fields have tests of their own; here they would need a signed-in session.
vi.mock("@/features/schedules/components/cadence-fields", () => ({ CadenceFields: () => null }));
vi.mock("@/features/storage", () => ({
  BackupDestinationNote: () => null,
  WriteOnceRetentionNotice: () => null,
}));
const saveJob = vi.fn(async (id: string | null) => ({ ...NIGHTLY, id: id ?? "j-new" }));
const assignJobGuests = vi.fn(async () => ({ added: 0, removed: 0 }));
const assignJob = vi.fn(async () => undefined);
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    saveJob: (...args: unknown[]) => saveJob(...(args as [string | null])),
    assignJobGuests: (...args: unknown[]) => assignJobGuests(...(args as [])),
    assignJob: (...args: unknown[]) => assignJob(...(args as [])),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const NIGHTLY: PveJob = {
  id: "j-1",
  name: "Nightly",
  scopeAll: false,
  schedule: { kind: "daily", timeOfDay: "22:00", timeZone: "Europe/Berlin" },
  settings: {},
  enabled: true,
  nextRunAt: null,
  lastRunAt: null,
};

function guest(vmid: number, over: Partial<PveGuest> = {}): PveGuest {
  return {
    id: `g-${vmid}`,
    clusterId: "c-1",
    vmid,
    kind: "vm",
    name: `guest-${vmid}`,
    node: "pve1",
    status: "running",
    template: false,
    privileged: false,
    present: true,
    diskBytes: 0,
    jobId: null,
    jobName: null,
    lastBackupAt: null,
    lastSuccessAt: null,
    lastRunStatus: null,
    lastRunError: null,
    bitmapState: null,
    attention: [],
    ...over,
  };
}

const GUESTS = [
  guest(100, { name: "dns" }),
  guest(101, { name: "web", jobId: "j-2", jobName: "Weekly" }),
  guest(102, { name: "restow", kind: "ct", restowServer: "detected" }),
  guest(103, { name: "tpl", template: true }),
  guest(200, { name: "mail", node: "pve2" }),
  guest(201, { name: "files", node: "pve2", kind: "ct", jobId: "j-2", jobName: "Weekly" }),
  guest(202, { name: "gone", node: "pve2", excludedAt: "2026-10-01T00:00:00.000Z" }),
];

describe("the job form's guest helpers", () => {
  it("groups by node and cluster, nodes by name, guests by ID, unknown nodes last", () => {
    const groups = jobGuestGroups([
      guest(300, { node: "pve2" }),
      guest(101, { node: null }),
      guest(200, { node: "pve1", clusterId: "c-2" }),
      guest(100, { node: "pve1" }),
      guest(150, { node: "pve1" }),
    ]);
    expect(groups.map((g) => [g.node, g.guests.map((x) => x.vmid)])).toEqual([
      ["pve1", [100, 150]],
      ["pve1", [200]],
      ["pve2", [300]],
      ["", [101]],
    ]);
  });

  it("select all skips the Restow server, clearing takes it out too", () => {
    const guests = [guest(1), guest(2, { restowServer: "flagged" }), guest(3)];
    const all = applySelectAll(new Set(), guests, true);
    expect([...all].sort()).toEqual(["g-1", "g-3"]);
    expect(selectAllState(guests, all)).toBe(true);
    expect(selectAllState(guests, new Set(["g-2"]))).toBe("indeterminate");
    expect(selectAllState(guests, new Set())).toBe(false);
    expect([...applySelectAll(new Set(["g-2", "g-9"]), guests, false)]).toEqual(["g-9"]);
    // Only the Restow server: nothing to tick for "Select all".
    const alone = [guest(2, { restowServer: "detected" })];
    expect([...applySelectAll(new Set(), alone, true)]).toEqual([]);
  });

  it("counts the chosen guests that move from another job", () => {
    const guests = [guest(1, { jobId: "j-2" }), guest(2, { jobId: "j-1" }), guest(3)];
    const moving = movingGuests(guests, new Set(["g-1", "g-2", "g-3"]), "j-1");
    expect(moving.map((g) => g.id)).toEqual(["g-1"]);
  });
});

describe("JobDialog guests", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function mount(job: PveJob | null, guests: PveGuest[] = GUESTS) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>
            <JobDialog job={job} guests={guests} onClose={() => undefined} />
          </I18nextProvider>
        </QueryClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  const slot = (name: string) => document.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  const nodes = () => [
    ...document.querySelectorAll<HTMLElement>('[data-slot="pve-job-guest-node"]'),
  ];
  const box = (id: string) => document.getElementById(id) as HTMLElement;
  const checked = () =>
    [...document.querySelectorAll<HTMLElement>('[id^="pve-job-guest-g-"]')]
      .filter((el) => el.getAttribute("data-state") === "checked")
      .map((el) => el.id.replace("pve-job-guest-", ""));
  const nodeBox = (index: number) =>
    nodes()[index]?.querySelector<HTMLElement>('button[role="checkbox"]');
  async function click(element: Element | null | undefined) {
    await act(async () => {
      (element as HTMLElement | null)?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  async function save() {
    await act(async () => {
      slot("pve-job-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
  }

  it("lists the guests by node and selects all on a node, never the Restow server", async () => {
    await mount(NIGHTLY);
    // The template and the excluded guest are not offered.
    expect(nodes().map((n) => n.getAttribute("data-node"))).toEqual(["pve1", "pve2"]);
    expect(nodes()[0]?.textContent).toContain("dns · VM 100");
    expect(nodes()[0]?.textContent).not.toContain("tpl");
    expect(nodes()[1]?.textContent).not.toContain("gone");
    expect(nodeBox(0)?.getAttribute("aria-label")).toBe("Select all on pve1");

    await click(nodeBox(0));
    expect(checked()).toEqual(["g-100", "g-101"]);
    expect(nodeBox(0)?.getAttribute("data-state")).toBe("checked");
    expect(nodeBox(1)?.getAttribute("data-state")).toBe("unchecked");
    expect(slot("pve-job-guests-all")?.getAttribute("data-state")).toBe("indeterminate");
    // web came from Weekly: its row says so, and the form counts what moves.
    expect(slot("pve-job-guests-moving")?.textContent).toBe(
      "1 VM or container moves from another job into this one when you save.",
    );
    expect(slot("pve-job-guests-server")?.textContent).toContain("leaves the");

    await click(slot("pve-job-guests-all"));
    expect(checked()).toEqual(["g-100", "g-101", "g-200", "g-201"]);
    expect(slot("pve-job-guests-count")?.textContent).toBe("4 of 5 selected");
    expect(slot("pve-job-guests-moving")?.textContent).toContain("2 VMs and containers move");

    // Ticked on its own, the Restow server asks for the confirmation; clearing takes it out.
    await click(box("pve-job-guest-g-102"));
    expect(slot("pve-job-self-backup")).not.toBeNull();
    await click(nodeBox(0));
    expect(checked()).toEqual(["g-200", "g-201"]);
    expect(slot("pve-job-self-backup")).toBeNull();
  });

  it("searches by name or ID and selects only the matches", async () => {
    await mount(null);
    const search = slot("pve-job-guest-search") as HTMLInputElement;
    await type(search, "20");
    expect(nodes().map((n) => n.getAttribute("data-node"))).toEqual(["pve2"]);
    expect(slot("pve-job-guests")?.textContent).toContain("Select all matches");
    await click(slot("pve-job-guests-all"));
    await type(search, "dns");
    expect(nodes().map((n) => n.getAttribute("data-node"))).toEqual(["pve1"]);
    await type(search, "");
    expect(checked()).toEqual(["g-200", "g-201"]);
    await type(search, "nothing-like-this");
    expect(slot("pve-job-guests")?.textContent).toContain("No VM or container matches the search.");
  });

  it("saves the changed guests with one request, the Restow server only when confirmed", async () => {
    const own = GUESTS.map((g) =>
      g.vmid === 200 ? { ...g, jobId: "j-1", jobName: "Nightly" } : g,
    );
    await mount(NIGHTLY, own);
    expect(checked()).toEqual(["g-200"]);
    await click(nodeBox(0));
    await click(box("pve-job-guest-g-102"));
    await click(box("pve-job-guest-g-200"));
    await save();
    // The confirmation is missing: nothing is sent.
    expect(saveJob).not.toHaveBeenCalled();
    await click(box("pve-job-self-confirmed"));
    await save();
    expect(saveJob).toHaveBeenCalledTimes(1);
    expect(assignJob).not.toHaveBeenCalled();
    expect(assignJobGuests.mock.calls).toEqual([
      ["j-1", { add: ["g-100", "g-101", "g-102"], remove: ["g-200"] }, { confirmSelfBackup: true }],
    ]);
  });
});
