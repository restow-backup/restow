import type { EventStreamHandle, EventStreamOptions, ServerEvent } from "@/features/jobs/sse";
import type { StreamStatus } from "@/features/jobs/sse";

import { LIVE_PATH } from "../api";

/**
 * The live channel of one browser tab: a single event stream with everything that moves in the
 * active tenant, kept open while the tab is in front and reopened, with a fresh snapshot, when
 * it comes back. The stream itself (reading, parsing, reconnecting with backoff) is
 * `openEventStream`; this is what sits around it:
 *
 *   - one connection per tab: `acquireChannel` hands the same channel to everybody who asks
 *   - a tab in the background closes it (Page Visibility) and the page reads again on return
 *   - a connection that carries nothing for a long time (a proxy that buffers) is replaced
 *   - the state the interface shows, honestly: connecting, live, not connected and retrying,
 *     paused in the background, or off for good (the server refused)
 *
 * Framework-free and driven by injected clocks and a stream opener, so the reconnect, pause
 * and stall rules are tested without a browser.
 */

export type LiveStatus = "connecting" | "open" | "reconnecting" | "closed" | "paused";

export interface LiveState {
  status: LiveStatus;
  /** When the server last sent anything, a keep-alive included (epoch ms); null before the first. */
  lastActivityAt: number | null;
}

export interface VisibilitySource {
  isVisible(): boolean;
  /** Called when the tab goes to the background or comes back; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export interface ChannelDeps {
  open(options: EventStreamOptions): EventStreamHandle;
  now(): number;
  visibility: VisibilitySource;
  /** Check the connection for a stall this often. */
  watchdogMs?: number;
  /** A connection that sent nothing for this long is replaced. The server speaks at least every 15 s. */
  stallMs?: number;
}

export interface ChannelCallbacks {
  onEvent(event: ServerEvent): void;
  /**
   * The page has to read again: it was in the background, or the connection was lost, for longer
   * than the stream's own window reaches back. Not called for a short gap the snapshot covers.
   */
  onStale(reason: "background" | "disconnected", gapMs: number): void;
}

/** A gap shorter than this needs no refetch: the stream's snapshot reaches back a minute. */
export const STALE_AFTER_MS = 20_000;
export const STALL_MS = 45_000;
export const WATCHDOG_MS = 5_000;

export class LiveChannel {
  private handle: EventStreamHandle | null = null;
  private state: LiveState = { status: "connecting", lastActivityAt: null };
  private readonly listeners = new Set<() => void>();
  private unsubscribeVisibility: (() => void) | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private hiddenAt: number | null = null;
  private lostAt: number | null = null;
  private started = false;

  constructor(
    readonly tenantId: string,
    private readonly deps: ChannelDeps,
    private readonly callbacks: ChannelCallbacks,
  ) {}

  /** The state, as `useSyncExternalStore` wants it: the same object until something changes. */
  getState = (): LiveState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<LiveState>): void {
    const next = { ...this.state, ...patch };
    if (next.status === this.state.status && next.lastActivityAt === this.state.lastActivityAt) {
      return;
    }
    this.state = next;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.unsubscribeVisibility = this.deps.visibility.subscribe(() => this.onVisibility());
    this.watchdog = setInterval(() => this.checkStall(), this.deps.watchdogMs ?? WATCHDOG_MS);
    if (this.deps.visibility.isVisible()) {
      this.connect();
    } else {
      this.hiddenAt = this.deps.now();
      this.set({ status: "paused" });
    }
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.unsubscribeVisibility?.();
    this.unsubscribeVisibility = null;
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    this.disconnect();
  }

  private connect(): void {
    this.disconnect();
    this.set({ status: "connecting" });
    this.handle = this.deps.open({
      path: LIVE_PATH,
      tenantId: this.tenantId,
      onEvent: (event) => this.callbacks.onEvent(event),
      onActivity: () => this.set({ lastActivityAt: this.deps.now() }),
      onStatus: (status) => this.onStatus(status),
    });
  }

  private disconnect(): void {
    this.handle?.close();
    this.handle = null;
  }

  private onStatus(status: StreamStatus): void {
    if (status === "open") {
      const lost = this.lostAt;
      this.lostAt = null;
      this.set({ status: "open", lastActivityAt: this.deps.now() });
      if (lost !== null) {
        const gap = this.deps.now() - lost;
        if (gap > STALE_AFTER_MS) {
          this.callbacks.onStale("disconnected", gap);
        }
      }
      return;
    }
    if (status === "reconnecting") {
      this.lostAt ??= this.deps.now();
    }
    this.set({ status });
  }

  private onVisibility(): void {
    if (!this.started) {
      return;
    }
    if (!this.deps.visibility.isVisible()) {
      // Nobody is looking: stop the requests, keep what is loaded.
      this.hiddenAt ??= this.deps.now();
      this.disconnect();
      this.set({ status: "paused" });
      return;
    }
    const hiddenAt = this.hiddenAt;
    this.hiddenAt = null;
    this.lostAt = null;
    this.connect();
    if (hiddenAt !== null) {
      const gap = this.deps.now() - hiddenAt;
      if (gap > STALE_AFTER_MS) {
        this.callbacks.onStale("background", gap);
      }
    }
  }

  private checkStall(): void {
    const { lastActivityAt, status } = this.state;
    if (status !== "open" || lastActivityAt === null) {
      return;
    }
    if (this.deps.now() - lastActivityAt > (this.deps.stallMs ?? STALL_MS)) {
      // Open but silent for far longer than the server's keep-alive: something between buffers or dropped it.
      this.lostAt ??= this.deps.now();
      this.connect();
      this.set({ status: "reconnecting" });
    }
  }
}

// --- One connection per tab -------------------------------------------------------------------

interface Entry {
  channel: LiveChannel;
  references: number;
}

const channels = new Map<string, Entry>();

export interface ChannelHandle {
  channel: LiveChannel;
  /** Give the channel back; the last one to do so closes the connection. */
  release(): void;
}

/**
 * The channel of a tenant, created on the first request and shared after that, however many
 * parts of the page ask: a tab never holds a second stream.
 */
export function acquireChannel(tenantId: string, create: () => LiveChannel): ChannelHandle {
  let entry = channels.get(tenantId);
  if (!entry) {
    // Only one tenant is live at a time: a channel of another tenant would be a second stream.
    for (const [other, existing] of channels) {
      existing.channel.stop();
      channels.delete(other);
    }
    entry = { channel: create(), references: 0 };
    channels.set(tenantId, entry);
  }
  entry.references++;
  entry.channel.start();
  const held = entry;
  let released = false;
  return {
    channel: held.channel,
    release() {
      if (released) {
        return;
      }
      released = true;
      held.references--;
      if (held.references <= 0) {
        held.channel.stop();
        if (channels.get(tenantId) === held) {
          channels.delete(tenantId);
        }
      }
    },
  };
}

/** Test helper: forget every channel (a test that ended mid-way). */
export function resetChannelsForTesting(): void {
  for (const entry of channels.values()) {
    entry.channel.stop();
  }
  channels.clear();
}

/** Page Visibility of the document. */
export const documentVisibility: VisibilitySource = {
  isVisible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
  subscribe(listener) {
    if (typeof document === "undefined") {
      return () => undefined;
    }
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};
