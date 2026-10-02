import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EventStreamOptions, ServerEvent, StreamStatus } from "@/features/jobs/sse";

import {
  type ChannelDeps,
  LiveChannel,
  STALE_AFTER_MS,
  STALL_MS,
  type VisibilitySource,
  WATCHDOG_MS,
  acquireChannel,
  resetChannelsForTesting,
} from "./channel";

/** A stream opener that records every stream and lets the test drive it. */
function harness(initiallyVisible = true) {
  let clock = 1_000_000;
  let visible = initiallyVisible;
  const visibilityListeners = new Set<() => void>();
  const streams: { options: EventStreamOptions; closed: boolean }[] = [];
  const stale: { reason: string; gapMs: number }[] = [];
  const events: ServerEvent[] = [];
  const visibility: VisibilitySource = {
    isVisible: () => visible,
    subscribe: (listener) => {
      visibilityListeners.add(listener);
      return () => visibilityListeners.delete(listener);
    },
  };
  const deps: ChannelDeps = {
    open: (options) => {
      const stream = { options, closed: false };
      streams.push(stream);
      return {
        close() {
          stream.closed = true;
        },
      };
    },
    now: () => clock,
    visibility,
  };
  const create = (tenantId = "tenant-1") =>
    new LiveChannel(tenantId, deps, {
      onEvent: (event) => events.push(event),
      onStale: (reason, gapMs) => stale.push({ reason, gapMs }),
    });
  return {
    streams,
    stale,
    events,
    create,
    open: () => streams.filter((stream) => !stream.closed),
    status: (stream: number, status: StreamStatus) => streams[stream]?.options.onStatus?.(status),
    activity: (stream = streams.length - 1) => streams[stream]?.options.onActivity?.(),
    advance: (ms: number) => {
      clock += ms;
      vi.advanceTimersByTime(ms);
    },
    setVisible(next: boolean) {
      visible = next;
      for (const listener of [...visibilityListeners]) listener();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  resetChannelsForTesting();
  vi.useRealTimers();
});

describe("the live channel of a tab", () => {
  it("opens one stream to the live path with the tenant, and reports what the server sends", () => {
    const h = harness();
    const channel = h.create();
    channel.start();
    expect(h.streams).toHaveLength(1);
    expect(h.streams[0]?.options).toMatchObject({ path: "/live", tenantId: "tenant-1" });
    expect(channel.getState().status).toBe("connecting");
    h.status(0, "open");
    expect(channel.getState().status).toBe("open");
    h.streams[0]?.options.onEvent({ event: "run", data: "{}", id: null });
    expect(h.events).toHaveLength(1);
    channel.stop();
  });

  it("starting twice does not open a second stream", () => {
    const h = harness();
    const channel = h.create();
    channel.start();
    channel.start();
    expect(h.streams).toHaveLength(1);
    channel.stop();
  });

  it("tells subscribers about changes, and only changes", () => {
    const h = harness();
    const channel = h.create();
    const seen: string[] = [];
    channel.subscribe(() => seen.push(channel.getState().status));
    channel.start();
    h.status(0, "open");
    h.status(0, "open");
    h.status(0, "reconnecting");
    // The state a channel starts in is not news; each change is, once.
    expect(seen).toEqual(["open", "reconnecting"]);
    channel.stop();
  });

  it("records the last sign of life, a keep-alive included", () => {
    const h = harness();
    const channel = h.create();
    channel.start();
    h.status(0, "open");
    h.advance(10_000);
    h.activity();
    expect(channel.getState().lastActivityAt).toBe(1_010_000);
    channel.stop();
  });

  it("says honestly that it is not connected while the stream retries, and live again after", () => {
    const h = harness();
    const channel = h.create();
    channel.start();
    h.status(0, "open");
    h.status(0, "reconnecting");
    expect(channel.getState().status).toBe("reconnecting");
    h.status(0, "open");
    expect(channel.getState().status).toBe("open");
    // A short gap needs no refetch: the stream's snapshot reaches back a minute.
    expect(h.stale).toEqual([]);
    channel.stop();
  });

  it("asks the page to read again after a connection was lost for long", () => {
    const h = harness();
    const channel = h.create();
    channel.start();
    h.status(0, "open");
    h.status(0, "reconnecting");
    h.advance(STALE_AFTER_MS + 5_000);
    h.status(0, "open");
    expect(h.stale).toEqual([{ reason: "disconnected", gapMs: STALE_AFTER_MS + 5_000 }]);
    // Once, not on every later open.
    h.status(0, "open");
    expect(h.stale).toHaveLength(1);
    channel.stop();
  });

  it("goes quiet for good when the server refuses", () => {
    const h = harness();
    const channel = h.create();
    channel.start();
    h.status(0, "closed");
    expect(channel.getState().status).toBe("closed");
    channel.stop();
  });

  it("closes the stream when the tab goes to the background and reopens it on return", () => {
    const h = harness();
    const channel = h.create();
    channel.start();
    h.status(0, "open");
    h.setVisible(false);
    expect(h.streams[0]?.closed).toBe(true);
    expect(channel.getState().status).toBe("paused");
    expect(h.open()).toHaveLength(0);
    h.advance(5_000);
    h.setVisible(true);
    expect(h.streams).toHaveLength(2);
    expect(h.open()).toHaveLength(1);
    expect(channel.getState().status).toBe("connecting");
    // A short stay in the background is covered by the snapshot of the new stream.
    expect(h.stale).toEqual([]);
    channel.stop();
  });

  it("asks the page to read again on return from a long time in the background", () => {
    const h = harness();
    const channel = h.create();
    channel.start();
    h.status(0, "open");
    h.setVisible(false);
    h.advance(STALE_AFTER_MS + 1);
    h.setVisible(true);
    expect(h.stale).toEqual([{ reason: "background", gapMs: STALE_AFTER_MS + 1 }]);
    channel.stop();
  });

  it("does not connect at all while the tab starts in the background", () => {
    const h = harness(false);
    const channel = h.create();
    channel.start();
    expect(h.streams).toHaveLength(0);
    expect(channel.getState().status).toBe("paused");
    h.setVisible(true);
    expect(h.streams).toHaveLength(1);
    channel.stop();
  });

  it("replaces a connection that is open but silent for far longer than the keep-alive", () => {
    const h = harness();
    const channel = h.create();
    channel.start();
    h.status(0, "open");
    h.advance(STALL_MS - WATCHDOG_MS);
    expect(h.streams).toHaveLength(1);
    h.advance(2 * WATCHDOG_MS);
    expect(h.streams).toHaveLength(2);
    expect(h.streams[0]?.closed).toBe(true);
    expect(channel.getState().status).toBe("reconnecting");
    channel.stop();
  });

  it("does not replace a connection that keeps sending keep-alives", () => {
    const h = harness();
    const channel = h.create();
    channel.start();
    h.status(0, "open");
    for (let i = 0; i < 12; i++) {
      h.advance(15_000);
      h.activity();
    }
    expect(h.streams).toHaveLength(1);
    channel.stop();
  });

  it("stops everything on stop: the stream, the watchdog, the visibility watch", () => {
    const h = harness();
    const channel = h.create();
    channel.start();
    h.status(0, "open");
    channel.stop();
    expect(h.streams[0]?.closed).toBe(true);
    h.advance(10 * STALL_MS);
    h.setVisible(false);
    h.setVisible(true);
    expect(h.streams).toHaveLength(1);
  });
});

describe("one connection per tab", () => {
  it("gives everybody who asks the same channel and so the same stream", () => {
    const h = harness();
    const first = acquireChannel("tenant-1", () => h.create());
    const second = acquireChannel("tenant-1", () => h.create());
    const third = acquireChannel("tenant-1", () => h.create());
    expect(second.channel).toBe(first.channel);
    expect(third.channel).toBe(first.channel);
    expect(h.streams).toHaveLength(1);
    first.release();
    second.release();
    // One holder is left: the connection stays.
    expect(h.open()).toHaveLength(1);
    third.release();
    expect(h.open()).toHaveLength(0);
  });

  it("a holder that releases twice does not take the others' connection with it", () => {
    const h = harness();
    const first = acquireChannel("tenant-1", () => h.create());
    const second = acquireChannel("tenant-1", () => h.create());
    first.release();
    first.release();
    expect(h.open()).toHaveLength(1);
    second.release();
    expect(h.open()).toHaveLength(0);
  });

  it("holds no stream of another tenant when the tenant changes", () => {
    const h = harness();
    const one = acquireChannel("tenant-1", () => h.create("tenant-1"));
    const two = acquireChannel("tenant-2", () => h.create("tenant-2"));
    expect(h.open()).toHaveLength(1);
    expect(h.open()[0]?.options.tenantId).toBe("tenant-2");
    one.release();
    two.release();
    expect(h.open()).toHaveLength(0);
  });

  it("opens a new connection after the last holder left", () => {
    const h = harness();
    acquireChannel("tenant-1", () => h.create()).release();
    const again = acquireChannel("tenant-1", () => h.create());
    expect(h.streams).toHaveLength(2);
    expect(h.open()).toHaveLength(1);
    again.release();
  });
});
