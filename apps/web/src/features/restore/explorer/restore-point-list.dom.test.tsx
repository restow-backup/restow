// @vitest-environment happy-dom
import { type ReactNode, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import type { ListedSnapshot } from "../api.js";
import { RestorePointList } from "./restore-point-list.js";

// `page-context.test.tsx` explains why this is needed: React only flushes
// effects synchronously inside `act` when it knows a test renderer is driving
// it, and nothing else in this workspace sets the flag.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function point(sequence: number, day: number, objectId = "o1"): ListedSnapshot {
  const at = `2026-09-${String(day).padStart(2, "0")}T10:00:00.000Z`;
  return {
    id: `${objectId}-p${sequence}`,
    objectId,
    sequence,
    itemCount: 10,
    byteSize: 1024,
    startedAt: at,
    completedAt: at,
    createdAt: at,
    verification: { state: "green", checkedAt: at, reportId: `r${sequence}` },
  };
}

/** Newest first, as the API lists them: #4 is the newest, #1 the oldest. */
const points = [point(4, 22), point(3, 21), point(2, 20), point(1, 19)];
const otherAccount = [point(2, 21, "o2"), point(1, 20, "o2")];

describe("RestorePointList in the DOM", () => {
  let container: HTMLElement;
  let root: Root;
  const onChange = vi.fn();
  const scrollIntoView = vi.fn();

  function mount(node: ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    render(node);
  }

  function render(node: ReactNode) {
    act(() => {
      root.render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
    });
  }

  function list(restorePoints: readonly ListedSnapshot[], value: string | null) {
    return (
      <RestorePointList
        restorePoints={restorePoints}
        loading={false}
        value={value}
        onChange={onChange}
      />
    );
  }

  function marker(sequence: number): HTMLButtonElement {
    const found = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(`Restore point #${sequence} `),
    );
    if (!found) {
      throw new Error(`no marker for restore point #${sequence}`);
    }
    return found;
  }

  function press(key: string, init: KeyboardEventInit = {}) {
    const target = document.activeElement ?? container;
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
      );
    });
  }

  /** What each scrollIntoView call was aimed at and how. */
  function scrolls() {
    return scrollIntoView.mock.calls.map((call, index) => ({
      target: scrollIntoView.mock.contexts[index] as HTMLButtonElement,
      options: call[0] as ScrollIntoViewOptions,
    }));
  }

  beforeEach(() => {
    // happy-dom lays nothing out and has no `scrollIntoView`; a real browser
    // always has one, so this only fills in what the test DOM is missing.
    (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView = scrollIntoView;
    // Run the frame the animated centring waits for right away.
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) => ({ matches: false, media: query }) as MediaQueryList,
    );
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    onChange.mockClear();
    scrollIntoView.mockClear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("centring", () => {
    it("centres the newest restore point when the explorer opens, without animating", () => {
      mount(list(points, "o1-p4"));
      const [first, ...rest] = scrolls();
      expect(rest).toHaveLength(0);
      expect(first?.target).toBe(marker(4));
      expect(first?.options).toEqual({ inline: "center", block: "nearest", behavior: "auto" });
    });

    it("never scrolls the page vertically to reveal the bar", () => {
      mount(list(points, "o1-p4"));
      expect(scrolls().every(({ options }) => options.block === "nearest")).toBe(true);
    });

    it("centres the restore point that gets selected, smoothly", () => {
      mount(list(points, "o1-p4"));
      scrollIntoView.mockClear();
      render(list(points, "o1-p2"));
      const [move, ...rest] = scrolls();
      expect(rest).toHaveLength(0);
      expect(move?.target).toBe(marker(2));
      expect(move?.options).toEqual({ inline: "center", block: "nearest", behavior: "smooth" });
    });

    it("moves instantly for a person who asked for reduced motion", () => {
      vi.spyOn(window, "matchMedia").mockImplementation(
        (query) =>
          ({ matches: query.includes("prefers-reduced-motion"), media: query }) as MediaQueryList,
      );
      mount(list(points, "o1-p4"));
      scrollIntoView.mockClear();
      render(list(points, "o1-p1"));
      expect(scrolls().map(({ target }) => target)).toEqual([marker(1)]);
      expect(scrolls()[0]?.options.behavior).toBe("auto");
    });

    it("snaps instead of gliding when the restore point is many screens away", () => {
      mount(list(points, "o1-p4"));
      const track = container.querySelector("ul") as HTMLUListElement;
      // happy-dom lays nothing out: give the track a width and the markers a place in it.
      Object.defineProperty(track, "clientWidth", { value: 1000 });
      Object.defineProperty(marker(1), "offsetLeft", { value: 9000 });
      Object.defineProperty(marker(2), "offsetLeft", { value: 1200 });

      scrollIntoView.mockClear();
      render(list(points, "o1-p1"));
      expect(scrolls().map(({ options }) => options.behavior)).toEqual(["auto"]);

      scrollIntoView.mockClear();
      render(list(points, "o1-p2"));
      expect(scrolls().map(({ options }) => options.behavior)).toEqual(["smooth"]);
    });

    it("snaps to the newest restore point of another account instead of animating across lists", () => {
      mount(list(points, "o1-p4"));
      scrollIntoView.mockClear();
      render(list(otherAccount, "o2-p2"));
      const [move] = scrolls();
      expect(move?.target).toBe(marker(2));
      expect(move?.options.behavior).toBe("auto");
    });

    it("does not scroll again when only the list refreshes and the selection stays", () => {
      mount(list(points, "o1-p3"));
      scrollIntoView.mockClear();
      render(list([point(5, 23), ...points], "o1-p3"));
      expect(scrolls()).toHaveLength(0);
    });
  });

  describe("keyboard", () => {
    it("moves focus one restore point to the left (older) and right (newer)", () => {
      mount(list(points, "o1-p3"));
      act(() => marker(3).focus());
      press("ArrowLeft");
      expect(document.activeElement).toBe(marker(2));
      press("ArrowRight");
      expect(document.activeElement).toBe(marker(3));
      press("ArrowRight");
      expect(document.activeElement).toBe(marker(4));
    });

    it("stops at both ends instead of wrapping around", () => {
      mount(list(points, "o1-p4"));
      act(() => marker(4).focus());
      press("ArrowRight");
      expect(document.activeElement).toBe(marker(4));
      act(() => marker(1).focus());
      press("ArrowLeft");
      expect(document.activeElement).toBe(marker(1));
    });

    it("jumps to the oldest with Home and to the newest with End", () => {
      mount(list(points, "o1-p3"));
      act(() => marker(3).focus());
      press("Home");
      expect(document.activeElement).toBe(marker(1));
      press("End");
      expect(document.activeElement).toBe(marker(4));
    });

    it("keeps the roving tabindex on the focused restore point", () => {
      mount(list(points, "o1-p3"));
      expect(marker(3).tabIndex).toBe(0);
      act(() => marker(3).focus());
      press("Home");
      expect(marker(1).tabIndex).toBe(0);
      expect(marker(3).tabIndex).toBe(-1);
    });

    it("centres the restore point it moves focus to, but does not select it", () => {
      mount(list(points, "o1-p3"));
      act(() => marker(3).focus());
      scrollIntoView.mockClear();
      press("ArrowLeft");
      expect(scrolls().map(({ target }) => target)).toEqual([marker(2)]);
      expect(scrolls()[0]?.options).toEqual({
        inline: "center",
        block: "nearest",
        behavior: "smooth",
      });
      expect(onChange).not.toHaveBeenCalled();
    });

    it("selects the focused restore point on activation", () => {
      mount(list(points, "o1-p3"));
      act(() => marker(3).focus());
      press("ArrowLeft");
      act(() => marker(2).click());
      expect(onChange).toHaveBeenCalledExactlyOnceWith("o1-p2");
    });

    it("leaves shortcuts with a modifier key alone", () => {
      mount(list(points, "o1-p3"));
      act(() => marker(3).focus());
      press("ArrowLeft", { ctrlKey: true });
      press("Home", { metaKey: true });
      expect(document.activeElement).toBe(marker(3));
    });

    it("ignores unrelated keys", () => {
      mount(list(points, "o1-p3"));
      act(() => marker(3).focus());
      press("a");
      expect(document.activeElement).toBe(marker(3));
    });
  });

  describe("announcement", () => {
    it("names the selected restore point as current for assistive technology", () => {
      mount(list(points, "o1-p3"));
      const selected = container.querySelector('[aria-current="true"]');
      expect(selected).toBe(marker(3));
      expect(selected?.textContent).toContain("Restore point #3 from");
      expect(selected?.textContent).toContain("Current");
      expect(container.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    });
  });
});
