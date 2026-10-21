// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import type { PveGuest } from "./api";
import { GUEST_ACTION_CLASS, GuestActionButton } from "./guest-cells";
import { GuestSheet } from "./guest-sheet";
import { guestRows } from "./guests-search";
import { GUEST_COLUMN_SIZES, GuestsTable } from "./guests-table";

/**
 * VMs & containers must not jump (0.4.3): the guests table keeps every column at its size
 * (fixed layout) and every row at one height, skeleton rows included; the State cell holds one
 * badge and no error text; the action button has the same size in every state of the guest.
 * The full error lives in the detail panel, in a copyable block.
 */

vi.mock("@/features/endpoints/hooks", () => ({
  useTenantScope: () => ({ tenantId: "t-1", enabled: true }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to: _to, search: _search, ...props }: Record<string, unknown>) => (
    <a {...(props as object)}>{children as React.ReactNode}</a>
  ),
}));
const fetchGuest = vi.fn(async () => ({ guest: null, cluster: null, snapshots: [], runs: [] }));
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, fetchGuest: (...args: unknown[]) => fetchGuest(...(args as [])) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const ERROR =
  'restic backup failed: exit status 10: {"message_type":"exit_error","code":10,"message":"Fatal: unable to open repository"}';

function guest(vmid: number, over: Partial<PveGuest> = {}): PveGuest {
  return {
    id: `g-${vmid}`,
    clusterId: "c-1",
    vmid,
    kind: "ct",
    name: `guest-${vmid}`,
    node: "pmx01",
    status: "running",
    template: false,
    privileged: false,
    present: true,
    diskBytes: 0,
    jobId: "j-1",
    jobName: "Nightly",
    lastBackupAt: "2026-10-20T01:00:00Z",
    lastSuccessAt: "2026-10-20T01:00:00Z",
    lastRunStatus: "succeeded",
    lastRunError: null,
    bitmapState: null,
    attention: [],
    ...over,
  } as PveGuest;
}

const noGuard = () => undefined;

