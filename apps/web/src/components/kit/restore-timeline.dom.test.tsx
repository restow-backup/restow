// @vitest-environment happy-dom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import { RestoreTimeline } from "./restore-timeline.js";

/**
 * The restore point timeline: newest first under day separators (Today,
 * Yesterday, then weekday and date), the time of each restore point, the
 * selected one marked, one Tab stop with arrow keys among the rest, and a
 * jump to a date that lands on the nearest earlier day with restore points.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Point {
  id: string;
  time: string;
}

const local = (month: number, day: number, hour: number, minute: number) =>
  new Date(2026, month - 1, day, hour, minute).toISOString();

const POINTS: Point[] = [
  { id: "sep28", time: local(9, 28, 7, 5) },
  { id: "today-early", time: local(10, 3, 8, 0) },
  { id: "yesterday", time: local(10, 2, 22, 30) },
  { id: "today-late", time: local(10, 3, 9, 15) },
];

const idOf = (point: Point) => point.id;
const timeOf = (point: Point) => point.time;

let container: HTMLDivElement;
let root: Root;
const onSelect = vi.fn();

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function render(selectedId: string | null = null) {
  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <RestoreTimeline
          items={POINTS}
          idOf={idOf}
          timeOf={timeOf}
          selectedId={selectedId}
          onSelect={onSelect}
          renderDetails={(point) => <span data-detail>{point.id}</span>}
          label="Restore points of web-01"
        />
      </I18nextProvider>,
    );
    await flush();
  });
}

function entries(): HTMLButtonElement[] {
  return [
    ...container.querySelectorAll<HTMLButtonElement>('[data-slot="restore-timeline"] li button'),
  ];
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 3, 12, 0));
  onSelect.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("RestoreTimeline", () => {
  it("groups the restore points by day, newest first, with their times", async () => {
    await render();
    const days = [...container.querySelectorAll('[data-slot="timeline-day"]')].map(
      (heading) => heading.textContent ?? "",
    );
    expect(days).toHaveLength(3);
    expect(days[0]).toMatch(/^Today/);
    expect(days[0]).toContain("2 restore points");
    expect(days[1]).toMatch(/^Yesterday/);
    expect(days[2]).toContain("Monday, September 28");
    expect(days[2]).not.toContain("2026");
    expect(entries().map((button) => button.querySelector("[data-detail]")?.textContent)).toEqual([
      "today-late",
      "today-early",
      "yesterday",
      "sep28",
    ]);
    expect(
      [...container.querySelectorAll('[data-slot="timeline-time"]')].map(
        (time) => time.textContent,
      ),
    ).toEqual(["09:15", "08:00", "22:30", "07:05"]);
    expect(container.textContent).toContain("4 restore points");
  });

  it("marks the selected restore point and reports a click", async () => {
    await render("yesterday");
    const selected = entries().filter((button) => button.getAttribute("aria-current") === "true");
    expect(selected.map((button) => button.textContent)).toEqual(["22:30yesterday"]);
    await act(async () => {
      entries()[3]?.click();
    });
    expect(onSelect).toHaveBeenCalledWith(POINTS[0]);
  });

  it("is one Tab stop, and the arrow keys, Home and End move among the restore points", async () => {
    await render("yesterday");
    const stops = () => entries().filter((button) => button.tabIndex === 0);
    expect(stops().map((button) => button.textContent)).toEqual(["22:30yesterday"]);

    const press = async (key: string) => {
      await act(async () => {
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
    };
    act(() => stops()[0]?.focus());
    await press("ArrowDown");
    expect(document.activeElement?.textContent).toBe("07:05sep28");
    await press("ArrowDown");
    expect(document.activeElement?.textContent).toBe("07:05sep28");
    await press("Home");
    expect(document.activeElement?.textContent).toBe("09:15today-late");
    await press("ArrowUp");
    expect(document.activeElement?.textContent).toBe("09:15today-late");
    await press("End");
    expect(document.activeElement?.textContent).toBe("07:05sep28");
    expect(stops()).toHaveLength(1);
  });

  it("jumps to the nearest earlier day with restore points and says so", async () => {
    await render();
    const trigger = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Jump to date"),
    );
    await act(async () => {
      trigger?.click();
      await flush();
    });
    const october1 = document.querySelector<HTMLButtonElement>(
      `[data-slot="timeline-calendar"] button[data-day="${new Date(2026, 9, 1).toLocaleDateString()}"]`,
    );
    expect(october1).not.toBeNull();
    await act(async () => {
      october1?.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(container.querySelector("[aria-live]")?.textContent).toBe(
      "No restore point on Thursday, October 1. Showing Monday, September 28, the nearest earlier day.",
    );
    expect(document.activeElement?.textContent).toBe("07:05sep28");
    expect(onSelect).not.toHaveBeenCalled();
  });
});
