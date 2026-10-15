/**
 * The thresholds of the ransomware detection, per installation (docs/RANSOMWARE.md,
 * "Thresholds"). Stored in `settings.ransomware_detection` as the values an owner changed; every
 * value left out takes its default, and every stored value is clamped into its range when it is
 * read, so a hand-edited row can never switch a signal into nonsense.
 */

export interface ChangeRateSettings {
  enabled: boolean;
  /** How many median absolute deviations above the median a run must lie. */
  madFactor: number;
  /** ... and how many times the median it must be at least. */
  minRatio: number;
  /** Below this many new and changed files (or items), nothing is unusual. */
  minItems: number;
  /** Below this many bytes added, nothing is unusual. */
  minBytes: number;
}

export interface RansomwareSettings {
  /** The whole detection; off: no results are computed and nothing is raised. */
  enabled: boolean;
  /** How many earlier clean restore points form an object's baseline. */
  baselineRuns: number;
  /** With fewer, the change rate is still being learned (signal "not available"). */
  minBaselineRuns: number;
  changeRate: ChangeRateSettings;
  /** Mass deletion: at least this many files and this share of what was there before. */
  deletions: { enabled: boolean; minFiles: number; minShare: number };
  /** Mass renames that changed the extension: at least this many files and this share. */
  renames: { enabled: boolean; minFiles: number; minShare: number };
  /**
   * Known names: files with a known ransomware extension (at least `minExtensionFiles`), and
   * ransom notes (at least `minNoteCopies` files with such a name).
   */
  names: { enabled: boolean; minExtensionFiles: number; minNoteCopies: number };
  /**
   * Entropy of sampled new files: at least `minSamples` judged, and at least `minHighShare` of
   * them at or above `highBits` bits per byte.
   */
  entropy: { enabled: boolean; minSamples: number; highBits: number; minHighShare: number };
  /** Compression and deduplication of the new data against the object's own baseline. */
  compressibility: CompressibilitySettings;
  /**
   * Retention pauses for an object while it has a suspicious restore point nobody resolved
   * (docs/RANSOMWARE.md, "Retention hold"); after `reminderDays` an unresolved hold is announced
   * again (`backup.suspicious_hold`), and every `reminderDays` after that.
   */
  retentionHold: { enabled: boolean; reminderDays: number };
}

/**
 * Encrypted data neither compresses nor deduplicates (docs/RANSOMWARE.md, "Compression and
 * deduplication"). Both ratios are judged against the object's own median, so an object whose new
 * data is always incompressible (media files, encrypted disks) never alerts: it would need a ratio
 * of `median + minRise`, which a ratio near 1.0 cannot reach.
 */
export interface CompressibilitySettings {
  enabled: boolean;
  /** Below this much new data (bytes), nothing is judged: small runs have noisy ratios. */
  minBytes: number;
  /** How many median absolute deviations above the median a ratio must lie. */
  madFactor: number;
  /** Stored / raw of the new data from which it counts as incompressible. */
  compressionMinRatio: number;
  /** ... and how far above the object's median compression ratio it must be at least. */
  compressionMinRise: number;
  /** New / processed from which deduplication counts as collapsed. */
  dedupMinRatio: number;
  /** ... and how far above the object's median deduplication ratio it must be at least. */
  dedupMinRise: number;
}

export const DEFAULT_RANSOMWARE_SETTINGS: RansomwareSettings = {
  enabled: true,
  baselineRuns: 14,
  minBaselineRuns: 5,
  changeRate: {
    enabled: true,
    madFactor: 8,
    minRatio: 5,
    minItems: 500,
    minBytes: 1024 ** 3,
  },
  deletions: { enabled: true, minFiles: 1000, minShare: 0.25 },
  renames: { enabled: true, minFiles: 100, minShare: 0.02 },
  names: { enabled: true, minExtensionFiles: 20, minNoteCopies: 2 },
  entropy: { enabled: true, minSamples: 3, highBits: 7.9, minHighShare: 0.5 },
  compressibility: {
    enabled: true,
    minBytes: 256 * 1024 ** 2,
    madFactor: 6,
    compressionMinRatio: 0.95,
    compressionMinRise: 0.15,
    dedupMinRatio: 0.8,
    dedupMinRise: 0.3,
  },
  retentionHold: { enabled: true, reminderDays: 14 },
};

/** The range of every number, for the API's validation and for clamping what is stored. */
export const RANSOMWARE_SETTING_RANGES = {
  baselineRuns: [3, 60],
  minBaselineRuns: [2, 30],
  "changeRate.madFactor": [2, 50],
  "changeRate.minRatio": [1.5, 100],
  "changeRate.minItems": [10, 10_000_000],
  "changeRate.minBytes": [1024 ** 2, 10 * 1024 ** 4],
  "deletions.minFiles": [10, 10_000_000],
  "deletions.minShare": [0.01, 1],
  "renames.minFiles": [5, 10_000_000],
  "renames.minShare": [0.001, 1],
  "names.minExtensionFiles": [1, 1_000_000],
  "names.minNoteCopies": [1, 1000],
  "entropy.minSamples": [1, 16],
  "entropy.highBits": [7, 8],
  "entropy.minHighShare": [0.1, 1],
  "compressibility.minBytes": [1024 ** 2, 10 * 1024 ** 4],
  "compressibility.madFactor": [2, 50],
  "compressibility.compressionMinRatio": [0.5, 1],
  "compressibility.compressionMinRise": [0.01, 0.9],
  "compressibility.dedupMinRatio": [0.1, 1],
  "compressibility.dedupMinRise": [0.01, 0.9],
  "retentionHold.reminderDays": [1, 365],
} as const satisfies Record<string, readonly [number, number]>;

