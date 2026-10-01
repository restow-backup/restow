import { Archive } from "lucide-react";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import { KpiTile, describeDelta } from "./kpi-tile.js";
import { count, render } from "./test-utils.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("describeDelta", () => {
  it("judges a rise by whether higher is better", () => {
    expect(describeDelta(12)).toEqual({
      direction: "up",
      tone: "positive",
      sign: "+",
      sentenceKey: "kpi.change.upBetter",
    });
    expect(describeDelta(12, false)).toMatchObject({
      tone: "destructive",
      sentenceKey: "kpi.change.upWorse",
    });
  });

  it("uses the typographic minus for a fall", () => {
    expect(describeDelta(-3)).toMatchObject({
      direction: "down",
      tone: "destructive",
      sign: "−",
      sentenceKey: "kpi.change.downWorse",
    });
    expect(describeDelta(-3, false)).toMatchObject({
      tone: "positive",
      sentenceKey: "kpi.change.downBetter",
    });
  });

  it("stays neutral without a judgement or without a change", () => {
    expect(describeDelta(7, null)).toMatchObject({
      tone: "muted",
      sentenceKey: "kpi.change.upNeutral",
    });
    expect(describeDelta(-7, null)).toMatchObject({
      tone: "muted",
      sentenceKey: "kpi.change.downNeutral",
    });
    expect(describeDelta(0)).toEqual({
      direction: "flat",
      tone: "muted",
      sign: "",
      sentenceKey: "kpi.change.flat",
    });
    expect(describeDelta(Number.NaN).direction).toBe("flat");
  });
});

describe("KpiTile", () => {
  it("shows the value in tabular numbers with label and icon", () => {
    const html = render(<KpiTile label="Archived mails" value="1,284" icon={Archive} />);
    expect(html).toContain("Archived mails");
    expect(html).toMatch(/class="[^"]*tabular-nums[^"]*">1,284</);
    expect(html).toContain("lucide-archive");
  });

  it("shows a good rise in the text colour, never green, with a sign and a full sentence", () => {
    const html = render(<KpiTile label="Restored items" value="40" delta={{ value: 12 }} />);
    expect(html).toContain("+12");
    expect(html).toContain('data-tone="positive"');
    // Green means a passed restore check; a figure that moved the right way is not one.
    expect(html).not.toMatch(/(?:text|bg|border)-success|text-green|emerald/);
    expect(html).toContain("Up by 12 compared with the previous period, an improvement.");
  });

  it("shows a fall of a lower-is-better figure as good news", () => {
    const html = render(
      <KpiTile
        label="Failed jobs"
        value="2"
        delta={{ value: -3, higherIsBetter: false, period: "compared with last week" }}
      />,
    );
    expect(html).toContain("−3");
    expect(html).toContain('data-tone="positive"');
    expect(html).not.toMatch(/(?:text|bg|border)-success/);
    expect(html).toContain("Down by 3 compared with last week, an improvement.");
    // The period is visible as well, not only read out.
    expect(count(html, "compared with last week")).toBe(2);
  });

  it("shows a bad rise in red", () => {
    const html = render(
      <KpiTile label="Failed jobs" value="5" delta={{ value: 3, higherIsBetter: false }} />,
    );
    expect(html).toContain("text-destructive-text");
    expect(html).toContain("Up by 3 compared with the previous period, a deterioration.");
  });

  it("keeps an unchanged figure grey and formats with the caller's format", () => {
    const flat = render(<KpiTile label="Mailboxes" value="12" delta={{ value: 0 }} />);
    expect(flat).toContain("text-muted-foreground");
    expect(flat).toContain('data-tone="muted"');
    expect(flat).toContain("Unchanged compared with the previous period.");

    const percent = render(
      <KpiTile label="Dedup" value="61 %" delta={{ value: 4.5, format: (v) => `${v} %` }} />,
    );
    expect(percent).toContain("+4.5 %");
  });

  it("shows skeletons instead of the value while loading", () => {
    const html = render(
      <KpiTile
        label="Restored items"
        value="40"
        delta={{ value: 12 }}
        loading
        hint="Last 7 days"
      />,
    );
    expect(html).toContain('data-slot="skeleton"');
    expect(html).not.toContain(">40<");
    expect(html).not.toContain("+12");
    expect(html).toContain("Loading value …");
  });

  it("renders hint, sparkline and link slots", () => {
    const html = render(
      <KpiTile
        label="Restored items"
        value="40"
        hint="Last 7 days"
        sparkline={<svg data-testid="spark" />}
        link={<a href="/restore">View restores</a>}
      />,
    );
    expect(html).toContain("Last 7 days");
    expect(html).toContain('data-testid="spark"');
    expect(html).toContain("View restores");
  });
});
