// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { LiveSnapshot, PveRunning, Run } from "@/features/history/api";
import { iso, run, samples, subject } from "@/features/history/fixtures";
import "@/features/history/i18n";
import { resetChannelsForTesting } from "@/features/history/live/channel";
import { LiveChannelProvider } from "@/features/history/live/provider";
import { adminSession } from "@/features/history/testing";
import type { EventStreamOptions, ServerEvent, StreamStatus } from "@/features/jobs/sse";
import {
  enableActEnvironment,
  flush,
  installMemoryStorage,
  type Mounted,
  mount,
  newQueryClient,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import type { RunningWidget as RunningData } from "../api.js";
import { WidgetUnavailableError, type WidgetView } from "../presenters.js";
import { RunningNowWidget } from "./running-widget.js";

/**
 * "Running now" on the tenant's start page in each of its states: nothing running (with the next
 * planned start), runs of every kind with their figures, moving with the live channel, and the
 * last known state with a word that live updates are off. The graphs are drawn for the eye; the
 * tests check the text that stands for them.
 */

enableActEnvironment();

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      search,
      children,
      ...props
    }: {
      to: string;
      search?: Record<string, string>;
      children: React.ReactNode;
    }) => {
      const query = new URLSearchParams(search ?? {}).toString();
      return (
        <a href={query ? `${to}?${query}` : to} {...props}>
          {children}
        </a>
      );
    },
  };
});

let mounted: Mounted | null = null;

