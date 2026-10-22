// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import type { EndpointDetail, EndpointSummary, RunSummary } from "./api";
import { EndpointsTable, MACHINE_COLUMN_SIZES } from "./components/endpoints-table";
import { MACHINE_ACTION_CLASS, MachineActionButton } from "./components/machine-cells";
import { MachineSheet } from "./components/machine-sheet";

/**
 * Inventory must not jump (0.4.5, like VMs & containers in 0.4.3): the machines table keeps
 * every column at its size (fixed layout) and every row at one height, skeleton rows included;
 * the State cell holds one badge and no error text; the action button has the same size in
 * every state of the machine. The full error lives in the detail panel, in a copyable block.
 */

const session = { status: "authenticated", activeTenant: { id: "t-1" }, role: "tenant_admin" };
vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  useSession: () => session,
}));
vi.mock("@/features/tenant-page/access", () => ({ useTenantWriteBlock: () => null }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => undefined,
  Link: ({ children, to, search: _search, ...props }: Record<string, unknown>) => (
    <a href={String(to)} {...(props as object)}>
      {children as React.ReactNode}
    </a>
  ),
}));

const ERROR =
  "restic backup failed: exit status 1: Fatal: unable to open repository at s3:https://storage.example/restow: Access Denied";
const fetchEndpoint = vi.fn();
const fetchRun = vi.fn();
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    fetchEndpoint: (...args: unknown[]) => fetchEndpoint(...args),
    fetchRun: (...args: unknown[]) => fetchRun(...args),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function run(over: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "r-1",
    kind: "backup",
    status: "succeeded",
    startedAt: "2026-10-20T01:00:00.000Z",
    finishedAt: "2026-10-20T01:05:00.000Z",
    snapshotId: "s-1",
    errorCount: 0,
    interruptedOnly: false,
    checkIncomplete: false,
    failure: null,
    filesNew: 1,
    dataAdded: 1,
    totalBytesProcessed: 1,
    progress: null,
    ...over,
  };
}

function machine(n: number, over: Partial<EndpointSummary> = {}): EndpointSummary {
  return {
    id: `00000000-0000-4000-8000-00000000000${n}`,
    hostname: `host-${n}`,
    displayName: null,
    os: "linux",
    arch: "amd64",
    profile: "server",
    agentVersion: "0.4.4",
    osVersion: "Debian 12",
    status: "active",
    connection: "online",
    agentState: "idle",
    lastSeenAt: "2026-10-20T01:00:00.000Z",
    lastBackupAt: "2026-10-20T01:05:00.000Z",
    lastSuccessAt: "2026-10-20T01:05:00.000Z",
    nextRunAt: null,
    readiness: {
      state: "green",
      checkedAt: "2026-10-20T02:00:00.000Z",
      overdue: false,
      basis: "restore_test",
      latestSnapshotId: "s-1",
    },
    latestRun: run(),
    attention: [],
    job: { id: "job-1", name: "Servers nightly" },
    assignedTo: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    revokedAt: null,
    ...over,
  };
}

