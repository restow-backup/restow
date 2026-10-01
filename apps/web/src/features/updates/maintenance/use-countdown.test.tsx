// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NOW, enableActEnvironment, iso } from "../testing";
import { msUntilNextTick, nextStage, stageFor, useCountdown } from "./use-countdown";

enableActEnvironment();

function Probe({ startsAt, offsetMs }: { startsAt: string | null; offsetMs: number }) {
  const remaining = useCountdown(startsAt, offsetMs);
  return <output data-testid="remaining">{remaining === null ? "none" : String(remaining)}</output>;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const shown = () => container.querySelector("output")?.textContent;

async function render(startsAt: string | null, offsetMs = 0) {
  await act(async () => {
    root.render(<Probe startsAt={startsAt} offsetMs={offsetMs} />);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("msUntilNextTick", () => {
  it("aims just after the moment the shown number changes", () => {
    const startsAt = iso(10);
    // Exactly 10 s left: the number becomes 9 as soon as one millisecond has passed.
    expect(msUntilNextTick(startsAt, NOW, 0)).toBe(20 + 1000);
    // 9.5 s left: the number becomes 9 after 0.5 s.
    expect(msUntilNextTick(startsAt, NOW + 500, 0)).toBe(500 + 20);
    expect(msUntilNextTick(startsAt, NOW + 10_000, 0)).toBeNull();
    expect(msUntilNextTick(startsAt, NOW + 20_000, 0)).toBeNull();
    expect(msUntilNextTick("junk", NOW, 0)).toBeNull();
  });
});

describe("useCountdown", () => {
  it("counts down once a second", async () => {
    await render(iso(272));
    expect(shown()).toBe("272");
    await advance(1100);
    expect(shown()).toBe("271");
    await advance(1000);
    expect(shown()).toBe("270");
    await advance(60_000);
    expect(shown()).toBe("210");
  });

  it("corrects a browser clock that is off: the server's time is the reference", async () => {
    // The browser is an hour behind the server; the update starts in 272 s on the server's clock.
    vi.setSystemTime(NOW - 3_600_000);
    await render(iso(272), 3_600_000);
    expect(shown()).toBe("272");
    await advance(2100);
    expect(shown()).toBe("270");

    // A browser an hour ahead behaves the same.
    vi.setSystemTime(NOW + 3_600_000);
    await render(iso(100), -3_600_000);
    expect(shown()).toBe("100");
  });

  it("ends at zero and stays there", async () => {
    await render(iso(3));
    expect(shown()).toBe("3");
    await advance(3100);
    expect(shown()).toBe("0");
    await advance(60_000);
    expect(shown()).toBe("0");
    // No timer is left running once it reached zero.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts at zero for a start time in the past, and reports nothing without one", async () => {
    await render(iso(-30));
    expect(shown()).toBe("0");
    await render(null);
    expect(shown()).toBe("none");
  });

  it("follows a new start time", async () => {
    await render(iso(60));
    await advance(5100);
    expect(shown()).toBe("55");
    await render(iso(600));
    expect(shown()).toBe("595");
  });
});

describe("the announcement stages", () => {
  it("map the remaining time to what a screen reader hears", () => {
    expect(stageFor(null)).toBe("start");
    expect(stageFor(3600)).toBe("start");
    expect(stageFor(61)).toBe("start");
    expect(stageFor(60)).toBe("minute");
    expect(stageFor(11)).toBe("minute");
    expect(stageFor(10)).toBe("seconds");
    expect(stageFor(1)).toBe("seconds");
    expect(stageFor(0)).toBe("starting");
  });

  it("only ever move forward", () => {
    expect(nextStage("start", 300)).toBe("start");
    expect(nextStage("start", 60)).toBe("minute");
    expect(nextStage("minute", 30)).toBe("minute");
    expect(nextStage("minute", 10)).toBe("seconds");
    expect(nextStage("seconds", 5)).toBe("seconds");
    expect(nextStage("seconds", 0)).toBe("starting");
    // A start time pushed back does not announce the earlier stage again.
    expect(nextStage("seconds", 300)).toBe("seconds");
    expect(nextStage("starting", 300)).toBe("starting");
  });
});
