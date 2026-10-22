// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import type { BackupJob } from "./api";
import type { JobsAccess } from "./components/access-note";
import { JOB_ACTION_CLASS, JobRunButton, type JobRunControls } from "./components/job-run-controls";
import { JOB_COLUMN_SIZES, JobsTable } from "./components/jobs-table";
import type { PveListRow } from "./components/pve-rows";
import { endpointJob, iso, mailJob } from "./fixtures";

/**
 * The job lists must not jump (0.4.5, like VMs & containers in 0.4.3): the table keeps every
 * column at its size (fixed layout) and every row at one height, skeleton rows included; the
 * State cell holds one badge and no error text, no cell carries a tooltip; the action button
 * (Start now, Stop, Stopping…) has the same size whatever the job does.
 */

vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  useSession: () => ({
    status: "authenticated",
    activeTenant: { id: "t-1" },
    role: "tenant_admin",
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, search: _search, ...props }: Record<string, unknown>) => (
    <a href={String(to)} {...(props as object)}>
      {children as React.ReactNode}
    </a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const OPEN: JobsAccess = { block: null, closed: false, noteId: "note", reason: undefined };

function controls(over: Partial<JobRunControls> = {}): JobRunControls {
  return {
    start: () => undefined,
    askStop: () => undefined,
    starting: () => false,
    stopRequested: () => false,
    dialog: null,
    ...over,
  };
}

const LONG_ERROR = "Graph request failed: 503 Service Unavailable while reading Inbox/2026/Q3";

const JOBS: BackupJob[] = [
  mailJob({ id: "a", name: "All mailboxes, daily" }),
  mailJob({
    id: "b",
    name: "Executive board, hourly",
    state: "running",
    lastRun: { at: iso(-12), failed: 0, partial: 0, running: 2, queued: 3, runId: null },
  }),
  mailJob({
    id: "c",
    name: "A job with a very long name that never wraps in its row, whatever happens",
    state: "failing",
    lastRun: { at: iso(-60), failed: 4, partial: 2, running: 0, queued: 0, runId: null },
  }),
];

const PVE: PveListRow[] = [
  {
    rowType: "pve",
    id: "pve:pj-1",
    name: "Nightly VMs",
    job: {
      id: "pj-1",
      name: "Nightly VMs",
      scopeAll: false,
      schedule: { kind: "daily", timeOfDay: "22:00", timeZone: "Europe/Berlin" },
      settings: {},
      enabled: true,
      nextRunAt: iso(600),
      lastRunAt: iso(-10),
      guestCount: 5,
      round: { since: iso(-10), total: 5, done: 2, failed: 1, running: 1, queued: 2 },
    },
  },
];

describe("a job list that does not jump", () => {
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

  it("gives the action button the same size whatever the job does", async () => {
    const idle = JOBS[0] as BackupJob;
    const running = JOBS[1] as BackupJob;
    const variants: [BackupJob, JobRunControls][] = [
      [idle, controls()],
      [idle, controls({ starting: () => true })],
      [running, controls()],
      [running, controls({ stopRequested: () => true })],
    ];
    const seen = new Set<string>();
    for (const [job, variant] of variants) {
      await mount(<JobRunButton row={job} controls={variant} access={OPEN} />);
      const buttons = container.querySelectorAll('[data-slot="job-action"]');
      expect(buttons).toHaveLength(1);
      const classes = (buttons[0] as HTMLElement).className.split(/\s+/);
      for (const token of JOB_ACTION_CLASS.split(" ")) {
        expect(classes).toContain(token);
      }
      seen.add((buttons[0] as HTMLElement).getAttribute("data-action") ?? "");
      await act(async () => root.unmount());
      container.remove();
    }
    // Start now (also while it starts), Stop, Stopping…: one size.
    expect([...seen].sort()).toEqual(["start", "stop", "stopping"]);
    await mount(<span />);
  });

  function table(items: BackupJob[] | undefined, loading = false, withPve = false) {
    return (
      <JobsTable
        kind="endpoint"
        items={items}
        loading={loading}
        fetching={false}
        error={null}
        onRetry={() => undefined}
        empty={null}
        access={OPEN}
        onOpenPanel={() => undefined}
        onEdit={() => undefined}
        onPause={() => undefined}
        onResume={() => undefined}
        onDelete={() => undefined}
        controls={controls()}
        pve={
          withPve ? { rows: PVE, onEdit: () => undefined, onDelete: () => undefined } : undefined
        }
      />
    );
  }

  it("lays the table out fixed: every column its size, every row one height", async () => {
    await mount(table([...JOBS, endpointJob()], false, true));
    const tableElement = container.querySelector("table") as HTMLTableElement;
    expect(tableElement.className).toContain("table-fixed");
    const widths = [...container.querySelectorAll("thead th")].map(
      (th) =>
        (th as HTMLElement).style.width || (th as HTMLElement).style.getPropertyValue("--pin-w"),
    );
    expect(widths).toEqual(Object.values(JOB_COLUMN_SIZES).map((size) => `${size}px`));
    const bodyRows = [...container.querySelectorAll("tbody tr")];
    expect(bodyRows).toHaveLength(5);
    for (const row of bodyRows) {
      expect(row.className).toContain("h-12");
      // One state badge and one action button per row; no tooltips, no second line.
      expect(row.querySelectorAll('[data-slot="job-state"] [data-state]')).toHaveLength(1);
      expect(row.querySelectorAll('[data-slot="job-action"]')).toHaveLength(1);
      expect(row.querySelector("[title]")).toBeNull();
    }
    expect(container.innerHTML).not.toContain(LONG_ERROR);
    // The running mail job and the round of the Proxmox VE job offer Stop; the others Start now.
    const actions = bodyRows.map((row) =>
      row.querySelector('[data-slot="job-action"]')?.getAttribute("data-action"),
    );
    expect(actions.filter((action) => action === "stop")).toHaveLength(2);
  });

  it("keeps the skeleton rows at the height of the rows", async () => {
    await mount(table(undefined, true));
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.className).toContain("h-12");
    }
  });
});
