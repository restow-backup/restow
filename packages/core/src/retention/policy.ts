import type { SnapshotRetentionPolicy } from "./selection.js";
import {
  type BuiltinRetentionPreset,
  KEEP_ALL_TIERS,
  type RetentionPreset,
  type RetentionTier,
  isRetentionPreset,
  presetTiers,
} from "./tiers.js";

/**
 * A `retention_policies` row as the snapshot rule reads it (docs/ARCHIVE.md
 * for the table; rows whose `applies_to.target` is not `"snapshots"` govern
 * the archive instead and are ignored here). The scope, preset and tiers all
 * live in `applies_to`; the plain `years` column is read only as a fallback,
 * for a row saved before the preset scheme existed (see {@link legacyTiers}).
 */
export interface RetentionPolicyRow {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly appliesTo: Record<string, unknown> | null;
  /** The plain retention-years column; the fallback a row saved before presets existed reads. */
  readonly years?: number | null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * A row saved before presets existed: no `preset` at all, just its own
 * `keepDays` (or, older still, the plain `years` column). Read as a single
 * flat-cutoff tier so the worker enforces exactly what the row always
 * promised, instead of silently keeping everything because it predates the
 * preset scheme (docs/ARCHIVE.md; @restow/db `retention_policies.years`).
 */
function legacyTiers(row: RetentionPolicyRow, scope: Record<string, unknown>): RetentionTier[] {
  const years = row.years;
  const keepDays =
    nonNegativeInt(scope.keepDays) ?? (years != null && years >= 0 ? years * 365 : null);
  return keepDays === null
    ? [...KEEP_ALL_TIERS]
    : [{ fromDays: 0, toDays: keepDays, keepEveryDays: 0 }];
}

/**
 * A row saved before presets existed also carried its own `keepLast` (the
 * newest N restore points of an object, kept regardless of age); undefined
 * when the row never set one (the tiered rule's own guard, the newest one
 * only, then applies).
 */
function legacyKeepLast(scope: Record<string, unknown>): number | undefined {
  const value = nonNegativeInt(scope.keepLast);
  return value !== null && value > 0 ? value : undefined;
}

function isTier(value: unknown): value is RetentionTier {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const tier = value as Record<string, unknown>;
  return (
    typeof tier.fromDays === "number" &&
    (tier.toDays === null || typeof tier.toDays === "number") &&
    typeof tier.keepEveryDays === "number"
  );
}

function tiersOfScope(
  scope: Record<string, unknown>,
  preset: RetentionPreset,
): RetentionTier[] | null {
  if (preset !== "custom") {
    return [...presetTiers(preset as BuiltinRetentionPreset)];
  }
  const raw = scope.tiers;
  if (!Array.isArray(raw) || raw.length === 0) {
    return null;
  }
  const tiers = raw.filter(isTier);
  return tiers.length === raw.length ? tiers : null;
}

/** The row as a snapshot retention policy, or null when it governs something else or is unreadable. */
export function parseSnapshotPolicy(row: RetentionPolicyRow): SnapshotRetentionPolicy | null {
  const scope = (row.appliesTo ?? {}) as Record<string, unknown>;
  if (scope.target !== "snapshots") {
    return null;
  }
  const preset = isRetentionPreset(scope.preset) ? scope.preset : null;
  const tiers = preset ? tiersOfScope(scope, preset) : legacyTiers(row, scope);
  if (!tiers) {
    return null;
  }
  const ids = Array.isArray(scope.protectedObjectIds)
    ? scope.protectedObjectIds.filter((id): id is string => typeof id === "string")
    : null;
  // Only a legacy row (no preset) carries its own keepLast; a preset-based
  // policy relies on the tiered rule's own guard (the newest one only).
  const keepLast = preset ? undefined : legacyKeepLast(scope);
  return {
    policyId: row.id,
    tiers,
    protectedObjectIds: ids && ids.length > 0 ? ids : null,
    isDefault: row.isDefault,
    ...(keepLast !== undefined ? { keepLast } : {}),
  };
}

/**
 * The `applies_to` JSON to store for a snapshot policy. `tiers` is written
 * only for a custom preset; a built-in preset's tiers are looked up fresh on
 * every read, so a later definition change (should the defaults ever move)
 * applies to policies already saved.
 */
export function policyAppliesTo(
  preset: RetentionPreset,
  tiers: readonly RetentionTier[],
  protectedObjectIds: readonly string[] | null,
): Record<string, unknown> {
  return {
    target: "snapshots",
    preset,
    ...(preset === "custom" ? { tiers } : {}),
    ...(protectedObjectIds && protectedObjectIds.length > 0 ? { protectedObjectIds } : {}),
  };
}
