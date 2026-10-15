import { describe, expect, it } from "vitest";

import type { ActivityReport } from "./activity.js";
import {
  baselineOf,
  changeRateThreshold,
  evaluateSuspicion,
  opensSuspicionEpisode,
  type RunMetrics,
  ratioThreshold,
} from "./evaluate.js";
import { DEFAULT_RANSOMWARE_SETTINGS, resolveRansomwareSettings } from "./settings.js";
import { RANSOMWARE_SIGNATURES_VERSION } from "./signatures.js";

const settings = DEFAULT_RANSOMWARE_SETTINGS;

function activity(overrides: Partial<ActivityReport> = {}): ActivityReport {
  return {
    v: 1,
    added: 10,
    modified: 20,
    removed: 0,
    renamed: 0,
    extensions: [{ value: "docx", count: 15 }],
    names: [],
    entropy: [],
    truncated: false,
    ...overrides,
  };
}

function run(itemsChanged: number, bytesAdded: number, extra: Partial<RunMetrics> = {}) {
  return { itemsChanged, itemsTotal: 100_000, bytesAdded, activity: null, ...extra };
}

/** Fourteen ordinary days: a few hundred files and some hundred MiB each. */
const history: RunMetrics[] = [
  300, 280, 350, 310, 290, 330, 270, 320, 300, 340, 310, 290, 305, 315,
].map((n, i) => run(n, (200 + i * 5) * 1024 ** 2));

describe("the baseline", () => {
  it("is the median and the scaled median absolute deviation", () => {
    expect(baselineOf([])).toBeNull();
    expect(baselineOf([5])).toEqual({ median: 5, mad: 0, runs: 1 });
    const b = baselineOf([1, 2, 3, 4, 100]);
    expect(b?.median).toBe(3);
    expect(b?.mad).toBeCloseTo(1.4826, 4);
  });

  it("is not moved by one outlier the way a mean would be", () => {
    const b = baselineOf([300, 310, 290, 305, 295, 50_000]);
    expect(b?.median).toBe(302.5);
  });

  it("needs a run to clear the deviation band, a multiple and the floor", () => {
    const steady = { median: 100, mad: 0, runs: 10 };
    // A perfectly steady object still gets a spread of a tenth of its median.
    expect(changeRateThreshold(steady, { madFactor: 8, minRatio: 2 }, 0)).toBe(200);
    expect(changeRateThreshold(steady, { madFactor: 8, minRatio: 5 }, 0)).toBe(500);
    expect(changeRateThreshold(steady, { madFactor: 8, minRatio: 5 }, 1000)).toBe(1000);
    const noisy = { median: 100, mad: 50, runs: 10 };
    expect(changeRateThreshold(noisy, { madFactor: 8, minRatio: 2 }, 0)).toBe(500);
  });
});

