import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import en from "@restow/i18n/resources/en/dashboard.json" with { type: "json" };

import { i18n } from "@/i18n";

import "@/features/retention/i18n.js";
import type { RetentionWidget as RetentionData } from "../api.js";
import { WidgetUnavailableError, type WidgetView } from "../presenters.js";
import { RetentionWidget } from "./retention-widget.js";

/**
 * The retention dashboard widget: skeleton, error and empty states, the
 * honest "no policy" state with the recommended default, a built-in
 * preset's full rule sentence, a custom/legacy policy's cutoff with an
 * honest thinning note, and the guard sentence (newest restore point, and
 * its only verified one, are never removed).
 */

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

const KEY_GROUPS = Object.entries(en)
  .filter(([, value]) => typeof value === "object")
  .map(([key]) => key);

function expectTranslated(html: string): void {
  for (const group of KEY_GROUPS) {
    expect(html).not.toMatch(new RegExp(`[>"]${group}\\.[a-zA-Z_]+`));
  }
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const loading = { kind: "loading" } as const;
const failed = { kind: "error", error: new WidgetUnavailableError() } as const;
const ready = (data: RetentionData): WidgetView<RetentionData> => ({ kind: "ready", data });
const state = { onRetry: () => {}, retrying: false };

const base: RetentionData = {
  policy: null,
  scopedPolicies: 0,
  activeHolds: 0,
  snapshots: { active: 40, pruned: 5, oldestAt: "2026-08-01T00:00:00.000Z" },
  lastRun: { at: "2026-09-23T00:00:00.000Z", status: "completed" },
};

interface RetentionTierLike {
  fromDays: number;
  toDays: number | null;
  keepEveryDays: number;
}

/**
 * `RetentionData["policy"]`, plus the `preset`/`tiers` fields the API
 * already fills in (see the widget's own `PolicyWithRule`), which the
 * documented web-side type does not carry yet (tracked as a wiring
 * request). Cast at the edge here, the same way the widget reads them.
 */
interface PolicyOverride {
  name: string;
  keepDays: number | null;
  keepLast: number;
  preset?: string;
  tiers?: RetentionTierLike[];
}

function withPolicy(policy: PolicyOverride): RetentionData {
  return { ...base, policy: policy as RetentionData["policy"] };
}

describe("retention dashboard widget", () => {
  it("has skeleton and error states", () => {
    const skeleton = render(<RetentionWidget view={loading} {...state} />);
    expect(skeleton).toContain('data-state="loading"');
    expect(skeleton).toContain('data-slot="skeleton"');
    const error = render(<RetentionWidget view={failed} {...state} />);
    expect(error).toContain('data-state="error"');
    expect(error).toContain("Retry");
  });

  it("has an empty state when there are no restore points yet", () => {
    const html = render(
      <RetentionWidget
        view={ready({ ...base, snapshots: { active: 0, pruned: 0, oldestAt: null } })}
        {...state}
      />,
    );
    expect(html).toContain('data-state="empty"');
    expect(html).toContain("No restore points yet");
  });

  it("says honestly that every restore point is kept and shows the recommended default", () => {
    const html = render(<RetentionWidget view={ready(base)} {...state} />);
    expectTranslated(html);
    expect(html).toContain("No policy");
    expect(html).toContain("Everything is kept: there is no retention policy yet");
    expect(html).toContain("The recommended default policy");
    expect(html).toContain("30 days, then daily up to 90 days, then weekly up to 1 year");
    expect(html).not.toContain("policy: Recommended");
  });

  it("names a built-in preset with its full rule, thinning included", () => {
    const html = render(
      <RetentionWidget
        view={ready(
          withPolicy({ name: "Standard", keepDays: 365, keepLast: 1, preset: "default" }),
        )}
        {...state}
      />,
    );
    expect(html).toContain("Policy: Standard");
    expect(html).toContain("Recommended (30 d, then daily to 90 d, then weekly to 1 y)");
    // The guard is stated, not just implied.
    expect(html).toContain("newest restore point of an object, and its only verified one");
    // Never the misleading flat-cutoff phrasing for a tiered preset.
    expect(html).not.toContain("older than 365 days are pruned");
  });

  it("shows a flat preset's own rule (e.g. 90 days) without a false thinning note", () => {
    const html = render(
      <RetentionWidget
        view={ready(withPolicy({ name: "Quarter", keepDays: 90, keepLast: 1, preset: "90d" }))}
        {...state}
      />,
    );
    expect(html).toContain("90 days");
    expect(html).not.toContain("thinned to save space");
  });

  it("describes a custom policy by its true cutoff, flagging thinning honestly", () => {
    const thinned = render(
      <RetentionWidget
        view={ready(
          withPolicy({
            name: "Custom",
            keepDays: null,
            keepLast: 1,
            preset: "custom",
            tiers: [{ fromDays: 0, toDays: null, keepEveryDays: 7 }],
          }),
        )}
        {...state}
      />,
    );
    expect(thinned).toContain("Kept without an age limit");
    // Never claims every restore point survives when the tier still thins them.
    expect(thinned).toContain("thinned to save space");

    const flat = render(
      <RetentionWidget
        view={ready(
          withPolicy({
            name: "Custom flat",
            keepDays: 45,
            keepLast: 1,
            preset: "custom",
            tiers: [{ fromDays: 0, toDays: 45, keepEveryDays: 0 }],
          }),
        )}
        {...state}
      />,
    );
    expect(flat).toContain("Up to 45 days");
    expect(flat).not.toContain("thinned to save space");
  });

  it("falls back to the plain cutoff summary for a payload without preset information", () => {
    // e.g. an older response, or a caller that only ever knew keepDays/keepLast.
    const html = render(
      <RetentionWidget
        view={ready(withPolicy({ name: "Quarter", keepDays: 90, keepLast: 3 }))}
        {...state}
      />,
    );
    expect(html).toContain("Policy: Quarter");
    expect(html).toContain("older than 90 days are pruned");
    expect(html).toContain("the newest 3 restore points");
  });

  it("uses restore-point wording throughout, not the older snapshot wording", () => {
    const html = render(<RetentionWidget view={ready(base)} {...state} />);
    expect(html).toContain("Restore point retention");
    expect(html).toContain("Restore points kept");
    expect(html).toContain("Restore points pruned");
    expect(html).not.toContain("Snapshot retention");
    expect(html).not.toMatch(/Snapshots (kept|pruned)/);
  });

  it("says honestly that per-object overrides prune even with no tenant default", () => {
    const html = render(
      <RetentionWidget view={ready({ ...base, policy: null, scopedPolicies: 3 })} {...state} />,
    );
    expectTranslated(html);
    // Never the blanket "everything is kept" claim: those 3 objects are pruned.
    expect(html).not.toContain("Everything is kept: there is no retention policy yet");
    expect(html).toContain("objects without their own policy keep every restore point");
    expect(html).toContain("3 objects follow");
    // The generic scoped-count line would just repeat this; it must not double up.
    expect(html).not.toContain("more polic");
  });

  it("shows the scoped-count line alongside an actual tenant policy", () => {
    const html = render(
      <RetentionWidget
        view={ready({
          ...withPolicy({ name: "Standard", keepDays: 365, keepLast: 1, preset: "default" }),
          scopedPolicies: 2,
        })}
        {...state}
      />,
    );
    expect(html).toContain("2 more policies apply to single objects");
  });

  it("shows the same recommended-default sentence in the empty state when no policy exists", () => {
    const html = render(
      <RetentionWidget
        view={ready({ ...base, snapshots: { active: 0, pruned: 0, oldestAt: null } })}
        {...state}
      />,
    );
    expect(html).toContain("Everything is kept: there is no retention policy yet");
  });

  it("shows the honest only-overrides sentence in the empty state too", () => {
    const html = render(
      <RetentionWidget
        view={ready({
          ...base,
          policy: null,
          scopedPolicies: 1,
          snapshots: { active: 0, pruned: 0, oldestAt: null },
        })}
        {...state}
      />,
    );
    expect(html).toContain("objects without their own policy keep every restore point");
  });
});
