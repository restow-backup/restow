import { beforeAll, describe, expect, it } from "vitest";

import { render } from "@/components/kit/test-utils";
import { i18n } from "@/i18n";

import type { ListedSnapshot } from "../api.js";
import { RestorePointList } from "./restore-point-list.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

/** Newest first, as the API lists them. */
const points: ListedSnapshot[] = [
  {
    id: "p3",
    objectId: "o1",
    sequence: 3,
    itemCount: 12,
    byteSize: 2048,
    startedAt: "2026-09-22T10:00:00.000Z",
    completedAt: "2026-09-22T10:05:00.000Z",
    createdAt: "2026-09-22T10:00:00.000Z",
    verification: { state: "yellow", checkedAt: "2026-09-22T12:00:00.000Z", reportId: "r3" },
  },
  {
    id: "p2",
    objectId: "o1",
    sequence: 2,
    itemCount: 10,
    byteSize: 1024,
    startedAt: "2026-09-20T10:00:00.000Z",
    completedAt: "2026-09-20T10:05:00.000Z",
    createdAt: "2026-09-20T10:00:00.000Z",
    verification: { state: "green", checkedAt: "2026-09-21T00:00:00.000Z", reportId: "r1" },
  },
  {
    id: "p1",
    objectId: "o1",
    sequence: 1,
    itemCount: 5,
    byteSize: 512,
    startedAt: "2026-09-10T10:00:00.000Z",
    completedAt: "2026-09-10T10:05:00.000Z",
    createdAt: "2026-09-10T10:00:00.000Z",
    verification: { state: "unverified", checkedAt: null, reportId: null },
  },
];

/** The rendered markup of each marker button, in DOM order (left to right). */
function buttonsOf(html: string): string[] {
  return html.match(/<button[^>]*>.*?<\/button>/g) ?? [];
}

function renderList(value: string | null = "p2") {
  return render(
    <RestorePointList restorePoints={points} loading={false} value={value} onChange={() => {}} />,
  );
}