beforeAll(async () => {
  installMemoryStorage();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  resetChannelsForTesting();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const NOW = Date.now();
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

function streams() {
  const opened: { options: EventStreamOptions; closed: boolean }[] = [];
  return {
    opened,
    open: (options: EventStreamOptions) => {
      const stream = { options, closed: false };
      opened.push(stream);
      return {
        close() {
          stream.closed = true;
        },
      };
    },
    status: (value: StreamStatus) =>
      act(async () => {
        opened.at(-1)?.options.onStatus?.(value);
        await Promise.resolve();
      }),
    event: async (event: ServerEvent) => {
      await act(async () => {
        opened.at(-1)?.options.onEvent(event);
        await Promise.resolve();
      });
      await flush(2);
    },
  };
}

const sse = (event: string, data: unknown): ServerEvent => ({
  event,
  data: JSON.stringify(data),
  id: null,
});

function snapshotOf(runs: Run[], pveRuns: PveRunning[] = []): LiveSnapshot {
  return { runs, definitions: [], machines: [], pveRuns, serverTime: new Date().toISOString() };
}

function running(overrides: Partial<Run> = {}): Run {
  return run({
    startedAt: ago(125),
    createdAt: ago(130),
    updatedAt: ago(1),
    ...overrides,
  });
}

function guest(overrides: Partial<PveRunning> = {}): PveRunning {
  return {
    id: "pve-1",
    kind: "backup",
    guest: { id: "guest-1", vmid: 100, name: "db01", kind: "vm" },
    jobName: "Every guest",
    startedAt: ago(300),
    cancelling: false,
    progress: {
      bytesDone: 3_000_000_000,
      bytesTotal: 12_000_000_000,
      bytesUploaded: 1_000_000,
      bytesPerSecond: 85_000_000,
      at: ago(2),
    },
    ...overrides,
  };
}

const EMPTY: RunningData = {
  generatedAt: new Date().toISOString(),
  runs: [],
  pve: [],
  truncated: false,
  nextRunAt: null,
};

function snapshotWith(overrides: Partial<RunningData> = {}): RunningData {
  return { ...EMPTY, generatedAt: new Date().toISOString(), ...overrides };
}

const ready = (data: RunningData): WidgetView<RunningData> => ({ kind: "ready", data });

async function show(
  view: WidgetView<RunningData>,
  options: { channel?: ReturnType<typeof streams>; withChannel?: boolean } = {},
) {
  const channel = options.channel ?? streams();
  const widget = (
    <TooltipProvider>
      <RunningNowWidget view={view} onRetry={() => {}} retrying={false} />
    </TooltipProvider>
  );
  mounted = mount(
    options.withChannel === false ? (
      widget
    ) : (
      <LiveChannelProvider deps={{ open: channel.open } as never}>{widget}</LiveChannelProvider>
    ),
    { session: adminSession(), queryClient: newQueryClient() },
  );
  await flush(2);
  return channel;
}

const card = () => document.querySelector('[data-widget="running"]') as HTMLElement;
const text = () => (card().textContent ?? "").replace(/\s+/g, " ");
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-slot="running-row"]')];
const note = () => document.querySelector<HTMLElement>('[data-slot="running-freshness"]');

describe("nothing is running", () => {
  it("says so, with when the next planned backup starts", async () => {
    const channel = await show(
      ready(snapshotWith({ nextRunAt: new Date(NOW + 3 * 3_600_000).toISOString() })),
    );
    await channel.status("open");
    await channel.event(sse("snapshot", snapshotOf([])));
    expect(text()).toContain("Running now");
    expect(text()).toContain("Nothing is running right now");
    expect(text()).toContain("The next scheduled backup starts");
    expect(text()).toMatch(/in 3 hours/);
    expect(rows()).toHaveLength(0);
    // No graph without runs.
    expect(document.querySelector('[data-slot="running-total"]')).toBeNull();
    expect(note()?.getAttribute("data-freshness")).toBe("live");
  });

  it("says that nothing is planned, and when a start is due", async () => {
    await show(ready(snapshotWith()), { withChannel: false });
    expect(text()).toContain("No backup is scheduled.");
    await mounted?.unmount();
    mounted = null;
    await show(ready(snapshotWith({ nextRunAt: new Date(NOW - 60_000).toISOString() })), {
      withChannel: false,
    });
    expect(text()).toContain("The next scheduled backup is due now.");
  });
});

describe("runs of every kind", () => {
  const everything = () =>
    snapshotOf(
      [
        running({ id: "r-mail", subject: subject("mailbox", "anna@contoso.example") }),
        running({
          id: "r-drive",
          subject: subject("onedrive", "Anna Example"),
          startedAt: ago(100),
          throughput: { processedBps: 9_000_000, transferredBps: 1 },
        }),
        running({
          id: "r-site",
          subject: subject("site", "Marketing"),
          startedAt: ago(90),
          progress: null,
          throughput: null,
          samples: null,
        }),
        running({ id: "r-group", subject: subject("group", "Team Nord"), startedAt: ago(80) }),
        running({
          id: "r-imap",
          subject: subject("imap", "info@contoso.example"),
          startedAt: ago(70),
        }),
        running({
          id: "r-server",
          source: "endpoint",
          subject: subject("server", "web01"),
          job: { id: "j2", name: "Servers" },
          startedAt: ago(60),
          progress: {
            percent: 70,
            itemsDone: 70_000,
            itemsTotal: 100_000,
            itemsFailed: 0,
            bytesProcessed: 7_000_000_000,
            bytesTransferred: 1,
            bytesNew: null,
            bytesTotal: 10_000_000_000,
            etaSeconds: null,
            currentPath: null,
            updatedAt: ago(1),
          },
        }),
        running({
          id: "r-share",
          source: "file_share",
          subject: subject("file_share", "Projekte"),
          startedAt: ago(50),
        }),
        running({
          id: "r-restore",
          kind: "restore",
          subject: subject("mailbox", "ben@contoso.example"),
          startedAt: ago(40),
        }),
        running({
          id: "r-check",
          kind: "restore_check",
          subject: subject("mailbox", "carl@contoso.example"),
          startedAt: ago(30),
        }),
        // Not running: waiting, and over.
        running({ id: "r-wait", state: "queued", subject: subject("mailbox", "wait@x.example") }),
        running({
          id: "r-done",
          state: "succeeded",
          subject: subject("mailbox", "done@x.example"),
        }),
      ],
      [
        guest(),
        guest({
          id: "pve-2",
          guest: { id: "guest-2", vmid: 101, name: null, kind: "ct" },
          jobName: null,
          startedAt: ago(250),
          progress: null,
        }),
      ],
    );

  it("lists each run with its object, kind, elapsed time, figures and speed", async () => {
    const channel = await show(ready(snapshotWith()));
    await channel.status("open");
    await channel.event(sse("snapshot", everything()));

    // Nine mail, machine and share runs and two guests; the waiting and the finished one are not shown.
    expect(text()).toContain("11 runs in progress");
    expect(rows().length).toBeGreaterThan(0);
    await act(async () => {
      [...card().querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.startsWith("Show all"))
        ?.click();
    });
    expect(rows()).toHaveLength(11);
    expect(text()).not.toContain("wait@x.example");
    expect(text()).not.toContain("done@x.example");

    const row = (name: string) =>
      rows().find((entry) => entry.textContent?.includes(name)) as HTMLElement;
    const rowText = (name: string) => (row(name).textContent ?? "").replace(/\s+/g, " ");

    expect(rowText("anna@contoso.example")).toContain("Mailbox");
    expect(rowText("anna@contoso.example")).toContain("Mail backup");
    expect(rowText("anna@contoso.example")).toContain("40 %");
    expect(rowText("anna@contoso.example")).toContain("400 of 1,000 items");
    expect(rowText("anna@contoso.example")).toMatch(/Running for 2:0\d/);
    expect(rowText("anna@contoso.example")).toContain("MB/s");
    expect(rowText("Anna Example")).toContain("OneDrive");
    expect(rowText("Marketing")).toContain("SharePoint site");
    expect(rowText("Team Nord")).toContain("Microsoft 365 group");
    expect(rowText("info@contoso.example")).toContain("IMAP account");
    expect(rowText("web01")).toContain("Server");
    expect(rowText("web01")).toContain("70 %");
    expect(rowText("web01")).toMatch(/6\.52 GB of 9\.31 GB/);
    expect(rowText("Projekte")).toContain("File share");
    expect(rowText("ben@contoso.example")).toContain("Restore");
    expect(rowText("carl@contoso.example")).toContain("Restore check");
    expect(rowText("db01")).toContain("Virtual machine");
    expect(rowText("db01")).toContain("25 %");
    expect(rowText("db01")).toContain("81.1 MB/s");
    expect(rowText("101")).toContain("Container");
    // A run that reports no speed says so, in words for a screen reader.
    expect(row("Marketing").textContent).toContain("No throughput reported");
    // Links open the run, or the guest.
    expect(row("anna@contoso.example").querySelector("a")?.getAttribute("href")).toBe(
      "/history/r-mail",
    );
    expect(row("db01").querySelector("a")?.getAttribute("href")).toBe("/virtualization/guest-1");
    // Percent bars carry a name.
    expect(
      row("anna@contoso.example").querySelector('[role="progressbar"]')?.getAttribute("aria-label"),
    ).toBe("Progress of anna@contoso.example");
    // No tenant column on a tenant's own page.
    expect(row("web01").querySelector("button")).toBeNull();
  });

  it("shows the longest-running first and folds the rest behind Show all", async () => {
    const channel = await show(ready(snapshotWith()));
    await channel.status("open");
    await channel.event(sse("snapshot", everything()));
    expect(rows()).toHaveLength(8);
    expect(rows()[0]?.textContent).toContain("db01");
    const more = [...card().querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.startsWith("Show all 11"),
    );
    expect(more).toBeDefined();
    await act(async () => more?.click());
    expect(rows()).toHaveLength(11);
    expect(text()).toContain("Show fewer");
  });

  it("writes the total graph out as text and sums the speeds of the runs", async () => {
    const channel = await show(ready(snapshotWith()));
    await channel.status("open");
    await channel.event(
      sse(
        "snapshot",
        snapshotOf(
          [running({ id: "a", samples: samples(30, { start: NOW - 60_000 }) })],
          [
            guest({
              progress: {
                bytesDone: 3_000_000_000,
                bytesTotal: 12_000_000_000,
                bytesUploaded: null,
                bytesPerSecond: 1_000_000,
                at: ago(2),
              },
            }),
          ],
        ),
      ),
    );
    const total = document.querySelector('[data-slot="running-total"]') as HTMLElement;
    expect(total).not.toBeNull();
    expect(total.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Total throughput over the last 5 minutes",
    );
    const summary = total.querySelector(".sr-only")?.textContent ?? "";
    // 8 MB every two seconds (the mail run) plus 1 MB/s (the guest): 5,000,000 bytes a second.
    expect(summary).toMatch(
      /^Total throughput of 2 runs over the last 5 minutes: now 4\.77 MB\/s, on average [\d.]+ .?B\/s, at most 4\.77 MB\/s\.$/,
    );
    expect(total.textContent).toContain("now 4.77 MB/s");
    expect(text()).toContain("2 runs in progress · 4.77 MB/s");
  });

  it("says so instead of drawing a zero when no run has reported a speed", async () => {
    const channel = await show(ready(snapshotWith()));
    await channel.status("open");
    await channel.event(
      sse("snapshot", snapshotOf([running({ id: "a", samples: null, throughput: null })], [])),
    );
    const total = document.querySelector('[data-slot="running-total"]') as HTMLElement;
    expect(total.textContent).toContain("No throughput reported yet.");
    expect(total.querySelector('[role="img"]')).toBeNull();
    expect(total.textContent).not.toContain("0 B/s");
  });

  it("shows no speed for a node that has stopped reporting", async () => {
    const channel = await show(ready(snapshotWith()));
    await channel.status("open");
    // The node's last report is a minute old, though the run still goes on.
    await channel.event(
      sse(
        "snapshot",
        snapshotOf(
          [],
          [
            guest({
              progress: {
                ...(guest().progress as NonNullable<PveRunning["progress"]>),
                bytesPerSecond: 85_000_000,
                at: ago(60),
              },
            }),
          ],
        ),
      ),
    );
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain("No throughput reported");
    expect(rows()[0]?.textContent).not.toContain("85");
    expect(text()).toContain("1 run in progress");
    expect(text()).not.toContain("MB/s");
    expect(document.querySelector('[data-slot="running-total"]')?.textContent).toContain(
      "No throughput reported yet.",
    );
  });

  it("says that more guests run than are listed, but not at exactly the limit", async () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        guest({
          id: `pve-${index}`,
          guest: { id: `g-${index}`, vmid: 100 + index, name: `vm${index}`, kind: "vm" },
          startedAt: ago(1000 - index),
        }),
      );
    const channel = await show(ready(snapshotWith()));
    await channel.status("open");
    await channel.event(sse("snapshot", snapshotOf([], many(50))));
    expect(text()).toContain("50 runs in progress");
    expect(text()).not.toContain("More runs are going on than listed here.");

    // The channel carries one beyond the limit: it is not listed, but it says there are more.
    await channel.event(sse("pve_run", many(51)[50]));
    expect(text()).toContain("50 runs in progress");
    expect(text()).toContain("More runs are going on than listed here.");
  });

  it("moves with the channel: a run that progresses, a guest that ends", async () => {
    const channel = await show(ready(snapshotWith()));
    await channel.status("open");
    await channel.event(sse("snapshot", snapshotOf([running({ id: "a" })], [guest()])));
    expect(text()).toContain("2 runs in progress");
    expect(text()).toContain("25 %");

    await channel.event(
      sse(
        "run",
        running({
          id: "a",
          progress: {
            ...(running().progress as NonNullable<Run["progress"]>),
            percent: 55,
            itemsDone: 550,
          },
        }),
      ),
    );
    expect(text()).toContain("55 %");

    await channel.event(sse("gone", { kind: "pve_run", id: "pve-1" }));
    expect(text()).toContain("1 run in progress");
    expect(text()).not.toContain("db01");

    // The last run ends: the card turns to its empty state.
    await channel.event(sse("run", running({ id: "a", state: "succeeded", finishedAt: ago(0) })));
    expect(text()).toContain("Nothing is running right now");
  });

  it("marks a run that is being stopped and one that waits for Microsoft", async () => {
    const channel = await show(ready(snapshotWith()));
    await channel.status("open");
    await channel.event(
      sse(
        "snapshot",
        snapshotOf([
          running({ id: "a", cancelling: true }),
          running({
            id: "b",
            subject: subject("mailbox", "wait@contoso.example"),
            throttle: { until: iso(600), reason: "graph" } as never,
          }),
        ]),
      ),
    );
    expect(text()).toContain("Stopping");
    expect(text()).toContain("Waiting for Microsoft");
  });
});

