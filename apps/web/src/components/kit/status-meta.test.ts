import { resources } from "@restow/i18n";
import { beforeAll, describe, expect, it } from "vitest";

import { MACHINE_STATUS_META, MACHINE_STATUS_ORDER } from "@/features/endpoints/machine-status";
import type { RestoreCheckState as HistoryRestoreCheckState } from "@/features/history/api";
import { JOB_STATUSES } from "@/features/jobs/api";
import { GUEST_STATUS_META, GUEST_STATUS_ORDER } from "@/features/pve/guest-status";
import type {
  CheckedItem,
  StorageState,
  VerifyDetails,
  VerificationState as VerifyVerificationState,
} from "@/features/verify/api";
import { READINESS_STATES } from "@/features/verify/search";
import { i18n } from "@/i18n";

import { STATUS_BADGE_VARIANT, STATUS_TONE_ICON, type StatusTone } from "./status-badge.js";
import {
  aggregateReadiness,
  CHECKED_ITEM_STATE,
  fillClass,
  JOB_STATUS_META,
  OVERALL_META,
  overallMeta,
  overallRank,
  READINESS_BAR_ORDER,
  READINESS_CATEGORIES,
  READINESS_CATEGORY_META,
  READINESS_CATEGORY_OF_STATE,
  READINESS_FLAG_META,
  READINESS_TILE_ORDER,
  RESTORE_CHECK_META,
  type ReadinessStateCounts,
  RUN_STATUS_META,
  readinessBadgeMeta,
  readinessStateRank,
  SEVERITY_RANK,
  SEVERITY_TONE,
  type Severity,
  STATUS_FILL,
  STATUS_TEXT,
  STORAGE_INTEGRITY_META,
  STORAGE_TARGET_META,
  type StatusMeta,
  TEST_RESTORE_ITEM_STATE,
  toneOf,
  VERIFICATION_META,
  WAITING_FOR_FIRST_BACKUP_META,
} from "./status-meta.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

// The families must cover the feature unions; a new state there fails to compile here.
const _restoreChecks: Record<HistoryRestoreCheckState, StatusMeta> = RESTORE_CHECK_META;
const _verifications: Record<VerifyVerificationState, StatusMeta> = VERIFICATION_META;
const _storage: Record<StorageState, StatusMeta> = STORAGE_INTEGRITY_META;
type TestRestoreStatus = NonNullable<VerifyDetails["testRestore"]>["items"][number]["status"];
const _checkedItems: Record<CheckedItem["status"], unknown> = CHECKED_ITEM_STATE;
const _testRestore: Record<TestRestoreStatus, unknown> = TEST_RESTORE_ITEM_STATE;
void [_restoreChecks, _verifications, _storage, _checkedItems, _testRestore];

const TONES = Object.keys(STATUS_BADGE_VARIANT) as StatusTone[];

