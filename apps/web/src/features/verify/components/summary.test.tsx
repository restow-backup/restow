import { beforeAll, describe, expect, it } from "vitest";

import { render } from "@/components/kit/test-utils";
import type { ReadinessSummary } from "@/features/verify/api";
import type { VerifyFormat } from "@/features/verify/use-verify";
import { i18n } from "@/i18n";

import "../i18n";
import { OverallBanner, SummaryTiles } from "./summary";

/**
 * The tenant verdict follows the aggregate rule (UI rework, decision 1): Not restorable counts
 * what cannot be restored or has no backup yet, Not proven what needs attention or is
 * unverified. Objects waiting for a confirmation have their own sentence, whatever the verdict.
 */

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function summary(overrides: Partial<ReadinessSummary> = {}): ReadinessSummary {
  return {
    total: 3,
    green: 3,
    yellow: 0,
    red: 0,
    unverified: 0,
    noBackup: 0,
    overdue: 0,
    toConfirm: 0,
    overall: "green",
    lastCheckedAt: "2026-10-29T03:00:00.000Z",
    running: 0,
    ...overrides,
  };
}

const t = i18n.getFixedT("en", "verify");
const format = {
  t,
  language: "en",
  integer: (value: number) => String(value),
} as unknown as VerifyFormat;

describe("OverallBanner", () => {
  it("adds the confirmation sentence whatever the verdict, even at Ready", () => {
    const html = render(<OverallBanner summary={summary({ toConfirm: 2 })} />);
    expect(html).toContain('data-overall="green"');
    expect(html).toContain("2 objects no longer backed up, please confirm");
  });

  it("counts what cannot be restored or has no backup yet when red", () => {
    const html = render(
      <OverallBanner
        summary={summary({ overall: "red", green: 1, red: 1, noBackup: 2, unverified: 5 })}
      />,
    );
    expect(html).toContain("Not every object can be restored");
    expect(html).toContain("3 objects cannot be restored completely or have no backup yet.");
  });

  it("reads the brief's case 0/0/1/1/18 as not proven, counting attention and unverified", () => {
    const html = render(
      <OverallBanner
        summary={summary({ overall: "yellow", total: 20, green: 1, yellow: 1, unverified: 18 })}
      />,
    );
    expect(html).toContain('data-overall="yellow"');
    expect(html).toContain("not proven for every object");
    expect(html).toContain("19 objects are not proven restorable yet");
  });

  it("still names the objects to confirm when nothing is rated (overall null)", () => {
    // The API's `summarize([], 0, 1)`: an orphaned object with no backup waits for a
    // confirmation; it decides no aggregate (decision 2) but must not vanish.
    const html = render(
      <OverallBanner summary={summary({ overall: null, total: 0, green: 0, toConfirm: 1 })} />,
    );
    expect(html).toContain('data-overall="none"');
    expect(html).toContain("Nothing protected yet");
    expect(html).toContain('data-flag="to-confirm"');
    expect(html).toContain("1 object no longer backed up, please confirm");
  });

  it("adds no confirmation sentence to an empty tenant with nothing to confirm", () => {
    const html = render(
      <OverallBanner summary={summary({ overall: null, total: 0, green: 0, toConfirm: 0 })} />,
    );
    expect(html).toContain('data-overall="none"');
    expect(html).not.toContain('data-flag="to-confirm"');
  });

  it("counts a yellow-rated, unconfirmed object once in each sentence", () => {
    const html = render(
      <OverallBanner summary={summary({ overall: "yellow", green: 2, yellow: 1, toConfirm: 1 })} />,
    );
    expect(html).toContain("1 object is not proven restorable yet");
    expect(html).toContain("1 object no longer backed up, please confirm");
  });
});

describe("SummaryTiles", () => {
  it("shows the five categories in the overview's order, the empty ones dimmed", () => {
    const html = render(
      <SummaryTiles
        summary={summary({ overall: "yellow", total: 20, green: 1, yellow: 1, unverified: 18 })}
        format={format}
      />,
    );
    const order = ["ready", "needs_attention", "unverified", "not_restorable", "no_backup"].map(
      (category) => html.indexOf(`data-category="${category}" data-severity`),
    );
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const tile = (category: string) => {
      const start = html.indexOf(`data-category="${category}" data-severity`);
      return html.slice(start, html.indexOf("</svg>", start));
    };
    expect(tile("not_restorable")).toContain('data-empty="true"');
    expect(tile("no_backup")).toContain('data-empty="true"');
    expect(tile("unverified")).not.toContain('data-empty="true"');
    // Needs attention is orange (attention), Unverified amber (warning).
    expect(tile("needs_attention")).toContain('data-severity="attention"');
    expect(tile("needs_attention")).toContain("text-attention-fg");
    expect(tile("unverified")).toContain('data-severity="warning"');
    expect(tile("unverified")).toContain("text-warning-text");
    expect(html).toContain("Needs attention");
    expect(html).toContain("No backup yet");
    expect(html).not.toContain("text-warning-foreground");
  });
});
