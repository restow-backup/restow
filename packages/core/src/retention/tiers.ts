// Snapshot retention as a tiered (grandfather-father-son) keep rule: within
// each age tier at most one restore point survives per `keepEveryDays` (zero
// keeps every one in the tier), and age past every tier's upper bound is
// pruned. This is the exact rule apps/worker/src/handlers/retention.ts
// enforces and apps/api/src/features/retention previews, so a saved policy
// always previews as what actually happens (docs/ARCHIVE.md talks about the
// separate GoBD archive; this governs backup snapshots only).

/** One age band of a policy. Tiers of one policy must be contiguous, starting at day 0. */
export interface RetentionTier {
  /** Age in days at which this tier starts (inclusive). */
  readonly fromDays: number;
  /** Age in days at which this tier ends (exclusive); null = no upper bound. */
  readonly toDays: number | null;
  /** Keep one restore point per this many days within the tier; 0 keeps every one. */
  readonly keepEveryDays: number;
}

export const RETENTION_PRESETS = [
  "default",
  "30d",
  "90d",
  "1y",
  "3y",
  "7y",
  "keep_all",
  "custom",
] as const;
export type RetentionPreset = (typeof RETENTION_PRESETS)[number];
export type BuiltinRetentionPreset = Exclude<RetentionPreset, "custom">;

export function isRetentionPreset(value: unknown): value is RetentionPreset {
  return typeof value === "string" && (RETENTION_PRESETS as readonly string[]).includes(value);
}

const YEAR_DAYS = 365;

function flatCutoff(days: number): readonly RetentionTier[] {
  return [{ fromDays: 0, toDays: days, keepEveryDays: 0 }];
}

/**
 * The recommended default retention rule: every restore point for 30 days,
 * then one per day to 90 days, then one per week to 1 year; nothing
 * survives past a year.
 */
export const DEFAULT_TIERS: readonly RetentionTier[] = [
  { fromDays: 0, toDays: 30, keepEveryDays: 0 },
  { fromDays: 30, toDays: 90, keepEveryDays: 1 },
  { fromDays: 90, toDays: YEAR_DAYS, keepEveryDays: 7 },
];

/** No age limit; nothing is ever pruned by age. */
export const KEEP_ALL_TIERS: readonly RetentionTier[] = [
  { fromDays: 0, toDays: null, keepEveryDays: 0 },
];

/** The tiers of a built-in preset ("custom" has none of its own; the caller supplies them). */
export function presetTiers(preset: BuiltinRetentionPreset): readonly RetentionTier[] {
  switch (preset) {
    case "default":
      return DEFAULT_TIERS;
    case "30d":
      return flatCutoff(30);
    case "90d":
      return flatCutoff(90);
    case "1y":
      return flatCutoff(YEAR_DAYS);
    case "3y":
      return flatCutoff(YEAR_DAYS * 3);
    case "7y":
      return flatCutoff(YEAR_DAYS * 7);
    case "keep_all":
      return KEEP_ALL_TIERS;
  }
}

export interface TierIssue {
  /** The tier the problem was found at, in the given order; null for a whole-list problem. */
  readonly index: number | null;
  readonly code: string;
  readonly message: string;
}

/**
 * A custom tier list, checked for the shape {@link selectExpiredSnapshots}
 * relies on: at least one tier, starting at day 0, non-negative integer
 * bounds, contiguous (each tier's `toDays` equals the next tier's `fromDays`),
 * and only the last tier may be open-ended. Returns the first problem found,
 * or null when the list is usable.
 */
export function validateTiers(tiers: readonly RetentionTier[]): TierIssue | null {
  if (tiers.length === 0) {
    return { index: null, code: "empty", message: "At least one tier is required." };
  }
  const sorted = [...tiers].sort((a, b) => a.fromDays - b.fromDays);
  if (sorted[0]?.fromDays !== 0) {
    return { index: 0, code: "start", message: "The first tier must start at day 0." };
  }
  for (let i = 0; i < sorted.length; i++) {
    const tier = sorted[i];
    if (!tier) {
      continue;
    }
    if (!Number.isInteger(tier.fromDays) || tier.fromDays < 0) {
      return { index: i, code: "from_days", message: "fromDays must be a non-negative integer." };
    }
    if (!Number.isInteger(tier.keepEveryDays) || tier.keepEveryDays < 0) {
      return {
        index: i,
        code: "keep_every_days",
        message: "keepEveryDays must be 0 (keep every restore point) or a positive integer.",
      };
    }
    if (tier.toDays !== null) {
      if (!Number.isInteger(tier.toDays) || tier.toDays <= tier.fromDays) {
        return { index: i, code: "to_days", message: "toDays must be greater than fromDays." };
      }
    } else if (i !== sorted.length - 1) {
      return { index: i, code: "open_ended", message: "Only the last tier may be open-ended." };
    }
    const next = sorted[i + 1];
    if (next && tier.toDays !== next.fromDays) {
      return {
        index: i + 1,
        code: "gap",
        message:
          "Tiers must be contiguous: each tier's toDays must equal the next tier's fromDays.",
      };
    }
  }
  return null;
}

/** The age (in days, exclusive upper bound) past which the policy keeps nothing; null = forever. */
export function cutoffDays(tiers: readonly RetentionTier[]): number | null {
  const last = [...tiers].sort((a, b) => a.fromDays - b.fromDays).at(-1);
  return last?.toDays ?? null;
}
