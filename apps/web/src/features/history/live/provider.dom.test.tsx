// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type Mounted,
  enableActEnvironment,
  flush,
  installMemoryStorage,
  mount,
  newQueryClient,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import type { EventStreamOptions, ServerEvent, StreamStatus } from "@/features/jobs/sse";
import { type Run, historyKeys } from "../api";
import { run } from "../fixtures";
import "../i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { adminSession } from "../testing";
import type { LiveRuns } from "./apply";
import { type VisibilitySource, resetChannelsForTesting } from "./channel";
import { LiveIndicator } from "./indicator";
import {
  LiveChannelProvider,
  useLiveOpen,
  useLivePolling,
  useLiveRun,
  useLiveState,
  useRunningRunsOf,
} from "./provider";

/**
 * The provider: one stream per tab however many parts of the page read it, the polling that stays
 * while the stream is down and goes while it is up, what an event does to the cache, the places
 * where the channel stays off, and what the indicator says in each state.
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
  document.body.innerHTML = "";
});

/** A stream opener that counts, records each stream and lets the test drive it. */
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
    alive: () => opened.filter((stream) => !stream.closed),
    status: (value: StreamStatus, index = opened.length - 1) =>
      act(async () => {
        opened[index]?.options.onStatus?.(value);
        await Promise.resolve();
      }),
    // The query cache tells its observers on the next tick: let it.
    event: async (event: ServerEvent, index = opened.length - 1) => {
      await act(async () => {
        opened[index]?.options.onEvent(event);
        await Promise.resolve();
      });
      await flush(2);
    },
    activity: (index = opened.length - 1) =>
      act(async () => {
        opened[index]?.options.onActivity?.();
        await Promise.resolve();
      }),
  };
}

function Probe({ id }: { id: string }) {
  const open = useLiveOpen();
  const polling = useLivePolling(5000);
  const state = useLiveState();
  return (
    <span
      data-probe={id}
      data-open={String(open)}
      data-polling={String(polling)}
      data-status={state?.status ?? "off"}
    />
  );
}

const probe = (id: string) => document.querySelector<HTMLElement>(`[data-probe="${id}"]`);