function lookup(tree: unknown, path: string): unknown {
  let node = tree;
  for (const part of path.split(".")) {
    if (node === null || typeof node !== "object") {
      return undefined;
    }
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** A fully qualified `ns:key` resolved in the shared resources of one language. */
function translated(language: "en" | "de", labelKey: string): unknown {
  const [namespace, path] = labelKey.split(":");
  const bundle = (resources[language] as Record<string, unknown>)[namespace ?? ""];
  return lookup(bundle, path ?? "");
}

const FAMILIES: Readonly<Record<string, Readonly<Record<string, StatusMeta>>>> = {
  readiness: READINESS_CATEGORY_META,
  readinessFlags: READINESS_FLAG_META,
  waiting: { waiting: WAITING_FOR_FIRST_BACKUP_META },
  overall: OVERALL_META,
  verification: VERIFICATION_META,
  restoreCheck: RESTORE_CHECK_META,
  storageIntegrity: STORAGE_INTEGRITY_META,
  storageTarget: STORAGE_TARGET_META,
  runStatus: RUN_STATUS_META,
  jobStatus: JOB_STATUS_META,
};

describe("status meta: completeness", () => {
  for (const [family, entries] of Object.entries(FAMILIES)) {
    it(`${family}: every entry has a severity, an icon, a pattern and a label in en and de`, () => {
      for (const [key, meta] of Object.entries(entries)) {
        const where = `${family}.${key}`;
        expect(Object.keys(SEVERITY_RANK), where).toContain(meta.severity);
        expect(["solid", "hatched"], where).toContain(meta.pattern);
        expect(typeof meta.icon === "function" || typeof meta.icon === "object", where).toBe(true);
        expect(meta.id.length, where).toBeGreaterThan(0);
        expect(meta.labelKey, where).toMatch(/^[a-z]+:[\w.]+$/);
        for (const language of ["en", "de"] as const) {
          const value = translated(language, meta.labelKey);
          expect(
            typeof value === "string" && value.trim().length > 0,
            `${where} (${language}): ${meta.labelKey}`,
          ).toBe(true);
        }
      }
    });
  }

  it("covers every readiness state of the address, and Confirmed empty", () => {
    expect(Object.keys(READINESS_CATEGORY_META).sort()).toEqual(
      [...READINESS_STATES, "empty"].sort(),
    );
    expect(Object.keys(READINESS_CATEGORY_OF_STATE).sort()).toEqual(
      Object.keys(READINESS_CATEGORY_META).sort(),
    );
    expect([...READINESS_TILE_ORDER].sort()).toEqual([...READINESS_STATES].sort());
    expect([...READINESS_BAR_ORDER].sort()).toEqual([...READINESS_STATES, "empty"].sort());
  });

  it("covers the aggregate's values and the queue's job statuses", () => {
    expect(Object.keys(OVERALL_META).sort()).toEqual(["green", "none", "red", "yellow"]);
    for (const status of JOB_STATUSES) {
      expect(JOB_STATUS_META[status], status).toBeDefined();
    }
  });

  it("gives every machine and guest state a tone of the status badge", () => {
    for (const key of MACHINE_STATUS_ORDER) {
      expect(TONES, `machine ${key}`).toContain(MACHINE_STATUS_META[key].tone);
    }
    for (const key of GUEST_STATUS_ORDER) {
      expect(TONES, `guest ${key}`).toContain(GUEST_STATUS_META[key].tone);
    }
    // A backup no restore test has read back is not proven: amber, as everywhere.
    expect(MACHINE_STATUS_META.unverified.tone).toBe("warning");
  });

  it("maps every severity to a tone, and every tone to a fill, a text colour and an icon", () => {
    for (const severity of Object.keys(SEVERITY_RANK) as Severity[]) {
      expect(TONES).toContain(SEVERITY_TONE[severity]);
    }
    for (const tone of TONES) {
      expect(STATUS_FILL[tone], tone).toMatch(/^bg-/);
      expect(STATUS_TEXT[tone], tone).toMatch(/^text-/);
      expect(STATUS_TONE_ICON[tone], tone).toBeDefined();
    }
    expect(STATUS_FILL.attention).toBe("bg-attention-fg");
    expect(STATUS_TEXT.attention).toBe("text-attention-fg");
  });
});

describe("status meta: the facts of a machine, a guest and a report", () => {
  it("draws a machine's readiness and flags in the meta's tones, so its badge matches its rows", () => {
    // Restore check found something: Needs attention (orange), never the amber of Unverified.
    expect(MACHINE_STATUS_META.restore_warning.tone).toBe(toneOf(READINESS_CATEGORY_META.yellow));
    expect(MACHINE_STATUS_META.restore_warning.tone).toBe("attention");
    expect(MACHINE_STATUS_META.restore_warning.icon).toBe(READINESS_CATEGORY_META.yellow.icon);
    expect(MACHINE_STATUS_META.unverified.icon).toBe(READINESS_CATEGORY_META.unverified.icon);
    expect(MACHINE_STATUS_META.restore_warning.icon).not.toBe(MACHINE_STATUS_META.unverified.icon);
    expect(MACHINE_STATUS_META.restore_failed.tone).toBe(toneOf(READINESS_CATEGORY_META.red));
    expect(MACHINE_STATUS_META.verified.tone).toBe(toneOf(READINESS_CATEGORY_META.green));
    expect(MACHINE_STATUS_META.check_overdue.tone).toBe(toneOf(READINESS_FLAG_META.overdue));
    expect(MACHINE_STATUS_META.no_job.tone).toBe(toneOf(READINESS_FLAG_META.noJob));
    for (const key of ["silent", "backup_overdue", "never_seen", "revoke_suggested"] as const) {
      expect(MACHINE_STATUS_META[key].tone, key).toBe("attention");
    }
    // A guest in no job is the same flag as on its readiness row.
    expect(GUEST_STATUS_META.no_job.tone).toBe(toneOf(READINESS_FLAG_META.noJob));
    expect(GUEST_STATUS_META.no_job.icon).toBe(READINESS_FLAG_META.noJob.icon);
  });

  it("rates a report's items as verifications: proof green, not confirmed amber, the rest red", () => {
    expect(CHECKED_ITEM_STATE).toEqual({
      verified: "green",
      mismatch: "red",
      missing: "red",
      unreadable: "red",
    });
    expect(TEST_RESTORE_ITEM_STATE).toEqual({
      confirmed: "green",
      unconfirmed: "unverified",
      failed: "red",
    });
    expect(toneOf(VERIFICATION_META[TEST_RESTORE_ITEM_STATE.unconfirmed])).toBe("warning");
  });
});

describe("status meta: Needs attention and Unverified stay apart", () => {
  const categories = READINESS_TILE_ORDER.map((state) => READINESS_CATEGORY_META[state]);

  it("gives the five categories five different icons", () => {
    expect(new Set(categories.map((meta) => meta.icon)).size).toBe(5);
  });

  it("draws Needs attention in the attention tone and Unverified in the warning tone, hatched", () => {
    expect(READINESS_CATEGORY_META.yellow.severity).toBe("attention");
    expect(toneOf(READINESS_CATEGORY_META.yellow)).toBe("attention");
    expect(READINESS_CATEGORY_META.unverified.severity).toBe("warning");
    expect(toneOf(READINESS_CATEGORY_META.unverified)).toBe("warning");
    expect(
      Object.values(READINESS_CATEGORY_META)
        .filter((meta) => meta.pattern === "hatched")
        .map((meta) => meta.id),
    ).toEqual(["unverified"]);
    expect(fillClass(READINESS_CATEGORY_META.unverified)).toContain("repeating-linear-gradient");
    expect(fillClass(READINESS_CATEGORY_META.yellow)).toBe("bg-attention-fg");
  });

  it("never gives two categories the same tone, icon and pattern", () => {
    const signatures = categories.map(
      (meta) => `${toneOf(meta)}|${meta.pattern}|${meta.icon.displayName ?? meta.id}`,
    );
    expect(new Set(signatures).size).toBe(categories.length);
    expect(new Set(categories.map((meta) => meta.icon)).size).toBe(categories.length);
  });

  it("puts each object state in its category", () => {
    expect(READINESS_CATEGORIES).toEqual([
      "ready",
      "needs_attention",
      "unverified",
      "not_restorable",
      "no_backup",
    ]);
    expect(READINESS_CATEGORY_OF_STATE).toEqual({
      green: "ready",
      yellow: "needs_attention",
      unverified: "unverified",
      red: "not_restorable",
      no_backup: "no_backup",
      empty: null,
    });
    for (const [state, category] of Object.entries(READINESS_CATEGORY_OF_STATE)) {
      if (category) {
        expect(READINESS_CATEGORY_META[state as keyof typeof READINESS_CATEGORY_META].id).toBe(
          category,
        );
      }
    }
  });

  it("sorts object states worst first and shows a fresh object as waiting", () => {
    expect(
      [...READINESS_BAR_ORDER].sort((a, b) => readinessStateRank(a) - readinessStateRank(b)),
    ).toEqual(["red", "no_backup", "yellow", "unverified", "green", "empty"]);
    expect(readinessBadgeMeta({ state: "no_backup", overdue: false })).toBe(
      WAITING_FOR_FIRST_BACKUP_META,
    );
    expect(readinessBadgeMeta({ state: "no_backup", overdue: true })).toBe(
      READINESS_CATEGORY_META.no_backup,
    );
    expect(READINESS_FLAG_META.overdue.severity).toBe("attention");
  });

  it("reads the aggregate's yellow as Not proven (warning), never as the object state's attention", () => {
    expect(OVERALL_META.yellow.severity).toBe("warning");
    expect(OVERALL_META.yellow.labelKey).not.toBe(READINESS_CATEGORY_META.yellow.labelKey);
    expect(overallMeta(null)).toBe(OVERALL_META.none);
    expect(overallMeta("bogus")).toBe(OVERALL_META.none);
    const ranked = ["green", null, "red", "yellow"].sort((a, b) => overallRank(a) - overallRank(b));
    expect(ranked).toEqual(["red", "yellow", "green", null]);
  });
});

/**
 * The same cases as packages/core/src/verify/readiness-aggregate.test.ts
 * (AGGREGATE_VECTORS): the web mirrors the rule it cannot import.
 */
const AGGREGATE_VECTORS: ReadonlyArray<{
  name: string;
  counts: ReadinessStateCounts;
  rated: number;
  expected: "green" | "yellow" | "red" | null;
}> = [
  {
    name: "the brief's case 0/0/1/1/18 reads Not proven",
    counts: { green: 1, yellow: 1, red: 0, unverified: 18, noBackup: 0 },
    rated: 20,
    expected: "yellow",
  },
  {
    name: "a not restorable object",
    counts: { green: 1, yellow: 0, red: 1, unverified: 0, noBackup: 0 },
    rated: 2,
    expected: "red",
  },
  {
    name: "an object without a backup",
    counts: { green: 1, yellow: 0, red: 0, unverified: 0, noBackup: 1 },
    rated: 2,
    expected: "red",
  },
  {
    name: "no backup yet beats everything below it",
    counts: { green: 1, yellow: 5, red: 0, unverified: 5, noBackup: 1 },
    rated: 12,
    expected: "red",
  },
  {
    name: "an unverified object",
    counts: { green: 1, yellow: 0, red: 0, unverified: 1, noBackup: 0 },
    rated: 2,
    expected: "yellow",
  },
  {
    name: "an object that needs attention",
    counts: { green: 1, yellow: 1, red: 0, unverified: 0, noBackup: 0 },
    rated: 2,
    expected: "yellow",
  },
  {
    name: "ready objects only",
    counts: { green: 3, yellow: 0, red: 0, unverified: 0, noBackup: 0 },
    rated: 3,
    expected: "green",
  },
  {
    name: "confirmed-empty objects only",
    counts: { green: 0, yellow: 0, red: 0, unverified: 0, noBackup: 0 },
    rated: 1,
    expected: "green",
  },
  {
    name: "nothing to rate",
    counts: { green: 0, yellow: 0, red: 0, unverified: 0, noBackup: 0 },
    rated: 0,
    expected: null,
  },
];

describe("aggregateReadiness (mirror of @restow/core)", () => {
  it.each(AGGREGATE_VECTORS)("$name -> $expected", ({ counts, rated, expected }) => {
    expect(aggregateReadiness(counts, rated)).toBe(expected);
  });

  it("reads the brief's case 0/0/1/1/18 as Not proven, in amber", () => {
    const overall = aggregateReadiness(
      { green: 1, yellow: 1, red: 0, unverified: 18, noBackup: 0 },
      20,
    );
    expect(overall).toBe("yellow");
    const meta = overallMeta(overall);
    expect(meta.severity).toBe("warning");
    expect(toneOf(meta)).toBe("warning");
    expect(i18n.t(meta.labelKey, { lng: "en" })).toBe("Not proven");
    expect(i18n.t(meta.labelKey, { lng: "de" })).toBe("Nicht vollständig nachgewiesen");
  });
});