describe("judging a restore point", () => {
  it("passes an ordinary day and says which signals had no data", () => {
    const result = evaluateSuspicion({ current: run(320, 210 * 1024 ** 2), history, settings });
    expect(result).toEqual({
      verdict: "none",
      findings: [],
      signals: {
        changeRate: "clear",
        deletions: "unavailable",
        renames: "unavailable",
        names: "unavailable",
        entropy: "unavailable",
        compressibility: "unavailable",
      },
      signaturesVersion: RANSOMWARE_SIGNATURES_VERSION,
    });
  });

  it("is still learning with fewer clean restore points than the minimum", () => {
    const result = evaluateSuspicion({
      current: run(90_000, 50 * 1024 ** 3),
      history: history.slice(0, 4),
      settings,
    });
    expect(result.verdict).toBe("none");
    expect(result.signals.changeRate).toBe("learning");
  });

  it("flags a change far above the object's own baseline, with the numbers", () => {
    const result = evaluateSuspicion({
      current: run(40_000, 30 * 1024 ** 3),
      history,
      settings,
    });
    expect(result.verdict).toBe("suspicious");
    expect(result.signals.changeRate).toBe("fired");
    expect(result.findings.map((f) => f.code)).toEqual(["change_rate_items", "change_rate_bytes"]);
    expect(result.findings[0]).toMatchObject({ value: 40_000, baseline: 308 });
    expect(result.findings[0]?.threshold).toBeGreaterThan(308);
  });

  it("does not flag a small object for a jump below the absolute floor", () => {
    const tiny = Array.from({ length: 10 }, () => run(2, 10_000));
    const result = evaluateSuspicion({
      current: run(400, 500 * 1024 ** 2),
      history: tiny,
      settings,
    });
    expect(result.verdict).toBe("none");
  });

  it("flags mass deletions and mass extension renames", () => {
    const result = evaluateSuspicion({
      current: run(300, 1024, {
        itemsTotal: 2_000,
        activity: activity({
          removed: 3_000,
          renamed: 1_500,
          extensions: [
            { value: "akira", count: 1_500 },
            { value: "txt", count: 30 },
          ],
        }),
      }),
      history,
      settings,
    });
    expect(result.verdict).toBe("suspicious");
    const codes = result.findings.map((f) => f.code);
    expect(codes).toEqual(["mass_deletions", "mass_renames", "known_extensions"]);
    expect(result.findings.find((f) => f.code === "mass_deletions")?.share).toBe(0.6);
    expect(result.findings.find((f) => f.code === "known_extensions")?.examples).toEqual([
      ".akira",
    ]);
  });

  it("flags ransom notes dropped into several folders, not a single look-alike", () => {
    const notes = (count: number) =>
      evaluateSuspicion({
        current: run(300, 1024, {
          activity: activity({ names: [{ value: "HOW_TO_RECOVER_FILES.txt", count }] }),
        }),
        history,
        settings,
      });
    expect(notes(1).verdict).toBe("none");
    const result = notes(37);
    expect(result.verdict).toBe("suspicious");
    expect(result.findings).toEqual([
      {
        code: "ransom_notes",
        value: 37,
        threshold: 2,
        examples: ["HOW_TO_RECOVER_FILES.txt"],
      },
    ]);
  });

  it("flags sampled files that look encrypted for their type, ignoring compressed ones", () => {
    const sample = (path: string, ext: string, head: number, tail: number | null) => ({
      path,
      ext,
      size: 200_000,
      head,
      tail,
    });
    const encrypted = activity({
      entropy: [
        sample("/a.csv", "csv", 7.99, 7.99),
        sample("/b.txt", "txt", 7.98, 4.1),
        sample("/c.doc", "doc", 7.99, 7.99),
        sample("/d.jpg", "jpg", 7.99, 7.99),
        sample("/e.zip", "zip", 7.99, 7.99),
      ],
    });
    const result = evaluateSuspicion({
      current: run(300, 1024, { activity: encrypted }),
      history,
      settings,
    });
    expect(result.signals.entropy).toBe("fired");
    expect(result.findings).toEqual([
      {
        code: "high_entropy",
        value: 3,
        threshold: 3,
        share: 1,
        examples: ["/a.csv", "/b.txt", "/c.doc"],
      },
    ]);

    // Only compressed samples: nothing to judge.
    const pictures = activity({ entropy: [sample("/d.jpg", "jpg", 7.99, 7.99)] });
    const none = evaluateSuspicion({
      current: run(300, 1024, { activity: pictures }),
      history,
      settings,
    });
    expect(none.signals.entropy).toBe("unavailable");

    // Intact text.
    const text = activity({
      entropy: ["/a.txt", "/b.txt", "/c.txt", "/d.txt"].map((p) => sample(p, "txt", 4.5, 4.4)),
    });
    expect(
      evaluateSuspicion({ current: run(300, 1024, { activity: text }), history, settings }).signals
        .entropy,
    ).toBe("clear");
  });

  it("leaves a signal the installation switched off alone", () => {
    const off = resolveRansomwareSettings({
      changeRate: { enabled: false },
      names: { enabled: false },
    });
    const result = evaluateSuspicion({
      current: run(40_000, 30 * 1024 ** 3, {
        activity: activity({ names: [{ value: "_readme.txt", count: 50 }] }),
      }),
      history,
      settings: off,
    });
    expect(result.verdict).toBe("none");
    expect(result.signals.changeRate).toBe("off");
    expect(result.signals.names).toBe("off");
    expect(result.signals.deletions).toBe("clear");
  });

  it("judges objects without file counts by their bytes alone", () => {
    const vm = Array.from({ length: 10 }, (_, i) => ({
      itemsChanged: null,
      itemsTotal: null,
      bytesAdded: (2 + (i % 3)) * 1024 ** 3,
      activity: null,
    }));
    const result = evaluateSuspicion({
      current: { itemsChanged: null, itemsTotal: null, bytesAdded: 80 * 1024 ** 3, activity: null },
      history: vm,
      settings,
    });
    expect(result.findings.map((f) => f.code)).toEqual(["change_rate_bytes"]);
  });
});

