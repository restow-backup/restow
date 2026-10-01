import { Bar, BarChart } from "recharts";
import { beforeAll, describe, expect, it } from "vitest";

import type { ChartConfig } from "@/components/ui/chart";
import { i18n } from "@/i18n";

import { ChartCard } from "./chart-card.js";
import { render } from "./test-utils.js";

const CONFIG = { bytes: { label: "Stored", color: "var(--chart-1)" } } satisfies ChartConfig;
const DATA = [
  { day: "Mon", bytes: 10 },
  { day: "Tue", bytes: 12 },
];

function chart() {
  return (
    <BarChart data={DATA}>
      <Bar dataKey="bytes" fill="var(--color-bytes)" />
    </BarChart>
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("ChartCard", () => {
  it("shows the reason when the chart is unavailable", () => {
    const reason = "Storage history starts after the first backup.";
    const html = render(
      <ChartCard title="Storage growth" config={CONFIG} unavailable={reason} loading>
        {chart()}
      </ChartCard>,
    );
    expect(html).toContain("Storage growth");
    expect(html).toContain('data-state="unavailable"');
    expect(html).toContain("Not available");
    expect(html).toContain(reason);
    expect(html).not.toContain('data-slot="chart"');
    expect(html).not.toContain('data-slot="skeleton"');
  });

  it("shows a skeleton of the plot height while loading", () => {
    const html = render(
      <ChartCard title="Storage growth" config={CONFIG} loading chartClassName="h-48">
        {chart()}
      </ChartCard>,
    );
    expect(html).toMatch(/data-state="loading"[^>]*class="w-full h-48"/);
    expect(html).toContain('data-slot="skeleton"');
    expect(html).toContain("Loading chart …");
  });

  it("shows the cause and a retry on error", () => {
    const html = render(
      <ChartCard title="Storage growth" config={CONFIG} error={new Error("x")} onRetry={() => {}}>
        {chart()}
      </ChartCard>,
    );
    expect(html).toContain("The chart could not be loaded");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Retry");
    expect(html).not.toContain('data-slot="chart"');
  });

  it("shows an empty state with its action", () => {
    const html = render(
      <ChartCard
        title="Storage growth"
        config={CONFIG}
        empty
        emptyAction={<button type="button">Start a backup</button>}
      >
        {chart()}
      </ChartCard>,
    );
    expect(html).toContain("No data yet");
    expect(html).toContain("Start a backup");
    expect(html).not.toContain('data-slot="chart"');
  });

  it("renders the chart with description, menu and summary", () => {
    const html = render(
      <ChartCard
        title="Storage growth"
        description="Physical bytes per day"
        config={CONFIG}
        menu={<button type="button">Export CSV</button>}
        summary="Stored data grew from 10 to 12 GB this week."
      >
        {chart()}
      </ChartCard>,
    );
    expect(html).toContain('data-slot="chart"');
    expect(html).toContain("Physical bytes per day");
    expect(html).toContain('data-slot="card-action"');
    expect(html).toContain("Export CSV");
    expect(html).toContain("Stored data grew from 10 to 12 GB this week.");
    expect(html).toContain("--color-bytes: var(--chart-1)");
  });
});
