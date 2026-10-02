import { LIMITS } from "./api.js";

/**
 * Exclusions of a machine job as chips with stored patterns. The stored value is
 * the plain list of patterns the agent gets (`excludes`, one line each in
 * restic's `--exclude-file`); nothing else is stored. A chip is "on" when all
 * of its patterns are in the list, switching it on adds exactly its missing
 * patterns and switching it off removes exactly its patterns. The patterns that
 * belong to no chip that is on are the job's own patterns. Only exclusions: restic
 * has no include patterns, so there is no "back up only these file types".
 */

export const EXCLUSION_PRESET_IDS = [
  "videos",
  "diskImages",
  "temporary",
  "installers",
  "music",
  "trash",
] as const;

export type ExclusionPresetId = (typeof EXCLUSION_PRESET_IDS)[number];

export interface ExclusionPreset {
  id: ExclusionPresetId;
  /** The patterns the chip stands for. No two chips share a pattern. */
  patterns: readonly string[];
}

export const EXCLUSION_PRESETS: readonly ExclusionPreset[] = [
  { id: "videos", patterns: ["*.mp4", "*.mkv", "*.mov", "*.avi", "*.wmv", "*.m4v"] },
  { id: "diskImages", patterns: ["*.iso", "*.vhd", "*.vhdx", "*.vmdk", "*.qcow2", "*.img"] },
  { id: "temporary", patterns: ["*.tmp", "*.temp", "~$*", "*.swp", "*.part"] },
  { id: "installers", patterns: ["*.msi", "*.exe", "*.dmg", "*.pkg", "*.deb", "*.rpm"] },
  { id: "music", patterns: ["*.mp3", "*.flac", "*.aac", "*.m4a", "*.wav", "*.ogg"] },
  {
    id: "trash",
    patterns: [
      "**/.cache",
      "**/.Trash",
      "**/.Trashes",
      "**/.local/share/Trash",
      "**/Library/Caches",
      "**/$RECYCLE.BIN",
    ],
  },
];

/** Whether every pattern of the chip is in the list. */
export function presetIsOn(excludes: readonly string[], preset: ExclusionPreset): boolean {
  const stored = new Set(excludes);
  return preset.patterns.every((pattern) => stored.has(pattern));
}

/** The chips that are on. */
export function presetsOn(excludes: readonly string[]): ExclusionPresetId[] {
  return EXCLUSION_PRESETS.filter((preset) => presetIsOn(excludes, preset)).map(
    (preset) => preset.id,
  );
}

/**
 * The list with the chip switched: on adds its missing patterns (after the ones
 * already there), off removes all of its patterns. Other patterns keep their place.
 */
export function togglePreset(excludes: readonly string[], preset: ExclusionPreset): string[] {
  if (presetIsOn(excludes, preset)) {
    const own = new Set(preset.patterns);
    return excludes.filter((pattern) => !own.has(pattern));
  }
  const stored = new Set(excludes);
  return [...excludes, ...preset.patterns.filter((pattern) => !stored.has(pattern))];
}

/**
 * The patterns no chip that is on accounts for: the job's own patterns. A chip
 * that is only partly in the list is off, so its patterns show here.
 */
export function ownPatterns(excludes: readonly string[]): string[] {
  const covered = new Set(
    EXCLUSION_PRESETS.filter((preset) => presetIsOn(excludes, preset)).flatMap(
      (preset) => preset.patterns,
    ),
  );
  return excludes.filter((pattern) => !covered.has(pattern));
}

/** Add one own pattern at the end; a pattern already in the list is not added twice. */
export function addOwnPattern(excludes: readonly string[], pattern: string): string[] {
  const clean = pattern.trim();
  return clean === "" || excludes.includes(clean) ? [...excludes] : [...excludes, clean];
}

/** Remove one pattern wherever it stands. */
export function removePattern(excludes: readonly string[], pattern: string): string[] {
  return excludes.filter((candidate) => candidate !== pattern);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
const CONTROL_CHARACTERS = /[\u0000-\u001f]/;

export function hasControlCharacters(value: string): boolean {
  return CONTROL_CHARACTERS.test(value);
}

export type PatternProblem = "empty" | "controlCharacters" | "tooLong";

/** What the API would refuse about one pattern (no control characters, at most 512 characters). */
export function patternProblem(pattern: string): PatternProblem | null {
  const clean = pattern.trim();
  if (clean === "") return "empty";
  if (hasControlCharacters(clean)) return "controlCharacters";
  if (clean.length > LIMITS.excludeLength) return "tooLong";
  return null;
}

/** The patterns typed or pasted into the field: one per line, blanks dropped. */
export function patternsOfText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export type ExcludesProblem =
  | { code: "tooMany"; max: number }
  | { code: "controlCharacters"; value: string }
  | { code: "tooLong"; max: number; value: string };

/** The first thing wrong with the whole list, or null. */
export function excludesProblem(excludes: readonly string[]): ExcludesProblem | null {
  if (excludes.length > LIMITS.excludes) {
    return { code: "tooMany", max: LIMITS.excludes };
  }
  for (const pattern of excludes) {
    const problem = patternProblem(pattern);
    if (problem === "controlCharacters") {
      return { code: "controlCharacters", value: pattern };
    }
    if (problem === "tooLong") {
      return { code: "tooLong", max: LIMITS.excludeLength, value: pattern };
    }
  }
  return null;
}

/** A size limit typed in GB: a number above zero up to the API's limit; null when it is not one. */
export function parseLargerThanGib(text: string): number | null {
  const value = Number(text.trim().replace(",", "."));
  return Number.isFinite(value) && value > 0 && value <= LIMITS.excludeLargerThanGibMax
    ? value
    : null;
}