function visibility(initial = true) {
  let visible = initial;
  const listeners = new Set<() => void>();
  const source: VisibilitySource = {
    isVisible: () => visible,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    set(next: boolean) {
      visible = next;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

async function show(
  node: React.ReactNode,
  deps: ConstructorParameters<typeof Object>[0] & object,
  session = adminSession(),
) {
  mounted = mount(
    <TooltipProvider>
      <LiveChannelProvider deps={deps as never}>{node}</LiveChannelProvider>
    </TooltipProvider>,
    {
      session,
      queryClient: newQueryClient(),
    },
  );
  await flush(2);
}

describe("one connection per tab", () => {
  it("opens one stream however many parts of the page read the channel", async () => {
    const s = streams();
    await show(
      <>
        <Probe id="a" />
        <Probe id="b" />
        <Probe id="c" />
        <LiveIndicator />
      </>,
      { open: s.open },
    );
    expect(s.opened).toHaveLength(1);
    expect(s.opened[0]?.options).toMatchObject({ path: "/live", tenantId: "tenant-1" });
    // And a re-render of the provider's children does not open another.
    await mounted?.render(
      <TooltipProvider>
        <LiveChannelProvider deps={{ open: s.open } as never}>
          <Probe id="a" />
          <Probe id="b" />
        </LiveChannelProvider>
      </TooltipProvider>,
    );
    await flush(2);
    expect(s.alive()).toHaveLength(1);
  });

  it("closes the stream when the page goes away", async () => {
    const s = streams();
    await show(<Probe id="a" />, { open: s.open });
    expect(s.alive()).toHaveLength(1);
    await mounted?.unmount();
    mounted = null;
    expect(s.alive()).toHaveLength(0);
  });

  it("closes the stream in the background and opens it again, with a new snapshot, on return", async () => {
    const s = streams();
    const tab = visibility(true);
    await show(<Probe id="a" />, { open: s.open, visibility: tab.source });
    await s.status("open");
    expect(probe("a")?.getAttribute("data-open")).toBe("true");
    tab.set(false);
    await flush(1);
    expect(s.alive()).toHaveLength(0);
    expect(probe("a")?.getAttribute("data-status")).toBe("paused");
    tab.set(true);
    await flush(1);
    expect(s.opened).toHaveLength(2);
    expect(s.alive()).toHaveLength(1);
  });
});

describe("polling while the stream is down", () => {
  it("polls at the page's own pace until the stream delivers, stops while it does and polls again when it breaks", async () => {
    const s = streams();
    await show(<Probe id="a" />, { open: s.open });
    // Connecting: the page keeps polling.
    expect(probe("a")?.getAttribute("data-polling")).toBe("5000");
    await s.status("open");
    expect(probe("a")?.getAttribute("data-polling")).toBe("false");
    await s.status("reconnecting");
    expect(probe("a")?.getAttribute("data-polling")).toBe("5000");
    await s.status("open");
    expect(probe("a")?.getAttribute("data-polling")).toBe("false");
    await s.status("closed");
    expect(probe("a")?.getAttribute("data-polling")).toBe("5000");
  });

  it("polls where there is no channel at all", async () => {
    mounted = mount(<Probe id="a" />, { session: adminSession() });
    await flush(1);
    expect(probe("a")?.getAttribute("data-polling")).toBe("5000");
    expect(probe("a")?.getAttribute("data-status")).toBe("off");
  });
});

describe("where the channel stays off", () => {
  const cases: [string, ReturnType<typeof adminSession>][] = [
    [
      "under All tenants (there is no tenant stream)",
      adminSession({
        role: "provider_admin",
        isProviderAdmin: true,
        scope: "all",
        canViewAllTenants: true,
      }),
    ],
    ["for an end user", adminSession({ role: "tenant_user" })],
    ["without an active tenant", adminSession({ activeTenant: null })],
    ["while the session is not settled", adminSession({ status: "loading" })],
  ];
  for (const [name, session] of cases) {
    it(`opens no stream ${name}`, async () => {
      const s = streams();
      await show(<Probe id="a" />, { open: s.open }, session);
      expect(s.opened).toHaveLength(0);
      expect(probe("a")?.getAttribute("data-status")).toBe("off");
    });
  }

  it("opens one for a provider admin in a tenant", async () => {
    const s = streams();
    await show(
      <Probe id="a" />,
      { open: s.open },
      adminSession({ role: "provider_admin", isProviderAdmin: true }),
    );
    expect(s.opened).toHaveLength(1);
  });
});

describe("what an event does", () => {
  it("writes runs into the live map and the pages read them", async () => {
    const s = streams();
    function Reader() {
      const live = useLiveRun("11111111-1111-4111-8111-111111111111");
      const running = useRunningRunsOf("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      return <b data-reader data-state={live?.state ?? "none"} data-running={running.length} />;
    }
    await show(<Reader />, { open: s.open });
    const reader = () => document.querySelector<HTMLElement>("[data-reader]");
    expect(reader()?.getAttribute("data-state")).toBe("none");
    await s.event({
      event: "snapshot",
      data: JSON.stringify({ runs: [run()], definitions: [], machines: [], serverTime: "" }),
      id: null,
    });
    expect(reader()?.getAttribute("data-state")).toBe("running");
    expect(reader()?.getAttribute("data-running")).toBe("1");
    await s.event({
      event: "run",
      data: JSON.stringify({
        ...run(),
        state: "succeeded",
        finishedAt: new Date().toISOString(),
      } satisfies Partial<Run>),
      id: null,
    });
    expect(reader()?.getAttribute("data-state")).toBe("succeeded");
    expect(reader()?.getAttribute("data-running")).toBe("0");
    const map = mounted?.queryClient.getQueryData<LiveRuns>(historyKeys.live("tenant-1"));
    expect(Object.keys(map ?? {})).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });
});

describe("the indicator", () => {
  const indicator = () => document.querySelector<HTMLElement>('[data-slot="live-indicator"]');

  it("says it is connecting, then Live with how fresh it is", async () => {
    const s = streams();
    await show(<LiveIndicator />, { open: s.open });
    expect(indicator()?.getAttribute("data-status")).toBe("connecting");
    expect(indicator()?.textContent).toContain("Connecting");
    await s.status("open");
    expect(indicator()?.getAttribute("data-status")).toBe("open");
    expect(indicator()?.querySelector("output")?.textContent).toBe("Live");
    expect(indicator()?.textContent).toContain("updated just now");
  });

  it("counts the time since the server last spoke, on its own clock, and a keep-alive resets it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const s = streams();
    await show(<LiveIndicator />, { open: s.open });
    await s.status("open");
    expect(indicator()?.textContent).toContain("updated just now");
    await act(async () => {
      vi.advanceTimersByTime(35_000);
    });
    // Counted in whole seconds on the clock of the second, so a second earlier or later is the same moment.
    expect(indicator()?.textContent).toMatch(/updated 3[45] s ago/);
    await s.activity();
    expect(indicator()?.textContent).toContain("updated just now");
    await act(async () => {
      vi.advanceTimersByTime(40_000);
    });
    expect(indicator()?.textContent).toMatch(/updated (39|40) s ago/);
    await act(async () => {
      vi.advanceTimersByTime(90_000);
    });
    // The watchdog has replaced a stream that stayed silent this long, so it no longer claims to be live.
    expect(indicator()?.getAttribute("data-status")).not.toBe("open");
  });

  it("does not put the counting seconds in the live region, only the state", async () => {
    const s = streams();
    await show(<LiveIndicator />, { open: s.open });
    await s.status("open");
    expect(indicator()?.querySelector("output")?.textContent).toBe("Live");
    expect(indicator()?.querySelector("output")?.textContent).not.toMatch(/ago|just now/);
  });

  it("says plainly that it is not connected and retrying, and that updates are off when refused", async () => {
    const s = streams();
    await show(<LiveIndicator />, { open: s.open });
    await s.status("open");
    await s.status("reconnecting");
    expect(indicator()?.textContent).toContain("Not connected, retrying");
    expect(indicator()?.getAttribute("data-status")).toBe("reconnecting");
    await s.status("closed");
    expect(indicator()?.textContent).toContain("Live updates are off");
  });

  it("is named, and shows nothing where the channel is off or the tab is in the background", async () => {
    const s = streams();
    const tab = visibility(true);
    await show(<LiveIndicator />, { open: s.open, visibility: tab.source });
    await s.status("open");
    expect(indicator()?.getAttribute("aria-label")).toBe("Live updates");
    tab.set(false);
    await flush(1);
    expect(indicator()).toBeNull();
    await mounted?.unmount();
    mounted = null;
    mounted = mount(
      <TooltipProvider>
        <LiveIndicator />
      </TooltipProvider>,
      { session: adminSession() },
    );
    await flush(1);
    expect(indicator()).toBeNull();
  });

  it("pulses only when motion is allowed", async () => {
    const s = streams();
    await show(<LiveIndicator />, { open: s.open });
    await s.status("open");
    const pulse = indicator()?.querySelector('[class*="animate-ping"]');
    expect(pulse?.className).toContain("motion-safe:animate-ping");
    expect(pulse?.className).not.toMatch(/(^|\s)animate-ping/);
  });
});
