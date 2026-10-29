import { beforeAll, describe, expect, it } from "vitest";

import { render } from "@/components/kit/test-utils";
import type { ReadinessSummary } from "@/features/verify/api";
import { i18n } from "@/i18n";

import "../i18n";
import { OverallBanner } from "./summary";

/**
 * The tenant verdict: objects waiting for a confirmation have their own sentence, never the
 * generic "a warning or an overdue check" one, and are never added into its count.
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

describe("OverallBanner", () => {
  it("names only the confirmation when that is all that keeps the tenant yellow", () => {
    const html = render(<OverallBanner summary={summary({ overall: "yellow", toConfirm: 2 })} />);
    expect(html).toContain("2 objects no longer backed up, please confirm");
    expect(html).not.toContain("overdue");
    expect(html).not.toContain("need attention");
  });

  it("counts a yellow-rated, unconfirmed object once in each sentence", () => {
    const html = render(
      <OverallBanner summary={summary({ overall: "yellow", green: 2, yellow: 1, toConfirm: 1 })} />,
    );
    expect(html).toContain("1 object needs attention");
    expect(html).toContain("1 object no longer backed up, please confirm");
  });
});
