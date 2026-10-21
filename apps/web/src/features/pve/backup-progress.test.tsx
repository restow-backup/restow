import type { TFunction } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import type { PveRunProgress } from "./api";
import {
  activityHint,
  BackupProgress,
  helperOlderThan,
  progressLine,
  progressParts,
  progressPercent,
} from "./backup-progress";
import { PVE_NAMESPACE } from "./i18n";

/** The progress of a running guest backup (#51) and the tooltip of its activity badge. */

const GIB = 1024 ** 3;
const progress = (over: Partial<PveRunProgress> = {}): PveRunProgress => ({
  bytesDone: 3.2 * GIB,
  bytesTotal: 9.4 * GIB,
  bytesUploaded: 1 * GIB,
  bytesPerSecond: 85 * 1024 * 1024,
  at: "2026-10-15T10:00:00Z",
  ...over,
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const t = i18n.getFixedT("en", PVE_NAMESPACE) as unknown as TFunction;

describe("progressPercent", () => {
  it("is the share read of the total, and null while the total is unknown", () => {
    expect(progressPercent(progress())).toBe(34);
    expect(progressPercent(progress({ bytesTotal: null }))).toBeNull();
    expect(progressPercent(progress({ bytesTotal: 0 }))).toBeNull();
    expect(progressPercent(progress({ bytesDone: 2 * GIB, bytesTotal: GIB }))).toBe(100);
    expect(progressPercent(null)).toBeNull();
  });
});

describe("progressLine", () => {
  it("reads: percent, what was read of the total, throughput", () => {
    expect(progressLine(t, "en", progress())).toBe("34% · 3.2 GB of 9.4 GB · 85 MB/s");
  });

  it("says what was read while restic has no total yet, and when nothing came in", () => {
    expect(progressLine(t, "en", progress({ bytesTotal: null, bytesPerSecond: null }))).toBe(
      "3.2 GB read",
    );
    expect(progressLine(t, "en", null)).toBe("No progress reported yet");
  });

  it("formats the figures the German way", () => {
    const de = i18n.getFixedT("de", PVE_NAMESPACE) as unknown as TFunction;
    expect(progressLine(de, "de", progress()).replace(/\u00a0/g, " ")).toBe(
      "34 % · 3,2 GB von 9,4 GB · 85 MB/s",
    );
  });
});

describe("BackupProgress", () => {
  it("renders a determinate bar with the figures, an indeterminate one without a total", () => {
    const render = (p: PveRunProgress | null) =>
      renderToStaticMarkup(
        <I18nextProvider i18n={i18n}>
          <BackupProgress progress={p} name="web" />
        </I18nextProvider>,
      );
    const html = render(progress());
    expect(html).toContain('aria-valuenow="34"');
    expect(html).toContain("3.2 GB of 9.4 GB");
    expect(html).toContain("Uploaded so far: 1 GB");
    expect(html).not.toContain("success");
    expect(render(null)).not.toContain("aria-valuenow");
  });
});

describe("a node whose restow-pve is too old to report progress", () => {
  it("compares versions numerically, never calling an unknown or development build older", () => {
    expect(helperOlderThan("0.3.7", "0.4.0")).toBe(true);
    expect(helperOlderThan("0.3.10", "0.4.0")).toBe(true);
    expect(helperOlderThan("0.4.0", "0.4.0")).toBe(false);
    expect(helperOlderThan("0.10.0", "0.4.0")).toBe(false);
    expect(helperOlderThan(null, "0.4.0")).toBe(false);
    expect(helperOlderThan("0.4.0-dev", "0.4.0")).toBe(false);
  });

  it("says the node needs an update instead of waiting for progress", () => {
    const old = { name: "pmx02", helperVersion: "0.3.7" };
    expect(progressLine(t, "en", null, old)).toBe(
      "Progress needs restow-pve 0.4.0 on pmx02 (it runs 0.3.7). Update the node.",
    );
    const de = i18n.getFixedT("de", PVE_NAMESPACE) as unknown as TFunction;
    expect(progressLine(de, "de", null, old)).toBe(
      "Der Fortschritt braucht restow-pve 0.4.0 auf pmx02 (dort läuft 0.3.7). Aktualisieren Sie den Knoten.",
    );
    // A current node, or one whose version is unknown, simply has not reported yet.
    expect(progressLine(t, "en", null, { name: "pmx02", helperVersion: "0.4.1" })).toBe(
      "No progress reported yet",
    );
    expect(progressLine(t, "en", null, { name: "pmx02", helperVersion: null })).toBe(
      "No progress reported yet",
    );
    // Figures that came in win.
    expect(progressLine(t, "en", progress(), old)).toBe("34% · 3.2 GB of 9.4 GB · 85 MB/s");

    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <BackupProgress progress={null} name="web" node={old} />
      </I18nextProvider>,
    );
    expect(html).toContain("Progress needs restow-pve 0.4.0 on pmx02 (it runs 0.3.7)");
    expect(html).not.toContain("No progress reported yet");
  });
});

describe("activityHint", () => {
  const node = { name: "pmx02", online: true, lastSeenAt: "2026-10-15T09:59:00Z" };
  it("says since when a guest waits and when its node last reported", () => {
    const hint = activityHint(
      t,
      "en",
      { activity: "queued", activitySince: "2026-10-15T09:58:00Z", node: "pmx02" },
      node,
    );
    expect(hint).toContain("Requested on");
    expect(hint).toContain("The node last reported on");
  });

  it("names a disconnected node, which starts nothing", () => {
    const hint = activityHint(
      t,
      "en",
      { activity: "queued", activitySince: null, node: "pmx02" },
      { ...node, online: false },
    );
    expect(hint).toContain("Node pmx02 is disconnected");
  });

  it("says since when a backup runs, and nothing without an activity", () => {
    expect(
      activityHint(
        t,
        "en",
        { activity: "running", activitySince: "2026-10-15T09:58:00Z", node: null },
        null,
      ),
    ).toContain("Started on");
    expect(activityHint(t, "en", { activity: null, node: null }, node)).toBeUndefined();
  });
});

describe("the figures under the bar (table jitter, F)", () => {
  it("keeps percent and rate in slots of a fixed width, the amount cut, the whole line as tooltip", () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <BackupProgress progress={progress()} name="web" />
      </I18nextProvider>,
    );
    expect(html).toContain('title="34% · 3.2 GB of 9.4 GB · 85 MB/s"');
    expect(html).toContain("w-[4.5ch]");
    expect(html).toContain("w-[10ch]");
    expect(html).toContain("truncate");
    expect(html).toContain("tabular-nums");
  });

  it("splits the line into its parts, or a message while nothing came in", () => {
    const t = i18n.getFixedT("en", PVE_NAMESPACE) as unknown as TFunction;
    expect(progressParts(t, "en", progress())).toEqual({
      percent: "34%",
      amount: "3.2 GB of 9.4 GB",
      rate: "85 MB/s",
      message: null,
    });
    expect(progressParts(t, "en", null)).toMatchObject({ message: "No progress reported yet" });
  });
});