describe("episodes", () => {
  it("alert the first suspicious restore point, not the ones that follow it", () => {
    expect(opensSuspicionEpisode("suspicious", null)).toBe(true);
    expect(opensSuspicionEpisode("suspicious", { verdict: "none", falseAlarm: false })).toBe(true);
    expect(opensSuspicionEpisode("suspicious", { verdict: "suspicious", falseAlarm: false })).toBe(
      false,
    );
    // A false alarm ends the episode: the next finding is news.
    expect(opensSuspicionEpisode("suspicious", { verdict: "suspicious", falseAlarm: true })).toBe(
      true,
    );
    expect(opensSuspicionEpisode("none", null)).toBe(false);
  });

  it("end with the release of the retention hold", () => {
    expect(
      opensSuspicionEpisode("suspicious", {
        verdict: "suspicious",
        falseAlarm: false,
        released: true,
      }),
    ).toBe(true);
  });
});

describe("compression and deduplication", () => {
  const GiB = 1024 ** 3;
  /** A VM whose changed blocks compress to about 45 % and deduplicate to about 40 % new. */
  const vm: RunMetrics[] = Array.from({ length: 14 }, (_, i) => ({
    itemsChanged: null,
    itemsTotal: null,
    bytesAdded: (3 + (i % 3)) * GiB,
    activity: null,
    newBytes: (1 + (i % 2)) * GiB,
    compressionRatio: 0.42 + (i % 4) * 0.02,
    dedupRatio: 0.35 + (i % 3) * 0.05,
  }));
  /** A VM with an encrypted disk (BitLocker): its new data never compresses or deduplicates. */
  const encryptedDisk: RunMetrics[] = vm.map((m, i) => ({
    ...m,
    compressionRatio: 0.995 + (i % 2) * 0.004,
    dedupRatio: 0.97 + (i % 3) * 0.01,
  }));
  /** A day whose change in bytes stays ordinary, but whose new data looks random. */
  const encryptedDay: RunMetrics = {
    itemsChanged: null,
    itemsTotal: null,
    bytesAdded: 5 * GiB,
    activity: null,
    newBytes: 4 * GiB,
    compressionRatio: 0.998,
    dedupRatio: 0.99,
  };

  it("needs a ratio above the bound, the rise and the median's spread", () => {
    expect(
      ratioThreshold({ median: 0.45, mad: 0.02, runs: 14 }, { madFactor: 6 }, 0.95, 0.15),
    ).toBe(0.95);
    // Always incompressible: the bound lies above what any ratio can reach.
    expect(
      ratioThreshold({ median: 0.996, mad: 0.003, runs: 14 }, { madFactor: 6 }, 0.95, 0.15),
    ).toBeGreaterThan(1.1);
  });

  it("flags new data that suddenly stops compressing and deduplicating", () => {
    const result = evaluateSuspicion({ current: encryptedDay, history: vm, settings });
    expect(result.verdict).toBe("suspicious");
    expect(result.signals.compressibility).toBe("fired");
    expect(result.signals.changeRate).toBe("clear");
    expect(result.findings.map((f) => f.code)).toEqual(["incompressible_data", "dedup_collapse"]);
    expect(result.findings[0]).toMatchObject({
      value: 0.998,
      threshold: 0.95,
      bytes: 4 * GiB,
    });
    expect(result.findings[0]?.baseline).toBeCloseTo(0.45, 1);
  });

  it("never alerts an object whose new data is always incompressible", () => {
    const result = evaluateSuspicion({ current: encryptedDay, history: encryptedDisk, settings });
    expect(result.verdict).toBe("none");
    expect(result.signals.compressibility).toBe("clear");
  });

  it("ignores small runs, says learning and unavailable, and can be switched off", () => {
    const small = { ...encryptedDay, newBytes: 10 * 1024 ** 2, bytesAdded: 10 * 1024 ** 2 };
    const quiet = evaluateSuspicion({ current: small, history: vm, settings });
    expect(quiet.signals.compressibility).toBe("clear");
    expect(
      evaluateSuspicion({ current: encryptedDay, history: vm.slice(0, 3), settings }).signals
        .compressibility,
    ).toBe("learning");
    expect(
      evaluateSuspicion({
        current: { ...encryptedDay, compressionRatio: null, dedupRatio: undefined },
        history: vm,
        settings,
      }).signals.compressibility,
    ).toBe("unavailable");
    const off = resolveRansomwareSettings({ compressibility: { enabled: false } });
    expect(
      evaluateSuspicion({ current: encryptedDay, history: vm, settings: off }).signals
        .compressibility,
    ).toBe("off");
  });

  it("judges a single ratio when the source reports only one", () => {
    const result = evaluateSuspicion({
      current: { ...encryptedDay, dedupRatio: null },
      history: vm,
      settings,
    });
    expect(result.findings.map((f) => f.code)).toEqual(["incompressible_data"]);
  });
});