describe("when live updates are off", () => {
  const first = () =>
    snapshotOf([running({ id: "a", subject: subject("mailbox", "last@contoso.example") })]);

  it("shows the state of the page's own request, and says live updates are off, where there is no channel", async () => {
    await show(
      ready(
        snapshotWith({
          generatedAt: ago(180),
          runs: [running({ id: "a", subject: subject("mailbox", "snap@contoso.example") })],
        }),
      ),
      { withChannel: false },
    );
    expect(text()).toContain("snap@contoso.example");
    expect(note()?.getAttribute("data-freshness")).toBe("off");
    expect(note()?.textContent).toContain(
      "Live updates are off. Showing the last known state, 3 minutes ago.",
    );
    expect(note()?.getAttribute("role")).toBe("status");
  });

  it("keeps the last state the channel gave when the server turns the connection down", async () => {
    const channel = await show(ready(snapshotWith()));
    await channel.status("open");
    await channel.event(sse("snapshot", first()));
    expect(note()?.getAttribute("data-freshness")).toBe("live");
    await channel.status("closed");
    await flush(2);
    expect(text()).toContain("last@contoso.example");
    expect(note()?.getAttribute("data-freshness")).toBe("off");
    expect(text()).toContain("Live updates are off.");
  });

  it("says it is not connected while the channel retries, and shows the last state meanwhile", async () => {
    const channel = await show(ready(snapshotWith()));
    await channel.status("open");
    await channel.event(sse("snapshot", first()));
    await channel.status("reconnecting");
    await flush(2);
    expect(text()).toContain("last@contoso.example");
    expect(note()?.getAttribute("data-freshness")).toBe("reconnecting");
    expect(text()).toContain("Not connected, retrying. Showing the last known state");
  });

  it("uses the page's snapshot until the channel has spoken, then the channel", async () => {
    const channel = await show(
      ready(
        snapshotWith({
          runs: [running({ id: "s", subject: subject("mailbox", "from-page@x.example") })],
        }),
      ),
    );
    await channel.status("open");
    // Open, but the first snapshot is not in yet.
    expect(text()).toContain("from-page@x.example");
    expect(note()?.getAttribute("data-freshness")).toBe("connecting");
    await channel.event(sse("snapshot", first()));
    expect(text()).toContain("last@contoso.example");
    expect(text()).not.toContain("from-page@x.example");
  });
});

