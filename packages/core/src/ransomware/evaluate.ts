/**
 * Judging one restore point (docs/RANSOMWARE.md, "Signals"): its measured numbers against the
 * object's own baseline and against the name and entropy signatures. Pure; the worker loads the
 * numbers and the history (apps/worker/src/suspicion) and stores what comes out.
 *
 *   changeRate  new and changed files (items) and bytes added, against the median and the
 *               median absolute deviation of the object's last clean restore points
 *   deletions   files removed against the previous restore point, absolute and as a share
 *   renames     files whose extension changed or got one appended
 *   names       files with a known ransomware extension; ransom note names
 *   entropy     sampled new or changed files that look encrypted for their type
 *
 * A restore point is suspicious when one signal fires. Each signal says whether it could be
 * judged at all: "learning" while the baseline is too short, "unavailable" when the runner sent
 * nothing for it (an older agent, a first backup, a kind without that data), "off" when the
 * installation switched it off.
 */
import type { ActivityReport } from "./activity.js";
import { looksEncrypted } from "./entropy.js";
import type { RansomwareSettings } from "./settings.js";
import {
  isRansomNoteName,
  isRansomwareExtension,
  normaliseExtension,
  RANSOMWARE_SIGNATURES_VERSION,
} from "./signatures.js";

/** What a restore point is of. `m365` covers mailboxes, OneDrives and IMAP accounts. */
export const SUSPICION_OBJECT_KINDS = ["endpoint", "file_share", "pve_guest", "m365"] as const;
export type SuspicionObjectKind = (typeof SUSPICION_OBJECT_KINDS)[number];

export function isSuspicionObjectKind(value: string): value is SuspicionObjectKind {
  return (SUSPICION_OBJECT_KINDS as readonly string[]).includes(value);
}

/** The numbers of one backup run, as far as its kind has them (null: unknown). */
export interface RunMetrics {
  /** New plus changed files (mail and OneDrive: items written). */
  itemsChanged: number | null;
  /** Files (items) in the restore point. */
  itemsTotal: number | null;
  /** Bytes the run added to the repository. */
  bytesAdded: number | null;
  activity: ActivityReport | null;
}

export const SUSPICION_SIGNALS = [
  "changeRate",
  "deletions",
  "renames",
  "names",
  "entropy",
] as const;
export type SuspicionSignal = (typeof SUSPICION_SIGNALS)[number];
export type SignalState = "clear" | "fired" | "learning" | "unavailable" | "off";

export const SUSPICION_FINDING_CODES = [
  "change_rate_items",
  "change_rate_bytes",
  "mass_deletions",
  "mass_renames",
  "known_extensions",
  "ransom_notes",
  "high_entropy",
] as const;
export type SuspicionFindingCode = (typeof SUSPICION_FINDING_CODES)[number];

/** One reason, with the numbers that made it. */
export interface SuspicionFinding {
  code: SuspicionFindingCode;
  /** What was measured: files, bytes or samples. */
  value: number;
  /** The bound it crossed. */
  threshold: number;
  /** The baseline's median (change rate only). */
  baseline?: number;
  /** The measured share (deletions, renames, entropy), 0 to 1. */
  share?: number;
  /** A few names (extensions, note names, sampled files) for the admin. */
  examples?: string[];
}

export type SuspicionVerdict = "none" | "suspicious";

export interface SuspicionResult {
  verdict: SuspicionVerdict;
  findings: SuspicionFinding[];
  signals: Record<SuspicionSignal, SignalState>;
  signaturesVersion: string;
}

/** The scale that makes the median absolute deviation comparable to a standard deviation. */
const MAD_SCALE = 1.4826;

export interface Baseline {
  median: number;
  /** The scaled median absolute deviation. */
  mad: number;
  runs: number;
}

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** The median and the scaled median absolute deviation of `values`; null for none. */
export function baselineOf(values: readonly number[]): Baseline | null {
  const finite = values.filter((v) => Number.isFinite(v) && v >= 0);
  if (finite.length === 0) {
    return null;
  }
  const sorted = [...finite].sort((a, b) => a - b);
  const m = median(sorted);
  const deviations = sorted.map((v) => Math.abs(v - m)).sort((a, b) => a - b);
  return { median: m, mad: median(deviations) * MAD_SCALE, runs: finite.length };
}

