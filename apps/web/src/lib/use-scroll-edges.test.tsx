// @vitest-environment happy-dom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeScrollEdges, pinnedInset, useScrollEdges } from "./use-scroll-edges";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("computeScrollEdges", () => {
  it("has no edges while everything fits", () => {
    expect(computeScrollEdges({ scrollLeft: 0, scrollWidth: 600, clientWidth: 600 })).toEqual({
      scrolled: false,
      more: false,
      scrollable: false,
    });
  });

  it("reports more content on the right at the start of a wide table", () => {
    expect(computeScrollEdges({ scrollLeft: 0, scrollWidth: 1200, clientWidth: 600 })).toEqual({
      scrolled: false,
      more: true,
      scrollable: true,
    });
  });

  it("is scrolled with more to come in the middle", () => {
    expect(computeScrollEdges({ scrollLeft: 200, scrollWidth: 1200, clientWidth: 600 })).toEqual({
      scrolled: true,
      more: true,
      scrollable: true,
    });
  });

  it("drops the fade at the far end but keeps the pinned shadow", () => {
    expect(computeScrollEdges({ scrollLeft: 600, scrollWidth: 1200, clientWidth: 600 })).toEqual({
      scrolled: true,
      more: false,
      scrollable: true,
    });
  });

  it("tolerates the sub-pixel rounding browsers report at the end", () => {
    const edges = computeScrollEdges({
      scrollLeft: 599.5,
      scrollWidth: 1200,
      clientWidth: 600,
    });
    expect(edges.more).toBe(false);
  });

  it("ignores a one pixel overflow", () => {
    expect(computeScrollEdges({ scrollLeft: 0, scrollWidth: 601, clientWidth: 600 }).more).toBe(
      false,
    );
  });

  it("counts a negative scrollLeft (right-to-left layouts) by its magnitude", () => {
    const edges = computeScrollEdges({ scrollLeft: -300, scrollWidth: 1200, clientWidth: 600 });
    expect(edges).toEqual({ scrolled: true, more: true, scrollable: true });
  });

  it("is scrollable when it only overflows vertically", () => {
    const edges = computeScrollEdges({
      scrollLeft: 0,
      scrollWidth: 600,
      clientWidth: 600,
      scrollHeight: 900,
      clientHeight: 400,
    });
    expect(edges).toEqual({ scrolled: false, more: false, scrollable: true });
  });
});

function headerCell(left: number, width: number, position = "sticky"): HTMLElement {
  const cell = document.createElement("th");
  cell.setAttribute("data-pinned", "left");
  cell.style.position = position;
  cell.style.left = `${left}px`;
  Object.defineProperty(cell, "offsetWidth", { configurable: true, value: width });
  return cell;
}

/** Attached to the document: computed styles of a detached element are empty. */
function tableWith(...cells: HTMLElement[]): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = "<table><thead><tr></tr></thead></table>";
  container.querySelector("tr")?.append(...cells);
  document.body.appendChild(container);
  attached.push(container);
  return container;
}

const attached: HTMLElement[] = [];

describe("pinnedInset", () => {
  it("is zero without pinned columns", () => {
    expect(pinnedInset(tableWith())).toBe(0);
  });

  it("reaches to the right edge of one pinned column", () => {
    expect(pinnedInset(tableWith(headerCell(0, 288)))).toBe(288);
  });

  it("reaches to the right edge of the last of two pinned columns", () => {
    expect(pinnedInset(tableWith(headerCell(0, 192), headerCell(192, 155)))).toBe(347);
  });

  it("leaves out a pinned column that scrolls along (a second one on a phone)", () => {
    expect(pinnedInset(tableWith(headerCell(0, 180), headerCell(192, 155, "static")))).toBe(180);
  });

  it("ignores cells that are not pinned", () => {
    const plain = document.createElement("th");
    expect(pinnedInset(tableWith(plain, headerCell(0, 100)))).toBe(100);
  });
});

/** Stands in for layout, which happy-dom does not compute. */
function setMetrics(
  node: HTMLElement,
  metrics: { scrollWidth: number; clientWidth: number; scrollLeft?: number },
): void {
  for (const [key, value] of Object.entries(metrics)) {
    Object.defineProperty(node, key, { configurable: true, writable: true, value });
  }
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let resizeCallbacks: (() => void)[] = [];

class FakeResizeObserver {
  constructor(private readonly callback: () => void) {
    resizeCallbacks.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    resizeCallbacks = resizeCallbacks.filter((callback) => callback !== this.callback);
  }
}

function Probe() {
  const { ref, scrolled, more, scrollable } = useScrollEdges<HTMLDivElement>();
  return (
    <div
      ref={ref}
      id="scroller"
      data-scrolled={String(scrolled)}
      data-more={String(more)}
      data-scrollable={String(scrollable)}
    >
      <table>
        <tbody />
      </table>
    </div>
  );
}

async function mount(): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // The element is measured as it mounts: give the next one its size first.
  await act(async () => {
    root?.render(<Probe />);
  });
  const scroller = host.querySelector<HTMLElement>("#scroller");
  if (!scroller) {
    throw new Error("probe did not render");
  }
  return scroller;
}

beforeEach(() => {
  resizeCallbacks = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  for (const element of attached.splice(0)) {
    element.remove();
  }
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe("useScrollEdges", () => {
  it("starts without edges and follows scrolling", async () => {
    const scroller = await mount();
    expect(scroller.dataset.more).toBe("false");

    setMetrics(scroller, { scrollWidth: 1200, clientWidth: 600, scrollLeft: 0 });
    await act(async () => {
      for (const callback of resizeCallbacks) {
        callback();
      }
    });
    expect(scroller.dataset).toMatchObject({ more: "true", scrolled: "false", scrollable: "true" });

    setMetrics(scroller, { scrollWidth: 1200, clientWidth: 600, scrollLeft: 120 });
    await act(async () => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(scroller.dataset).toMatchObject({ more: "true", scrolled: "true" });

    setMetrics(scroller, { scrollWidth: 1200, clientWidth: 600, scrollLeft: 600 });
    await act(async () => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(scroller.dataset).toMatchObject({ more: "false", scrolled: "true" });
  });

  it("notices when the content stops overflowing after a resize", async () => {
    const scroller = await mount();
    setMetrics(scroller, { scrollWidth: 1200, clientWidth: 600, scrollLeft: 0 });
    await act(async () => {
      for (const callback of resizeCallbacks) {
        callback();
      }
    });
    expect(scroller.dataset.scrollable).toBe("true");

    setMetrics(scroller, { scrollWidth: 600, clientWidth: 900, scrollLeft: 0 });
    await act(async () => {
      for (const callback of resizeCallbacks) {
        callback();
      }
    });
    expect(scroller.dataset).toMatchObject({
      more: "false",
      scrolled: "false",
      scrollable: "false",
    });
  });

  it("stops watching when the container goes away", async () => {
    await mount();
    expect(resizeCallbacks.length).toBeGreaterThan(0);
    await act(async () => {
      root?.unmount();
    });
    root = null;
    expect(resizeCallbacks).toHaveLength(0);
  });
});
