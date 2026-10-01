import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import {
  RelativeTime,
  absoluteLabel,
  relativeLabel,
  subscribeMinuteClock,
  toDate,
} from "./relative-time.js";
import { render } from "./test-utils.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-23T12:00:00.000Z");

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("minute clock", () => {
  it("ticks just after each full minute with one shared timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 20_000);
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeMinuteClock(first);
    const stopSecond = subscribeMinuteClock(second);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(39_000);
    expect(first).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(first).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    stopFirst();
    expect(vi.getTimerCount()).toBe(1);
    stopSecond();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops when the last listener leaves during a tick", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const stop = subscribeMinuteClock(() => stop());
    vi.advanceTimersByTime(61_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("relativeLabel", () => {
  it("reads past and future times in the UI language", () => {
    expect(relativeLabel(new Date(NOW - 2 * HOUR), NOW, "en")).toBe("2 hours ago");
    expect(relativeLabel(new Date(NOW - 2 * HOUR), NOW, "de")).toBe("vor 2 Stunden");
    expect(relativeLabel(new Date(NOW + 72 * HOUR), NOW, "en")).toBe("in 3 days");
  });

  it("leaves the last seconds to 'just now'", () => {
    expect(relativeLabel(new Date(NOW - 30_000), NOW, "en")).toBeNull();
    expect(relativeLabel(new Date(NOW - 90_000), NOW, "en")).toBe("2 minutes ago");
  });
});

describe("toDate and absoluteLabel", () => {
  it("accepts ISO strings and dates, and rejects the rest", () => {
    expect(toDate("2026-09-23T12:00:00Z")?.getTime()).toBe(NOW);
    expect(toDate(new Date(NOW))?.getTime()).toBe(NOW);
    expect(toDate("yesterday")).toBeNull();
    expect(toDate("")).toBeNull();
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
  });

  it("formats the absolute time with date and seconds", () => {
    const label = absoluteLabel(new Date(NOW), "en");
    expect(label).toContain("2026");
    expect(label).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });
});

describe("RelativeTime", () => {
  it("renders a focusable <time dateTime> with the relative label", () => {
    const value = new Date(Date.now() - 3 * HOUR).toISOString();
    const html = render(<RelativeTime value={value} />);
    expect(html).toContain(`<time dateTime="${value}"`);
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("3 hours ago");
  });

  it("can leave the tab order and then carries the absolute time as text", () => {
    const date = new Date(Date.now() - 3 * HOUR);
    const html = render(<RelativeTime value={date} focusable={false} />);
    expect(html).toContain(`<time dateTime="${date.toISOString()}"`);
    expect(html).not.toContain("tabindex");
    expect(html).toContain(`<span class="sr-only"> (${absoluteLabel(date, "en")})</span>`);
    // The focusable default keeps the absolute time in the tooltip only.
    expect(render(<RelativeTime value={date} />)).not.toContain("sr-only");
  });

  it("says 'just now' for the last seconds", () => {
    const html = render(<RelativeTime value={new Date(Date.now() - 5_000)} />);
    expect(html).toContain("just now");
  });

  it("says 'Never' for a missing timestamp, without a time element", () => {
    for (const value of [null, undefined, ""]) {
      const html = render(<RelativeTime value={value} />);
      expect(html).toContain("Never");
      expect(html).not.toContain("<time");
    }
    expect(render(<RelativeTime value={null} fallback="Not yet run" />)).toContain("Not yet run");
  });

  it("says 'Unknown' for a timestamp it cannot read", () => {
    const html = render(<RelativeTime value="not a date" />);
    expect(html).toContain("Unknown");
    expect(html).not.toContain("<time");
  });

  it("follows the UI language", async () => {
    await i18n.changeLanguage("de");
    try {
      const html = render(<RelativeTime value={null} />);
      expect(html).toContain("Nie");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
