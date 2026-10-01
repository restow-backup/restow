// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import "../i18n";
import type { StorageUsage } from "../types";
import { UsageCard } from "./usage-card";

/**
 * The storage chart names itself once. Firefox showed the title a second time
 * under the chart: the screen-reader table carried `sr-only` on the <table>
 * and a <caption>, and Firefox keeps a caption outside the clipped table box.
 * Title and note now have one visible source each (the figure caption, the
 * info button's tooltip); the table is named by the caption and hidden by a
 * wrapper, and the note is never text under the chart.
 */

const usage: StorageUsage = {
  logicalBytes: 311_000,
  retainedLogicalBytes: 7_500_000,
  physicalBytes: 363_000,
  packCount: 96,
  snapshotCount: 64,
  protectedObjectCount: 2,
  growth: {
    days30: { days: 30, addedBytes: 170_000, ratio: 0.88 },
    days90: { days: 90, addedBytes: 363_000, ratio: null },
  },
  series: Array.from({ length: 30 }, (_, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, "0")}`,
    bytes: 200_000 + index * 5_000,
  })),
  generatedAt: "2026-10-01T12:00:00.000Z",
};

// happy-dom has no layout: give the chart the size the page would instead of measuring 0 × 0.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({
      children,
    }: { children: React.ReactElement<{ width?: number; height?: number }> }) =>
      React.cloneElement(children, { width: 640, height: 224 }),
  };
});

vi.mock("../use-storage", () => ({
  useStorageUsage: () => ({
    isPending: false,
    isError: false,
    isFetching: false,
    data: usage,
    refetch: vi.fn(),
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function renderCard(language: "de" | "en"): Promise<HTMLElement> {
  await i18n.changeLanguage(language);
  const host = document.createElement("div");
  document.body.appendChild(host);
  container = host;
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={new QueryClient()}>
          <UsageCard />
        </QueryClientProvider>
      </I18nextProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return host;
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("storage usage chart", () => {
  for (const language of ["de", "en"] as const) {
    it(`renders its title exactly once (${language})`, async () => {
      const host = await renderCard(language);
      const t = i18n.getFixedT(language, "storage");
      const title = t("usage.chartTitle");

      expect(occurrences(host.textContent ?? "", title)).toBe(1);
      const caption = host.querySelector("figcaption");
      expect(caption?.textContent).toContain(title);
      expect(host.querySelector("caption")).toBeNull();
    });

    it(`keeps the note off the page and gives it to screen readers (${language})`, async () => {
      const host = await renderCard(language);
      const t = i18n.getFixedT(language, "storage");
      const note = t("usage.growthNote");

      const holders = [...host.querySelectorAll("*")].filter((element) =>
        [...element.childNodes].some(
          (node) => node.nodeType === 3 && (node.textContent ?? "").includes(note),
        ),
      );
      expect(holders).toHaveLength(1);
      const [holder] = holders;
      expect(holder?.hasAttribute("hidden")).toBe(true);

      const figure = host.querySelector("figure");
      expect(figure?.getAttribute("aria-describedby")).toBe(holder?.id);
      const info = host.querySelector(`button[aria-label="${t("usage.chartInfo")}"]`);
      expect(info?.getAttribute("aria-describedby")).toBe(holder?.id);
    });
  }

  it("hides the data table with a wrapper and names it by the figure caption", async () => {
    const host = await renderCard("de");
    const table = host.querySelector("table");
    expect(table).not.toBeNull();
    expect(table?.classList.contains("sr-only")).toBe(false);
    expect(table?.parentElement?.classList.contains("sr-only")).toBe(true);
    const titleId = table?.getAttribute("aria-labelledby") ?? "";
    expect(host.querySelector("figcaption")?.querySelector(`[id="${titleId}"]`)).not.toBeNull();
  });

  it("clips the plot to a fixed height", async () => {
    const host = await renderCard("en");
    const plot = host.querySelector('figure [role="img"]');
    expect(plot?.className).toContain("h-56");
    expect(plot?.className).toContain("overflow-hidden");
  });
});