describe("in German", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("speaks to the reader formally and names the same states", async () => {
    await i18n.changeLanguage("de");
    await show(ready(snapshotWith({ nextRunAt: new Date(NOW + 3 * 3_600_000).toISOString() })), {
      withChannel: false,
    });
    expect(text()).toContain("Läuft gerade");
    expect(text()).toContain("Gerade läuft nichts");
    expect(text()).toContain("Die nächste geplante Sicherung beginnt");
    expect(note()?.textContent).toContain("Die Live-Aktualisierung ist aus.");
    await mounted?.unmount();
    mounted = null;
    await show(ready(snapshotWith({ runs: [running({ id: "a" })], pve: [guest()] })), {
      withChannel: false,
    });
    expect(text()).toContain("2 Läufe aktiv");
    expect(
      rows()
        .map((row) => row.textContent)
        .join(" "),
    ).toContain("Virtuelle Maschine");
    expect(text()).toContain("Läuft seit");
    expect(text()).toContain("Gesamtdurchsatz");
  });
});

describe("the other states of a widget", () => {
  it("shows a skeleton while the page loads", async () => {
    await show({ kind: "loading" }, { withChannel: false });
    expect(card().getAttribute("data-state")).toBe("loading");
    expect(text()).toContain("Loading Running now");
  });

  it("shows why it failed, with a retry", async () => {
    await show({ kind: "error", error: new WidgetUnavailableError() }, { withChannel: false });
    expect(card().getAttribute("data-state")).toBe("error");
    expect(card().querySelector('[role="alert"]')).not.toBeNull();
  });

  it("says when more runs go on than are listed", async () => {
    await show(ready(snapshotWith({ truncated: true, runs: [running({ id: "a" })] })), {
      withChannel: false,
    });
    expect(text()).toContain("More runs are going on than listed here.");
  });
});