export type RansomwareSettingKey = keyof typeof RANSOMWARE_SETTING_RANGES;

/** A stored override: any subset of the settings, nested like them. */
export type StoredRansomwareSettings = {
  [K in keyof RansomwareSettings]?: RansomwareSettings[K] extends object
    ? Partial<RansomwareSettings[K]>
    : RansomwareSettings[K];
};

function clamp(key: RansomwareSettingKey, value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const [min, max] = RANSOMWARE_SETTING_RANGES[key];
  return Math.min(max, Math.max(min, value));
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function section(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The effective settings: the stored overrides over the defaults, every value in range. */
export function resolveRansomwareSettings(stored: unknown): RansomwareSettings {
  const s = section(stored);
  const d = DEFAULT_RANSOMWARE_SETTINGS;
  const cr = section(s.changeRate);
  const del = section(s.deletions);
  const ren = section(s.renames);
  const names = section(s.names);
  const ent = section(s.entropy);
  const cmp = section(s.compressibility);
  const dc = d.compressibility;
  const hold = section(s.retentionHold);
  const baselineRuns = Math.round(clamp("baselineRuns", s.baselineRuns, d.baselineRuns));
  return {
    enabled: flag(s.enabled, d.enabled),
    baselineRuns,
    minBaselineRuns: Math.min(
      baselineRuns,
      Math.round(clamp("minBaselineRuns", s.minBaselineRuns, d.minBaselineRuns)),
    ),
    changeRate: {
      enabled: flag(cr.enabled, d.changeRate.enabled),
      madFactor: clamp("changeRate.madFactor", cr.madFactor, d.changeRate.madFactor),
      minRatio: clamp("changeRate.minRatio", cr.minRatio, d.changeRate.minRatio),
      minItems: Math.round(clamp("changeRate.minItems", cr.minItems, d.changeRate.minItems)),
      minBytes: Math.round(clamp("changeRate.minBytes", cr.minBytes, d.changeRate.minBytes)),
    },
    deletions: {
      enabled: flag(del.enabled, d.deletions.enabled),
      minFiles: Math.round(clamp("deletions.minFiles", del.minFiles, d.deletions.minFiles)),
      minShare: clamp("deletions.minShare", del.minShare, d.deletions.minShare),
    },
    renames: {
      enabled: flag(ren.enabled, d.renames.enabled),
      minFiles: Math.round(clamp("renames.minFiles", ren.minFiles, d.renames.minFiles)),
      minShare: clamp("renames.minShare", ren.minShare, d.renames.minShare),
    },
    names: {
      enabled: flag(names.enabled, d.names.enabled),
      minExtensionFiles: Math.round(
        clamp("names.minExtensionFiles", names.minExtensionFiles, d.names.minExtensionFiles),
      ),
      minNoteCopies: Math.round(
        clamp("names.minNoteCopies", names.minNoteCopies, d.names.minNoteCopies),
      ),
    },
    entropy: {
      enabled: flag(ent.enabled, d.entropy.enabled),
      minSamples: Math.round(clamp("entropy.minSamples", ent.minSamples, d.entropy.minSamples)),
      highBits: clamp("entropy.highBits", ent.highBits, d.entropy.highBits),
      minHighShare: clamp("entropy.minHighShare", ent.minHighShare, d.entropy.minHighShare),
    },
    compressibility: {
      enabled: flag(cmp.enabled, dc.enabled),
      minBytes: Math.round(clamp("compressibility.minBytes", cmp.minBytes, dc.minBytes)),
      madFactor: clamp("compressibility.madFactor", cmp.madFactor, dc.madFactor),
      compressionMinRatio: clamp(
        "compressibility.compressionMinRatio",
        cmp.compressionMinRatio,
        dc.compressionMinRatio,
      ),
      compressionMinRise: clamp(
        "compressibility.compressionMinRise",
        cmp.compressionMinRise,
        dc.compressionMinRise,
      ),
      dedupMinRatio: clamp("compressibility.dedupMinRatio", cmp.dedupMinRatio, dc.dedupMinRatio),
      dedupMinRise: clamp("compressibility.dedupMinRise", cmp.dedupMinRise, dc.dedupMinRise),
    },
    retentionHold: {
      enabled: flag(hold.enabled, d.retentionHold.enabled),
      reminderDays: Math.round(
        clamp("retentionHold.reminderDays", hold.reminderDays, d.retentionHold.reminderDays),
      ),
    },
  };
}