describe("an inventory that does not jump", () => {
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

  it("gives the action button the same size whatever the machine does", async () => {
    const variants = [
      { stoppable: null },
      { stoppable: { activity: "running" as const, cancelling: false, by: null } },
      { stoppable: { activity: "queued" as const, cancelling: false, by: null } },
      { stoppable: { activity: "running" as const, cancelling: true, by: "anna" } },
    ];
    const seen = new Set<string>();
    for (const variant of variants) {
      await mount(
        <MachineActionButton machine={machine(1)} stoppable={variant.stoppable} allowed />,
      );
      const buttons = container.querySelectorAll('[data-slot="machine-action"]');
      expect(buttons).toHaveLength(1);
      const classes = (buttons[0] as HTMLElement).className.split(/\s+/);
      for (const token of MACHINE_ACTION_CLASS.split(" ")) {
        expect(classes, JSON.stringify(variant)).toContain(token);
      }
      seen.add((buttons[0] as HTMLElement).textContent ?? "");
      await act(async () => root.unmount());
      container.remove();
    }
    // Back up now, Stop backup, Withdraw backup, Cancelling…: four labels, one size.
    expect(seen.size).toBe(4);
    await mount(<span />);
  });

  function table(items: EndpointSummary[] | undefined, loading = false) {
    return (
      <EndpointsTable
        area="servers"
        items={items}
        loading={loading}
        fetching={false}
        error={null}
        onRetry={() => undefined}
        empty={null}
        onOpen={() => undefined}
      />
    );
  }

  it("lays the table out fixed: every column its size, every row one height", async () => {
    await mount(
      table([
        machine(1),
        machine(2, {
          latestRun: run({ status: "failed", failure: null }),
          attention: ["last_backup_failed", "silent", "backup_overdue"],
        }),
        machine(3, {
          latestRun: run({
            status: "running",
            finishedAt: null,
            progress: { filesDone: 1, bytesDone: 1, totalBytes: 4, updatedAt: "x" },
          }),
        }),
        machine(4, { job: null, attention: ["no_job"] }),
      ]),
    );
    const tableElement = container.querySelector("table") as HTMLTableElement;
    expect(tableElement.className).toContain("table-fixed");
    const widths = [...container.querySelectorAll("thead th")].map(
      (th) =>
        (th as HTMLElement).style.width || (th as HTMLElement).style.getPropertyValue("--pin-w"),
    );
    const { profile: _p, agentVersion: _a, ...servers } = MACHINE_COLUMN_SIZES;
    expect(widths).toEqual(Object.values(servers).map((size) => `${size}px`));
    const bodyRows = [...container.querySelectorAll("tbody tr")];
    expect(bodyRows).toHaveLength(4);
    for (const row of bodyRows) {
      expect(row.className).toContain("h-12");
      // One state badge per row, no multi-line error text, no tooltips in the table.
      expect(row.querySelectorAll('[data-slot="machine-status"]')).toHaveLength(1);
      expect(row.querySelectorAll('[data-slot="machine-action"]')).toHaveLength(1);
      expect(row.querySelector("[title]")).toBeNull();
    }
    expect(container.innerHTML).not.toContain("Fatal:");
    // The other problems of host-2 are a "+2" beside its badge.
    expect(container.querySelector('[data-slot="machine-more-states"]')?.textContent).toContain(
      "+2",
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

  it("shows the whole error of the last backup in the detail panel, copyable", async () => {
    const failedRun = run({ status: "failed", errorCount: 1 });
    const failed = machine(2, { latestRun: failedRun, attention: ["last_backup_failed"] });
    fetchEndpoint.mockResolvedValue({
      ...failed,
      runs: [failedRun],
      tasks: [],
      problems: [],
    } as unknown as EndpointDetail);
    fetchRun.mockResolvedValue({
      ...failedRun,
      taskId: null,
      errors: [{ message: ERROR, code: "restic_exit_1" }],
      logTail: "using parent snapshot 1a2b3c\nFatal: unable to open repository",
      stats: null,
    });
    await mount(
      <MachineSheet machineId={failed.id} machine={failed} onClose={() => undefined} allowed />,
    );
    // The detail, then the run's errors arrive.
    for (let i = 0; i < 20 && !document.body.querySelector('[data-slot="machine-error"]'); i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    const block = document.body.querySelector('[data-slot="machine-error"]');
    expect(block?.querySelector("pre")?.textContent).toBe(ERROR);
    expect(block?.querySelector('button[aria-label="Copy error"]')).not.toBeNull();
    expect(document.body.querySelector('[data-slot="machine-log"] pre')?.textContent).toContain(
      "parent snapshot",
    );
    const states = [
      ...document.body.querySelectorAll('[data-slot="machine-states"] [data-status]'),
    ].map((badge) => badge.getAttribute("data-status"));
    expect(states[0]).toBe("failed");
    expect(
      document.body.querySelector('[data-slot="machine-sheet-actions"]')?.textContent,
    ).toContain("Back up now");
  });
  it("offers the way out of a machine that is gone in the detail panel (#65)", async () => {
    const gone = machine(3, {
      connection: "offline",
      attention: ["silent", "revoke_suggested"],
    });
    fetchEndpoint.mockResolvedValue({
      ...gone,
      runs: [],
      tasks: [],
      problems: [],
      settings: { revokeHintAfterDays: 45 },
    } as unknown as EndpointDetail);
    await mount(
      <MachineSheet machineId={gone.id} machine={gone} onClose={() => undefined} allowed />,
    );
    for (let i = 0; i < 20 && !document.body.querySelector('[data-slot="revoke-suggested"]'); i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    const states = [
      ...document.body.querySelectorAll('[data-slot="machine-states"] [data-status]'),
    ].map((badge) => badge.getAttribute("data-status"));
    expect(states).toContain("revoke_suggested");
    const removal = document.body.querySelector('[data-slot="machine-sheet-removal"]');
    expect(removal?.textContent).toContain("more than 45 days");
    expect(removal?.querySelector('[data-action="revoke-now"]')).not.toBeNull();
    expect(removal?.querySelector('[data-action="remove-machine"]')).toBeNull();
  });

  it("offers removal once the machine is revoked, and nothing to who may not", async () => {
    const revoked = machine(4, { status: "revoked", revokedAt: "2026-10-21T00:00:00.000Z" });
    fetchEndpoint.mockResolvedValue({
      ...revoked,
      runs: [],
      tasks: [],
      problems: [],
      settings: {},
    } as unknown as EndpointDetail);
    await mount(
      <MachineSheet machineId={revoked.id} machine={revoked} onClose={() => undefined} allowed />,
    );
    const removal = document.body.querySelector('[data-slot="machine-sheet-removal"]');
    expect(removal?.querySelector('[data-action="remove-machine"]')).not.toBeNull();
    expect(removal?.querySelector('[data-action="revoke-now"]')).toBeNull();
    await act(async () => root.unmount());
    container.remove();
    await mount(
      <MachineSheet
        machineId={revoked.id}
        machine={revoked}
        onClose={() => undefined}
        allowed={false}
      />,
    );
    expect(document.body.querySelector('[data-slot="machine-sheet-removal"]')).toBeNull();
  });
});
