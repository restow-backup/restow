// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { EventStreamOptions, StreamStatus } from "@/features/jobs/sse";
import {
  type Mounted,
  type RecordedRequest,
  enableActEnvironment,
  installMemoryStorage,
  json,
  mount,
  newQueryClient,
  routedFetch,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import { type HistoryPage, historyKeys } from "./api";
import { agentRun, finished, run } from "./fixtures";
import {
  DETAIL_REFRESH_LIVE_MS,
  IDLE_REFRESH_MS,
  RUNNING_REFRESH_MS,
  anyLive,
  mergeRun,
  useHistory,
  useRunDetail,
} from "./hooks";
import "./i18n";
import { resetChannelsForTesting } from "./live/channel";
import { LiveChannelProvider } from "./live/provider";
import { adminSession } from "./testing";

/**
 * What keeps History current: the live channel while it is connected, the page's own polling
 * (quicker while something runs) while it is not, and nothing at all for a list with nothing running.
 */

enableActEnvironment();

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
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function List() {
  const { runs } = useHistory({ type: null, job: null });
  return <ul data-runs={runs.length} />;
}

function Detail({ id }: { id: string }) {
  const detail = useRunDetail(id);
  return <b data-detail={detail.data?.state ?? "none"} />;
}

async function setup(
  node: React.ReactNode,
  routes: Record<string, (request: RecordedRequest) => Response | Promise<Response>>,
) {
  const { mock, requests } = routedFetch(routes);
  vi.stubGlobal("fetch", mock);
  const opened: { options: EventStreamOptions }[] = [];
  mounted = mount(
    <TooltipProvider>
      <LiveChannelProvider
        deps={{
          open: (options) => {
            opened.push({ options });
            return { close: () => undefined };
          },
        }}
      >
        {node}
      </LiveChannelProvider>
    </TooltipProvider>,
    { session: adminSession(), queryClient: newQueryClient() },
  );
  // The fake clock stands in for the macrotasks `flush` would wait for.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
  return {
    requests,
    status: (status: StreamStatus) =>
      act(async () => {
        opened[opened.length - 1]?.options.onStatus?.(status);
        await Promise.resolve();
      }),
  };
}

const asked = (requests: RecordedRequest[], path: string) =>
  requests.filter((request) => request.path === path).length;

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe("the list keeps itself current", () => {
  it("polls quickly while something runs and the channel is not connected, and stops once it is", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const page: HistoryPage = { items: [run(), agentRun()], next: null };
    const s = await setup(<List />, { "GET /history": () => json(page) });
    expect(asked(s.requests, "/history")).toBe(1);
    await advance(RUNNING_REFRESH_MS + 100);
    expect(asked(s.requests, "/history")).toBe(2);
    await advance(RUNNING_REFRESH_MS + 100);
    expect(asked(s.requests, "/history")).toBe(3);
    // The channel delivers: the page does not ask any more.
    await s.status("open");
    const settled = asked(s.requests, "/history");
    // Well inside the time a silent connection is trusted (see the stall watchdog of the channel).
    await advance(30_000);
    expect(asked(s.requests, "/history")).toBe(settled);
    // It breaks: the page's own polling is back.
    await s.status("reconnecting");
    await advance(RUNNING_REFRESH_MS + 100);
    expect(asked(s.requests, "/history")).toBeGreaterThan(settled);
  });

  it("polls slowly when nothing runs", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const page: HistoryPage = { items: [finished("succeeded")], next: null };
    const s = await setup(<List />, { "GET /history": () => json(page) });
    await advance(RUNNING_REFRESH_MS * 3);
    expect(asked(s.requests, "/history")).toBe(1);
    await advance(IDLE_REFRESH_MS);
    expect(asked(s.requests, "/history")).toBe(2);
  });
});

describe("a run's detail", () => {
  it("is read again now and then while the run runs, and not at all once it is over", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const running = run();
    const s = await setup(<Detail id={running.id} />, {
      [`GET /history/${running.id}`]: () =>
        json({
          ...running,
          objects: [],
          events: [],
          batch: null,
          restoreCheck: { state: "none", checkedAt: null, runId: null },
          summary: null,
          errors: [],
          errorCount: 0,
          logTail: null,
          docsUrl: "",
        }),
    });
    await s.status("open");
    const path = `/history/${running.id}`;
    expect(asked(s.requests, path)).toBe(1);
    await advance(DETAIL_REFRESH_LIVE_MS + 100);
    expect(asked(s.requests, path)).toBe(2);
  });

  it("settles on a finished run without asking again", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const done = finished("succeeded");
    const s = await setup(<Detail id={done.id} />, {
      [`GET /history/${done.id}`]: () =>
        json({
          ...done,
          objects: [],
          events: [],
          batch: null,
          restoreCheck: { state: "none", checkedAt: null, runId: null },
          summary: null,
          errors: [],
          errorCount: 0,
          logTail: null,
          docsUrl: "",
        }),
    });
    await advance(10 * 60_000);
    expect(asked(s.requests, `/history/${done.id}`)).toBe(1);
  });
});

describe("pure helpers", () => {
  it("tells whether anything on the loaded pages is going", () => {
    expect(anyLive(undefined)).toBe(false);
    expect(anyLive([{ items: [finished()], next: null }])).toBe(false);
    expect(
      anyLive([
        { items: [finished()], next: "x" },
        { items: [run()], next: null },
      ]),
    ).toBe(true);
    expect(anyLive([{ items: [run({ state: "queued" })], next: null }])).toBe(true);
  });

  it("takes the live run over the loaded detail only when it is not older", () => {
    const loaded = { ...run({ updatedAt: "2026-10-02T10:00:10.000Z" }), objects: [] } as never;
    const newer = run({ updatedAt: "2026-10-02T10:00:20.000Z", state: "succeeded" });
    const older = run({ updatedAt: "2026-10-02T10:00:05.000Z", state: "failed" });
    expect(mergeRun(loaded, newer)?.state).toBe("succeeded");
    expect(mergeRun(loaded, older)?.state).toBe("running");
    expect(mergeRun(undefined, newer)).toBe(newer);
    expect(mergeRun(loaded, undefined)).toBe(loaded);
    expect(mergeRun(undefined, undefined)).toBeUndefined();
    // The detail's own parts survive the merge.
    expect((mergeRun(loaded, newer) as { objects?: unknown[] }).objects).toEqual([]);
  });

  it("keys the caches by tenant and filter", () => {
    expect(historyKeys.list("t", { type: null, job: null })).toEqual([
      "tenant",
      "t",
      "history",
      "list",
      "all",
      "all",
    ]);
    expect(historyKeys.list("t", { type: "backup", job: "j" })).toEqual([
      "tenant",
      "t",
      "history",
      "list",
      "backup",
      "j",
    ]);
  });
});