describe("RestorePointList", () => {
  it("shows every restore point as a real list, not a <select> or a closed popover trigger", () => {
    const html = renderList();
    expect(html).not.toContain("<select");
    expect(html).not.toContain('role="combobox"');
    expect(html).toContain('<ul aria-label="Restore points"');
    // All restore points render up front, not only the selected one.
    expect(html).toContain("Restore point #3");
    expect(html).toContain("Restore point #2");
    expect(html).toContain("Restore point #1");
  });

  it("orders the timeline chronologically: oldest on the left, newest on the right", () => {
    // The API hands them over newest first; the timeline reads the other way.
    const buttons = buttonsOf(renderList());
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toContain("Restore point #1");
    expect(buttons[1]).toContain("Restore point #2");
    expect(buttons[2]).toContain("Restore point #3");
  });

  it("marks exactly the browsed restore point as current and only the newest as latest", () => {
    const buttons = buttonsOf(renderList("p2"));
    const [oldest, middle, newest] = buttons;
    expect(buttons.filter((button) => button.includes('aria-current="true"'))).toHaveLength(1);
    expect(middle).toContain('aria-current="true"');
    expect(oldest).not.toContain("aria-current");
    expect(newest).not.toContain("aria-current");
    expect(middle).toContain("Current");
    expect(oldest).not.toContain("Current");
    // "Latest" sits on the newest restore point (the last marker), nowhere else.
    expect(newest).toContain("Latest");
    expect(middle).not.toContain("Latest");
    expect(oldest).not.toContain("Latest");
  });

  it("announces the selected restore point with its date, verification and 'Current'", () => {
    const middle = buttonsOf(renderList("p2"))[1] as string;
    // One accessible name, built from the sr-only text: sequence and date,
    // the verification in words and its hint, then "Current".
    expect(middle).toMatch(
      /<span class="sr-only">Restore point #2 from [^<]+\. Sample passed\. [^<]*\. Current<\/span>/,
    );
    expect(middle).not.toMatch(/<button[^>]*aria-label=/);
  });

  it("spells out the selected restore point: date and time, how long ago, and its verification", () => {
    const html = renderList("p2");
    const selected = buttonsOf(html)[1] as string;
    // Absolute date and time in a <time>, prominent; the relative time next to it.
    expect(selected).toContain('<time dateTime="2026-09-20T10:05:00.000Z"');
    expect(selected).toMatch(/\bago\b/);
    expect(selected).toContain("Sample passed");
    // The others only carry a short label.
    const other = buttonsOf(html)[0] as string;
    expect(other).not.toContain("<time");
  });

  it("shows the verification state of every restore point, in words and by marker shape", () => {
    const html = renderList("p2");
    expect(html).toContain("Sample passed with warnings");
    expect(html).toContain("Sample passed");
    expect(html).toContain("Not checked yet");
    // Each state has its own marker: colour is never the only signal.
    for (const state of ["green", "yellow", "unverified"]) {
      expect(html).toContain(`data-verification="${state}"`);
    }
    const shape = (state: string) =>
      html.match(new RegExp(`<span data-verification="${state}" class="([^"]*)"`))?.[1];
    expect(shape("green")).toContain("rounded-full");
    expect(shape("unverified")).toContain("border-2");
    expect(shape("yellow")).toContain("rotate-45");
    expect(new Set([shape("green"), shape("yellow"), shape("unverified")]).size).toBe(3);
  });

  it("renders nothing once it is known there is no restore point", () => {
    const html = render(
      <RestorePointList restorePoints={[]} loading={false} value={null} onChange={() => {}} />,
    );
    expect(html).toBe("");
  });

  it("shows placeholders while loading instead of an empty track", () => {
    const html = render(
      <RestorePointList restorePoints={undefined} loading value={null} onChange={() => {}} />,
    );
    expect(html).toContain('data-slot="skeleton"');
    expect(html).not.toContain("<ul");
  });

  it("positions the scrolling row so its sr-only spans stay clipped inside it", () => {
    // RelativeTime and SnapshotVerificationBadge each render a `focusable={false}`
    // sr-only span (`position: absolute`). Without a positioned ancestor, a
    // browser computes that span's static position against the page's
    // initial containing block instead of this row, which can push it far
    // outside the row and force the whole page to scroll sideways (a real
    // 40-restore-point row measured 6674px wide at a 1920px viewport before
    // this fix; happy-dom does not lay out CSS, so this asserts the fix
    // itself — the `relative` class — rather than a measured width).
    const html = renderList();
    expect(html).toMatch(/<ul aria-label="Restore points" class="[^"]*\brelative\b/);
  });

  it("leaves half the track empty at both ends, so the first and last point can be centred", () => {
    const html = renderList();
    const classes = html.match(/<ul aria-label="Restore points" class="([^"]*)"/)?.[1] ?? "";
    expect(classes).toContain("overflow-x-auto");
    expect(classes).toContain("before:w-1/2");
    expect(classes).toContain("after:w-1/2");
  });

  it("makes only the browsed restore point a Tab stop (roving tabindex)", () => {
    const [oldest, middle, newest] = buttonsOf(renderList("p2"));
    expect(middle).toContain('tabindex="0"');
    expect(oldest).toContain('tabindex="-1"');
    expect(newest).toContain('tabindex="-1"');
  });

  it("falls back to the newest restore point as the Tab stop while none is browsed yet", () => {
    const [oldest, middle, newest] = buttonsOf(renderList(null));
    expect(newest).toContain('tabindex="0"');
    expect(middle).toContain('tabindex="-1"');
    expect(oldest).toContain('tabindex="-1"');
  });

  it("keeps the accessible name built from the marker's own content, not a replacing aria-label", () => {
    const html = renderList();
    // An `aria-label` here would silently drop the verification state and
    // "Current" from what a screen reader announces for the marker.
    expect(html).not.toMatch(/<button[^>]*aria-label=/);
    for (const button of buttonsOf(html)) {
      expect(button).toMatch(/<span class="sr-only">Restore point #\d from /);
    }
  });
});