/**
 * The bound a run's value must exceed: `madFactor` deviations above the median (a deviation of
 * at least a tenth of the median, so a perfectly steady object does not alert on noise), at
 * least `minRatio` times the median, and at least the absolute floor.
 */
export function changeRateThreshold(
  baseline: Baseline,
  settings: { madFactor: number; minRatio: number },
  floor: number,
): number {
  const spread = Math.max(baseline.mad, baseline.median * 0.1, 1);
  return Math.ceil(
    Math.max(
      baseline.median + settings.madFactor * spread,
      baseline.median * settings.minRatio,
      floor,
    ),
  );
}

function share(part: number, whole: number): number {
  return whole > 0 ? Math.min(1, part / whole) : 0;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

interface Judged {
  state: SignalState;
  findings: SuspicionFinding[];
}

function changeRate(
  current: RunMetrics,
  history: readonly RunMetrics[],
  settings: RansomwareSettings,
): Judged {
  if (!settings.changeRate.enabled) return { state: "off", findings: [] };
  const findings: SuspicionFinding[] = [];
  let judged = false;
  let learning = false;
  const measures: [
    SuspicionFindingCode,
    number | null,
    (m: RunMetrics) => number | null,
    number,
  ][] = [
    [
      "change_rate_items",
      current.itemsChanged,
      (m) => m.itemsChanged,
      settings.changeRate.minItems,
    ],
    ["change_rate_bytes", current.bytesAdded, (m) => m.bytesAdded, settings.changeRate.minBytes],
  ];
  for (const [code, value, pick, floor] of measures) {
    if (value === null) continue;
    const past = history
      .slice(0, settings.baselineRuns)
      .map(pick)
      .filter((v): v is number => v !== null);
    if (past.length < settings.minBaselineRuns) {
      learning = true;
      continue;
    }
    const baseline = baselineOf(past);
    if (!baseline) continue;
    judged = true;
    const threshold = changeRateThreshold(baseline, settings.changeRate, floor);
    if (value > threshold) {
      findings.push({ code, value, threshold, baseline: Math.round(baseline.median) });
    }
  }
  if (findings.length > 0) return { state: "fired", findings };
  if (judged) return { state: "clear", findings };
  return { state: learning ? "learning" : "unavailable", findings };
}

function deletions(current: RunMetrics, settings: RansomwareSettings): Judged {
  if (!settings.deletions.enabled) return { state: "off", findings: [] };
  const activity = current.activity;
  if (!activity) return { state: "unavailable", findings: [] };
  const removed = activity.removed;
  // What was there before: what is there now plus what went.
  const before = (current.itemsTotal ?? 0) + removed;
  const part = share(removed, before);
  if (removed >= settings.deletions.minFiles && part >= settings.deletions.minShare) {
    return {
      state: "fired",
      findings: [
        {
          code: "mass_deletions",
          value: removed,
          threshold: settings.deletions.minFiles,
          share: round(part),
        },
      ],
    };
  }
  return { state: "clear", findings: [] };
}

function renames(current: RunMetrics, settings: RansomwareSettings): Judged {
  if (!settings.renames.enabled) return { state: "off", findings: [] };
  const activity = current.activity;
  if (!activity) return { state: "unavailable", findings: [] };
  const total = Math.max(current.itemsTotal ?? 0, activity.renamed);
  const part = share(activity.renamed, total);
  if (activity.renamed >= settings.renames.minFiles && part >= settings.renames.minShare) {
    const top = activity.extensions.slice(0, 3).map((entry) => `.${entry.value}`);
    return {
      state: "fired",
      findings: [
        {
          code: "mass_renames",
          value: activity.renamed,
          threshold: settings.renames.minFiles,
          share: round(part),
          examples: top,
        },
      ],
    };
  }
  return { state: "clear", findings: [] };
}

function names(current: RunMetrics, settings: RansomwareSettings): Judged {
  if (!settings.names.enabled) return { state: "off", findings: [] };
  const activity = current.activity;
  if (!activity) return { state: "unavailable", findings: [] };
  const findings: SuspicionFinding[] = [];
  const known = activity.extensions.filter((entry) => isRansomwareExtension(entry.value));
  const knownFiles = known.reduce((sum, entry) => sum + entry.count, 0);
  if (knownFiles >= settings.names.minExtensionFiles) {
    findings.push({
      code: "known_extensions",
      value: knownFiles,
      threshold: settings.names.minExtensionFiles,
      examples: known.slice(0, 5).map((entry) => `.${normaliseExtension(entry.value)}`),
    });
  }
  const notes = activity.names.filter((entry) => isRansomNoteName(entry.value));
  const noteFiles = notes.reduce((sum, entry) => sum + entry.count, 0);
  if (noteFiles >= settings.names.minNoteCopies) {
    findings.push({
      code: "ransom_notes",
      value: noteFiles,
      threshold: settings.names.minNoteCopies,
      examples: notes.slice(0, 5).map((entry) => entry.value),
    });
  }
  return { state: findings.length > 0 ? "fired" : "clear", findings };
}

function entropy(current: RunMetrics, settings: RansomwareSettings): Judged {
  if (!settings.entropy.enabled) return { state: "off", findings: [] };
  const activity = current.activity;
  if (!activity) return { state: "unavailable", findings: [] };
  const judged = activity.entropy
    .map((sample) => ({ sample, high: looksEncrypted(sample, settings.entropy.highBits) }))
    .filter(
      (entry): entry is { sample: (typeof entry)["sample"]; high: boolean } => entry.high !== null,
    );
  if (judged.length < settings.entropy.minSamples) {
    return { state: "unavailable", findings: [] };
  }
  const high = judged.filter((entry) => entry.high);
  const part = share(high.length, judged.length);
  if (high.length >= settings.entropy.minSamples && part >= settings.entropy.minHighShare) {
    return {
      state: "fired",
      findings: [
        {
          code: "high_entropy",
          value: high.length,
          threshold: settings.entropy.minSamples,
          share: round(part),
          examples: high.slice(0, 3).map((entry) => entry.sample.path),
        },
      ],
    };
  }
  return { state: "clear", findings: [] };
}

/**
 * Judge one restore point. `history` holds the metrics of the object's earlier restore points
 * that count for the baseline (clean ones and false alarms), newest first.
 */
export function evaluateSuspicion(input: {
  current: RunMetrics;
  history: readonly RunMetrics[];
  settings: RansomwareSettings;
}): SuspicionResult {
  const { current, history, settings } = input;
  const judged: Record<SuspicionSignal, Judged> = {
    changeRate: changeRate(current, history, settings),
    deletions: deletions(current, settings),
    renames: renames(current, settings),
    names: names(current, settings),
    entropy: entropy(current, settings),
  };
  const findings = SUSPICION_SIGNALS.flatMap((signal) => judged[signal].findings);
  return {
    verdict: findings.length > 0 ? "suspicious" : "none",
    findings,
    signals: Object.fromEntries(
      SUSPICION_SIGNALS.map((signal) => [signal, judged[signal].state]),
    ) as Record<SuspicionSignal, SignalState>,
    signaturesVersion: RANSOMWARE_SIGNATURES_VERSION,
  };
}

/** The earlier judgement of the same object, as far as the episode rule needs it. */
export interface PreviousJudgement {
  verdict: SuspicionVerdict;
  falseAlarm: boolean;
}

/**
 * Whether a suspicious restore point opens a new episode and is alerted (docs/RANSOMWARE.md,
 * "Alerts"): yes, unless the object's previous judged restore point was suspicious as well and
 * nobody called that one a false alarm. An episode ends with a clean restore point or a false
 * alarm, so one attack that spans several backups raises one alert, not one per backup.
 */
export function opensSuspicionEpisode(
  verdict: SuspicionVerdict,
  previous: PreviousJudgement | null,
): boolean {
  if (verdict !== "suspicious") {
    return false;
  }
  return !(previous && previous.verdict === "suspicious" && !previous.falseAlarm);
}
