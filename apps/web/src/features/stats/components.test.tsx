import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import { KPI_NAMES, type Kpi, MISSING_REASON, type StatsOverview } from "./api.js";
import { StatsExportsProvider } from "./components/chart-parts.js";
import { KpiGrid } from "./components/kpi-grid.js";
import { BackupsChart, ReadinessChart, RestoresChart } from "./components/outcome-charts.js";
import { PeriodSelector } from "./components/period-selector.js";
import { TableCard } from "./components/table-card.js";
import { VolumeChart } from "./components/volume-charts.js";
import "./i18n.js";
import { resolvePeriod } from "./period.js";

/**
 * Static markup covers the page's contracts: every dataset renders or shows
 * its honest unavailable state, loading shows skeletons, figures are
 * formatted. Behaviour lives in the pure modules and their tests.
 */

const EXPORTS = { csv: () => {}, csvPending: () => false };

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <StatsExportsProvider value={EXPORTS}>{node}</StatsExportsProvider>
    </I18nextProvider>,
  );
}

/** Intl uses thin, narrow and non-breaking spaces; compare with plain ones. */
function plain(text: string): string {
  return text.replace(/[\u00a0\u2009\u202f]/g, " ");
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

function kpis(overrides: Partial<Record<(typeof KPI_NAMES)[number], Kpi>>): StatsOverview["kpis"] {
  const base = Object.fromEntries(
    KPI_NAMES.map((name) => [name, { status: "ok", value: 1, previous: 1 }]),
  ) as StatsOverview["kpis"];
  return { ...base, ...overrides };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("charts", () => {
  it("show the unavailable state with the server's reason", () => {
    const html = render(
      <BackupsChart
        data={{ status: "unavailable", reason: "Backups are not recorded before 0.301." }}
        granularity="day"
      />,
    );
    expect(html).toContain('data-state="unavailable"');
    expect(html).toContain("Not available");
    expect(html).toContain("Backups are not recorded before 0.301.");
    // Nothing to export from a dataset that does not exist.
    expect(html).not.toContain("Export options for");
  });

  it("word the server's reason codes", () => {
    const html = render(
      <BackupsChart data={{ status: "unavailable", reason: "no_backups_yet" }} granularity="day" />,
    );
    expect(html).toContain("No backup has run yet. The figures appear after the first backup.");
  });

  it("explain a dataset the server did not send", () => {
    const html = render(
      <BackupsChart data={{ status: "unavailable", reason: MISSING_REASON }} granularity="day" />,
    );
    expect(html).toContain("This server version does not report this figure yet.");
  });

  it("show a skeleton while loading", () => {
    const html = render(<BackupsChart data={undefined} granularity="day" />);
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('data-slot="skeleton"');
  });

  it("say so when nothing happened instead of drawing zeros", () => {
    const html = render(
      <BackupsChart
        data={{
          status: "ok",
          rows: [{ t: "2026-09-17", succeeded: 0, failed: 0, cancelled: 0 }],
        }}
        granularity="day"
      />,
    );
    expect(html).toContain("No backup runs");
    expect(html).not.toContain('data-slot="chart"');
  });

  it("render the chart with its export menu and a summary for screen readers", () => {
    const html = render(
      <BackupsChart
        data={{
          status: "ok",
          rows: [
            { t: "2026-09-17", succeeded: 10, failed: 1, cancelled: 0 },
            { t: "2026-09-18", succeeded: 12, failed: 0, cancelled: 2 },
          ],
        }}
        granularity="day"
      />,
    );
    expect(html).toContain('data-slot="chart"');
    expect(html).toContain('aria-label="Export options for Backup outcomes"');
    expect(html).toContain(
      "In this period 22 backup runs succeeded, 1 failed and 2 were cancelled.",
    );
    // The status chart colours the dashboard uses for the same outcomes. A backup
    // that completed is Lapis: green is for a passed restore check, and no check
    // has read these backups back.
    expect(html).toContain("--color-succeeded: var(--chart-info)");
    expect(html).not.toContain("var(--chart-success)");
    expect(html).toContain("--color-failed: var(--chart-destructive)");
    expect(html).toContain("--color-cancelled: var(--chart-muted)");
  });

  it("keep the green for restores that completed: the data is back", () => {
    const html = render(
      <RestoresChart
        data={{
          status: "ok",
          rows: [{ t: "2026-09-17", completed: 4, failed: 1 }],
        }}
        granularity="day"
      />,
    );
    expect(html).toContain("--color-completed: var(--chart-success)");
    expect(html).toContain("--color-failed: var(--chart-destructive)");
  });

  it("colour readiness like the dashboard's restore checks", () => {
    const html = render(
      <ReadinessChart
        data={{
          status: "ok",
          rows: [{ t: "2026-09-17", green: 8, yellow: 2, red: 1, unverified: 3 }],
        }}
        granularity="day"
      />,
    );
    expect(html).toContain('data-slot="chart"');
    expect(html).toContain("--color-green: var(--chart-success)");
    expect(html).toContain("--color-yellow: var(--chart-warning)");
    expect(html).toContain("--color-red: var(--chart-destructive)");
    expect(html).toContain("--color-unverified: var(--chart-muted)");
  });

  it("state the deduplication savings under the volume chart", () => {
    const html = render(
      <VolumeChart
        data={{
          status: "ok",
          rows: [{ t: "2026-09-17", logicalBytes: 4096, physicalBytes: 1024 }],
        }}
        granularity="week"
        dedup={{ savings: 0.75, previousSavings: null, factor: 4 }}
      />,
    );
    expect(html).toContain("Deduplication saves 75% of the backed-up data (ratio 4 : 1).");
    expect(html).toContain("per week");
  });
});

describe("KpiGrid", () => {
  it("shows nine skeleton tiles while loading", () => {
    const html = render(<KpiGrid kpis={undefined} />);
    expect(count(html, 'data-slot="kpi-tile"')).toBe(9);
    expect(count(html, 'aria-busy="true"')).toBe(9);
  });

  it("formats figures and compares with the previous period", () => {
    const html = render(
      <KpiGrid
        kpis={kpis({
          backupSuccessRate: { status: "ok", value: 0.98, previous: 0.95 },
          failedItems: { status: "ok", value: 7, previous: 2 },
          throttlingWaitSeconds: { status: "ok", value: 4830, previous: 600 },
          logicalBytes: { status: "ok", value: 4 * 1024 ** 3, previous: 2 * 1024 ** 3 },
          physicalBytes: { status: "ok", value: 1024 ** 3, previous: 1024 ** 3 },
          dedupRatio: { status: "ok", value: 4, previous: 2 },
        })}
      />,
    );
    expect(html).toContain("98%");
    expect(html).toContain("+3 pp");
    expect(html).toContain("Up by 3 pp compared with the previous period, an improvement.");
    expect(html).toContain("Up by 5 compared with the previous period, a deterioration.");
    expect(html).toContain("1 hr 20 min");
    expect(html).toContain("75%");
    expect(html).toContain("+25 pp");
    expect(html).toContain("Backed-up to stored data 4 : 1");
  });

  it("shows an improvement in the text colour, never green", () => {
    const html = render(
      <KpiGrid
        kpis={kpis({
          backupSuccessRate: { status: "ok", value: 0.98, previous: 0.95 },
          physicalBytes: { status: "ok", value: 1024 ** 3, previous: 1024 ** 3 },
          logicalBytes: { status: "ok", value: 4 * 1024 ** 3, previous: 2 * 1024 ** 3 },
          dedupRatio: { status: "ok", value: 4, previous: 2 },
        })}
      />,
    );
    // The success rate and the deduplication saving both rose: good news, not a passed check.
    expect(html).toContain('data-tone="positive"');
    expect(html).not.toMatch(/(?:text|bg|border)-success/);
  });

  it("names why a figure is unavailable instead of showing zero", () => {
    const html = render(
      <KpiGrid
        kpis={kpis({
          throttlingWaitSeconds: {
            status: "unavailable",
            reason: "IMAP sources are not throttled.",
          },
          verifiedShare: { status: "ok", value: null, previous: null },
        })}
      />,
    );
    expect(html).toContain("IMAP sources are not throttled.");
    expect(html).toContain("Not available");
    expect(html).toContain("No value in this period.");
  });
});

describe("TableCard", () => {
  it("shows the reason instead of the table when the dataset is unavailable", () => {
    const html = render(
      <TableCard
        title="Largest objects"
        description="By size"
        name="largestObjects"
        data={{ status: "unavailable", reason: "Sizes are recorded from the next backup on." }}
      >
        <table data-slot="the-table" />
      </TableCard>,
    );
    expect(html).toContain("Sizes are recorded from the next backup on.");
    expect(html).not.toContain('data-slot="the-table"');
    expect(html).not.toContain("Export options for");
  });

  it("renders the table and its export menu when there is data", () => {
    const html = render(
      <TableCard
        title="Largest objects"
        description="By size"
        name="largestObjects"
        data={{ status: "ok", rows: [] }}
      >
        <table data-slot="the-table" />
      </TableCard>,
    );
    expect(html).toContain('data-slot="the-table"');
    expect(html).toContain('aria-label="Export options for Largest objects"');
  });
});

describe("period controls", () => {
  const now = new Date(2026, 8, 23, 12);

  it("marks the active preset", () => {
    const html = render(
      <PeriodSelector
        search={{ period: "90d" }}
        period={resolvePeriod({ period: "90d" }, now)}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Preset periods"');
    expect(html).toMatch(/aria-checked="true"[^>]*>90 days/);
    expect(html).toMatch(/aria-checked="false"[^>]*>30 days/);
    expect(html).toContain("Custom");
  });

  it("shows a custom range on its button", () => {
    const search = { period: "custom", from: "2026-09-01", to: "2026-09-15" } as const;
    const html = plain(
      render(
        <PeriodSelector search={search} period={resolvePeriod(search, now)} onChange={() => {}} />,
      ),
    );
    expect(html).toContain("Custom period: Sep 1 – 15, 2026");
    expect(html).not.toContain('aria-checked="true"');
  });
});