describe("a guests table that does not jump", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function mount(element: React.ReactElement) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>{element}</I18nextProvider>
        </QueryClientProvider>,
      );
    });
  }

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("gives the action button the same size whatever the guest does", async () => {
    const variants: Partial<PveGuest>[] = [
      {},
      { activity: "queued" },
      { activity: "running" },
      { activity: "running", cancelling: true, cancelledBy: "anna" },
      { kind: "vm", template: true },
    ];
    const seen = new Set<string>();
    for (const over of variants) {
      await mount(<GuestActionButton guest={guest(100, over)} guard={noGuard} />);
      const buttons = container.querySelectorAll("button");
      expect(buttons).toHaveLength(1);
      const classes = (buttons[0] as HTMLButtonElement).className.split(/\s+/);
      for (const token of GUEST_ACTION_CLASS.split(" ")) {
        expect(classes, JSON.stringify(over)).toContain(token);
      }
      seen.add((buttons[0] as HTMLElement).textContent ?? "");
      await act(async () => root.unmount());
      container.remove();
    }
    // Back up now, Withdraw, Stop, Stopping…: four labels, one size.
    expect(seen.size).toBe(4);
    await mount(<span />);
  });

  function table(rows: ReturnType<typeof guestRows> | undefined, loading = false) {
    return (
      <GuestsTable
        rows={rows}
        matching={rows?.length ?? 0}
        total={rows?.length ?? 0}
        problems={0}
        search={{}}
        onSearchChange={() => undefined}
        jobs={[]}
        nodes={["pmx01"]}
        loading={loading}
        guard={noGuard}
        onOpen={() => undefined}
      />
    );
  }

  it("lays the table out fixed: every column its size, every row one height", async () => {
    const rows = guestRows(
      [
        guest(100),
        guest(101, { lastRunStatus: "failed", lastRunError: ERROR }),
        guest(102, {
          activity: "running",
          progress: {
            bytesDone: 1,
            bytesTotal: 2,
            bytesUploaded: null,
            bytesPerSecond: 3,
            at: "x",
          },
        }),
        guest(103, {
          lastRunWarnings: ["WARN: one", "WARN: two"],
          lastVerify: { state: "red", checkedAt: null, errors: ["bad"], requested: false },
        }),
      ],
      () => null,
    );
    await mount(table(rows));
    const tableElement = container.querySelector("table") as HTMLTableElement;
    expect(tableElement.className).toContain("table-fixed");
    const widths = [...container.querySelectorAll("thead th")].map(
      (th) => (th as HTMLElement).style.width,
    );
    expect(widths).toEqual(Object.values(GUEST_COLUMN_SIZES).map((size) => `${size}px`));
    const bodyRows = [...container.querySelectorAll("tbody tr")];
    expect(bodyRows).toHaveLength(4);
    for (const row of bodyRows) {
      expect(row.className).toContain("h-12");
      // One state badge per row, no multi-line error text in the table.
      expect(row.querySelectorAll('[data-slot="pve-guest-status"]')).toHaveLength(1);
    }
    expect(container.innerHTML).not.toContain("restic backup failed");
    expect(container.querySelector('[data-slot="pve-guest-error"]')).toBeNull();
    // The second problem of guest 103 is a "+1" beside its badge.
    expect(container.querySelector('[data-slot="pve-guest-more-states"]')?.textContent).toContain(
      "+1",
    );
  });

  it("keeps the skeleton rows at the height of the rows", async () => {
    await mount(table(undefined, true));
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.className).toContain("h-12");
    }
  });

  it("shows the whole error in the detail panel, copyable", async () => {
    const failed = guest(101, {
      lastRunStatus: "failed",
      lastRunError: ERROR,
      lastRunWarnings: [],
    });
    await mount(
      <GuestSheet
        guestId={failed.id}
        guest={failed}
        node={null}
        jobs={[]}
        onClose={() => undefined}
        guard={noGuard}
        onAssign={() => undefined}
      />,
    );
    const block = document.body.querySelector('[data-slot="pve-guest-error"]');
    expect(block?.querySelector("pre")?.textContent).toBe(ERROR);
    expect(block?.querySelector('button[aria-label="Copy error"]')).not.toBeNull();
    expect(document.body.querySelector('[data-slot="pve-sheet-actions"]')?.textContent).toContain(
      "Back up now",
    );
  });

  it("shows why a restore check could not run, amber and copyable, never red or green", async () => {
    const HOLDER = "repository is already locked exclusively by PID 4711 on pmx01 by root";
    const locked = guest(102, {
      lastRunStatus: "succeeded",
      lastRunWarnings: [],
      lastVerify: {
        state: "yellow",
        checkedAt: "2026-10-20T10:00:00.000Z",
        errors: [],
        requested: false,
        notChecked: { reason: "locked", detail: HOLDER, attempts: 12, gaveUp: true },
      },
    });
    await mount(
      <GuestSheet
        guestId={locked.id}
        guest={locked}
        node={null}
        jobs={[]}
        onClose={() => undefined}
        guard={noGuard}
        onAssign={() => undefined}
      />,
    );
    const block = document.body.querySelector('[data-slot="pve-guest-verify-not-checked"]');
    expect(block?.querySelector("pre")?.textContent).toBe(HOLDER);
    expect(block?.className).toContain("border-warning");
    expect(block?.querySelector('button[aria-label="Copy reason"]')).not.toBeNull();
    const states = [
      ...document.body.querySelectorAll('[data-slot="pve-guest-states"] [data-status]'),
    ].map((badge) => badge.getAttribute("data-status"));
    expect(states).toContain("verify_not_checked");
    expect(states).not.toContain("verified");
    expect(states).not.toContain("verify_failed");
  });
});
