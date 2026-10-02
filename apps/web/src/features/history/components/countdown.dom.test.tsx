// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { enableActEnvironment, installMemoryStorage, mount } from "@/features/updates/testing";
import { i18n } from "@/i18n";

import "../i18n";
import { secondClockListeners } from "../live/clock";
import { Countdown } from "./countdown";

/** A coming moment counts down on the browser's own clock, within the hour, and stops listening after. */

enableActEnvironment();

let mounted: ReturnType<typeof mount> | null = null;

beforeAll(async () => {
  installMemoryStorage();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const NOW = Date.parse("2026-10-02T10:00:00.000Z");
const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();

async function show(target: string) {
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
  });
  vi.setSystemTime(NOW);
  mounted = mount(
    <TooltipProvider>
      <Countdown at={target} />
    </TooltipProvider>,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5);
  });
}

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe("Countdown", () => {
  it("counts down in minutes and seconds when the moment is within the hour, once a second", async () => {
    await show(at(17 * 60 + 42));
    const time = () => document.querySelector("time");
    expect(time()?.textContent).toBe("in 17:42");
    await tick(1000);
    expect(time()?.textContent).toBe("in 17:41");
    await tick(60_000);
    expect(time()?.textContent).toBe("in 16:41");
    expect(time()?.getAttribute("dateTime")).toBe(at(17 * 60 + 42));
    expect(time()?.className).toContain("font-mono");
  });

  it("says the usual relative time beyond an hour, and does not tick for it", async () => {
    await show(at(3 * 3600));
    expect(document.querySelector("time")?.textContent).toMatch(/in 3 hours/);
    expect(secondClockListeners()).toBe(0);
  });

  it("goes back to the relative time once the moment is reached", async () => {
    await show(at(3));
    expect(document.querySelector("time")?.textContent).toBe("in 0:03");
    await tick(4000);
    // The countdown ended: the time is a past one now, until the server sends the next.
    expect(document.querySelector("time")?.textContent).not.toMatch(/^in \d/);
  });

  it("stops the clock when it is gone", async () => {
    await show(at(600));
    expect(secondClockListeners()).toBe(1);
    await mounted?.unmount();
    mounted = null;
    expect(secondClockListeners()).toBe(0);
  });
});
