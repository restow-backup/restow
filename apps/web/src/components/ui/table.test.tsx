// @vitest-environment happy-dom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import {
  PIN_FIRST,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  type TablePin,
  TableRow,
  pinnedCell,
} from "./table";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("pinnedCell", () => {
  it("pins the first column to the left edge, opaque and above the other cells", () => {
    const { className, style } = pinnedCell(PIN_FIRST, "cell");
    expect(style.left).toBe(0);
    expect(className).toContain("sticky");
    expect(className).toContain("z-5");
    // Opaque: the surface plus the row's own tint, never a translucent colour.
    expect(className).toContain("var(--table-surface,var(--card))");
    expect(className).toContain("var(--row-mix,0%)");
  });

  it("puts the head of a pinned column above the pinned body cells", () => {
    const head = pinnedCell(PIN_FIRST, "head");
    expect(head.className).toContain("z-6");
    expect(head.className).not.toContain("z-5");
  });

  it("offsets a second pinned column by the width of the first", () => {
    const first: TablePin = { left: 0, width: 192, edge: "narrow" };
    const second: TablePin = { left: 192, edge: true };
    expect(pinnedCell(first, "cell").style.left).toBe(0);
    expect(pinnedCell(second, "cell").style.left).toBe(192);
  });

  it("pins only the first column on phones", () => {
    expect(pinnedCell({ left: 0 }, "cell").className).toMatch(/(^| )sticky( |$)/);
    const second = pinnedCell({ left: 160 }, "cell").className;
    expect(second).toContain("max-sm:static");
    expect(second).toContain("sm:sticky");
  });

  it("casts the edge shadow from the last pinned column only", () => {
    expect(pinnedCell({ left: 0, edge: true }, "cell").className).toContain(
      "group-data-[scrolled=true]/scroll:after:opacity-100",
    );
    expect(pinnedCell({ left: 0 }, "cell").className).not.toContain("after:");
  });

  it("shows the first column's shadow on phones only while a second one pins", () => {
    expect(pinnedCell({ left: 0, edge: "narrow" }, "cell").className).toContain("sm:after:hidden");
    expect(pinnedCell({ left: 160, edge: true }, "cell").className).toContain(
      "max-sm:after:hidden",
    );
    expect(pinnedCell({ left: 0, edge: true }, "cell").className).not.toContain("after:hidden");
  });

  it("fixes the width of a column that declares one, and keeps the space on phones", () => {
    const { className, style } = pinnedCell({ left: 0, width: 288 }, "cell");
    expect(style).toMatchObject({ "--pin-w": "288px" });
    expect(className).toContain("sm:w-(--pin-w)");
    expect(className).toContain("max-sm:max-w-[min(var(--pin-w),45vw)]");
  });

  it("keeps a style the caller passes along", () => {
    expect(pinnedCell(PIN_FIRST, "cell", { minWidth: 40 }).style).toMatchObject({
      left: 0,
      minWidth: 40,
    });
  });
});

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

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  resizeCallbacks = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

async function mount(scrollLabel?: string): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <Table scrollLabel={scrollLabel}>
          <TableHeader>
            <TableRow>
              <TableHead pin={PIN_FIRST}>Name</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell pin={PIN_FIRST}>Alpha</TableCell>
              <TableCell>ok</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </I18nextProvider>,
    );
  });
  const container = host.querySelector<HTMLElement>('[data-slot="table-container"]');
  if (!container) {
    throw new Error("no table container");
  }
  return container;
}

async function overflow(container: HTMLElement, scrollLeft = 0): Promise<void> {
  for (const [key, value] of Object.entries({
    scrollWidth: 1200,
    clientWidth: 600,
    scrollLeft,
  })) {
    Object.defineProperty(container, key, { configurable: true, writable: true, value });
  }
  await act(async () => {
    for (const callback of resizeCallbacks) {
      callback();
    }
  });
}

describe("Table scroll container", () => {
  it("is not a keyboard stop while the table fits", async () => {
    const container = await mount("Machines");
    expect(container.getAttribute("tabindex")).toBeNull();
    expect(container.getAttribute("role")).toBeNull();
    expect(container.getAttribute("aria-label")).toBeNull();
    expect(container.dataset).toMatchObject({ scrolled: "false", more: "false" });
  });

  it("becomes a labelled, focusable region once the table scrolls", async () => {
    const container = await mount("Machines");
    await overflow(container);
    expect(container.getAttribute("tabindex")).toBe("0");
    expect(container.getAttribute("role")).toBe("region");
    expect(container.getAttribute("aria-label")).toBe("Machines, scrollable");
    expect(container.dataset).toMatchObject({ scrolled: "false", more: "true" });
  });

  it("falls back to a generic name without a label", async () => {
    const container = await mount();
    await overflow(container);
    expect(container.getAttribute("aria-label")).toBe("Scrollable table");
  });

  it("speaks German too", async () => {
    await i18n.changeLanguage("de");
    try {
      const container = await mount("Maschinen");
      await overflow(container);
      expect(container.getAttribute("aria-label")).toBe("Maschinen, scrollbar");
    } finally {
      await act(async () => {
        await i18n.changeLanguage("en");
      });
    }
  });

  it("marks the scrolled state for the pinned column's shadow", async () => {
    const container = await mount("Machines");
    await overflow(container, 80);
    expect(container.dataset).toMatchObject({ scrolled: "true", more: "true" });
    expect(container.className).toContain("group/scroll");
  });

  it("keeps the table semantics inside untouched", async () => {
    const container = await mount("Machines");
    await overflow(container);
    const table = container.querySelector("table");
    expect(table?.getAttribute("role")).toBeNull();
    expect(container.querySelectorAll("th")).toHaveLength(2);
    expect(container.querySelectorAll("td")).toHaveLength(2);
  });

  it("scrolls focus into view beside the pinned columns, not under them", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <I18nextProvider i18n={i18n}>
          <Table scrollLabel="Machines">
            <TableHeader>
              <TableRow>
                <TableHead pin={PIN_FIRST}>Name</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
          </Table>
        </I18nextProvider>,
      );
    });
    const container = host.querySelector<HTMLElement>('[data-slot="table-container"]');
    const head = host.querySelector<HTMLElement>('th[data-pinned="left"]');
    if (!container || !head) {
      throw new Error("table did not render");
    }
    expect(container.style.scrollPaddingLeft).toBe("");
    Object.defineProperty(head, "offsetWidth", { configurable: true, value: 240 });
    head.style.position = "sticky";
    await act(async () => {
      for (const callback of resizeCallbacks) {
        callback();
      }
    });
    expect(container.style.scrollPaddingLeft).toBe("240px");
  });

  it("marks pinned cells and gives them their offset", async () => {
    const container = await mount("Machines");
    const pinned = container.querySelectorAll<HTMLElement>('[data-pinned="left"]');
    expect(pinned).toHaveLength(2);
    for (const cell of pinned) {
      expect(cell.style.left).toBe("0px");
      expect(cell.className).toContain("sticky");
    }
  });
});
