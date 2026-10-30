// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { enableActEnvironment, type Mounted, mount } from "@/features/updates/testing";

import { HOLD_MS, itemFromPve, type RunningItem, SAMPLE_EVERY_MS } from "./running-model.js";
import { type RunningSeries, useRunningSeries } from "./use-running.js";

/**
 * The throughput history the graphs buffer in the browser: the page looks at the runs that carry
 * no measurements every few seconds while its state is current and takes a point for each new
 * report, and starts over for another tenant.
 */

enableActEnvironment();

let mounted: Mounted | null = null;

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/** A guest whose node reported `bytesPerSecond` just now (the clock may be a fake one). */
function guest(id: string, bytesPerSecond: number): RunningItem {
  return itemFromPve({
    id,
    kind: "backup",
    guest: { id: `guest-${id}`, vmid: 100, name: id, kind: "vm" },
    jobName: null,
    startedAt: new Date().toISOString(),
    cancelling: false,
    progress: {
      bytesDone: 1000,
      bytesTotal: null,
      bytesUploaded: null,
      bytesPerSecond,
      at: new Date().toISOString(),
    },
  });
}

let latest: RunningSeries | null = null;

function Probe({ items, scope, fresh }: { items: RunningItem[]; scope: string; fresh: boolean }) {
  latest = useRunningSeries(items, scope, fresh);
  return null;
}

const pointsOf = (key: string) => latest?.points(key) ?? [];

describe("useRunningSeries", () => {
  it("takes a point for every new report, not for every look at the same one", async () => {
    vi.useFakeTimers();
    mounted = mount(<Probe items={[guest("a", 100)]} scope="t1" fresh />);
    // A run that appears is taken in at once.
    expect(pointsOf("pve:a")).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAMPLE_EVERY_MS * 3);
    });
    // The node said nothing new in between: still the one figure.
    expect(pointsOf("pve:a")).toHaveLength(1);
    await mounted.render(<Probe items={[guest("a", 100)]} scope="t1" fresh />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAMPLE_EVERY_MS);
    });
    expect(pointsOf("pve:a")).toHaveLength(2);
    expect(latest?.total.at(-1)?.bps).toBe(100);
    expect(latest?.hasData).toBe(true);
  });

  it("lets the total end when a node goes quiet, and has nothing to draw before any speed", async () => {
    vi.useFakeTimers();
    const silent = guest("a", 100);
    mounted = mount(<Probe items={[silent]} scope="t1" fresh />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAMPLE_EVERY_MS);
    });
    expect(latest?.total.at(-1)?.bps).toBe(100);
    // The same last report, long after: the run goes on in the list, its speed does not.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_MS + SAMPLE_EVERY_MS * 2);
    });
    expect(pointsOf("pve:a")).toHaveLength(1);
    expect(latest?.total.at(-1)?.bps).toBe(0);
    await mounted.render(<Probe items={[]} scope="t2" fresh />);
    expect(latest?.hasData).toBe(false);
  });

  it("draws nothing new while the state is not current, and picks up when it is again", async () => {
    vi.useFakeTimers();
    const items = [guest("a", 100)];
    mounted = mount(<Probe items={items} scope="t1" fresh={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAMPLE_EVERY_MS * 3);
    });
    expect(pointsOf("pve:a")).toHaveLength(0);
    expect(latest?.total.every((point) => point.bps === 0)).toBe(true);
    expect(latest?.hasData).toBe(false);
    await mounted.render(<Probe items={items} scope="t1" fresh />);
    expect(pointsOf("pve:a")).toHaveLength(1);
  });

  it("keeps what a run that ended did in the total for the window", async () => {
    vi.useFakeTimers();
    mounted = mount(<Probe items={[guest("a", 100), guest("b", 50)]} scope="t1" fresh />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAMPLE_EVERY_MS * 2);
    });
    // Both went on to be reported once more; then the first one ends.
    await mounted.render(<Probe items={[guest("a", 100), guest("b", 50)]} scope="t1" fresh />);
    await mounted.render(<Probe items={[guest("b", 50)]} scope="t1" fresh />);
    for (let beat = 0; beat < 9; beat++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SAMPLE_EVERY_MS);
      });
      await mounted.render(<Probe items={[guest("b", 50)]} scope="t1" fresh />);
    }
    const peak = Math.max(...(latest?.total.map((point) => point.bps) ?? [0]));
    expect(peak).toBe(150);
    expect(latest?.total.at(-1)?.bps).toBe(50);
  });

  it("starts over for another tenant", async () => {
    vi.useFakeTimers();
    mounted = mount(<Probe items={[guest("a", 100)]} scope="t1" fresh />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAMPLE_EVERY_MS * 2);
    });
    expect(pointsOf("pve:a")).toHaveLength(1);
    await mounted.render(<Probe items={[]} scope="t2" fresh />);
    expect(pointsOf("pve:a")).toHaveLength(0);
    expect(latest?.total.every((point) => point.bps === 0)).toBe(true);
  });

  it("stops sampling when the page goes away", async () => {
    vi.useFakeTimers();
    mounted = mount(<Probe items={[guest("a", 100)]} scope="t1" fresh />);
    await mounted.unmount();
    mounted = null;
    expect(vi.getTimerCount()).toBe(0);
  });
});
