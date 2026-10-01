import type { RetentionPolicyDto } from "./dto.js";

/**
 * How the dashboard reads the tenant's snapshot retention policies. The
 * worker's retention handler (apps/worker/src/handlers/retention.ts) and the
 * retention API (apps/api/src/features/retention) are what actually store and
 * enforce them, as a preset plus a tiered (grandfather-father-son) keep rule
 * (packages/core/src/retention); this widget only needs a rough summary, so
 * it reads the same `applies_to` shape (`target === "snapshots"`, a known
 * `preset`, `tiers` for a custom one) without depending on that package, and
 * boils it down to the two numbers {@link RetentionPolicyDto} shows: the age
 * past which nothing survives (`keepDays`, the last tier's upper bound; null
 * when the policy never expires anything by age) and that at least the
 * newest restore point of every object is always kept (`keepLast`, always 1
 * for a preset-based policy — see the tiered rule's guards). A row saved
 * before presets existed carries its own `keepDays`/`keepLast` (or, older
 * still, only the plain `years` column) instead; @restow/core's
 * `parseSnapshotPolicy` reads that same row the same way (a flat cutoff), so
 * the worker enforces exactly what this widget shows. Rows for other targets
 * govern the archive and are ignored here.
 */

export interface RetentionPolicyRow {
  name: string;
  years: number | null;
  isDefault: boolean;
  appliesTo: Record<string, unknown> | null;
}

interface Tier {
  fromDays: number;
  toDays: number | null;
  keepEveryDays: number;
}

/** A built-in preset id (packages/core/src/retention/tiers.ts), or how this widget marks a row it cannot name one for. */
export type DashboardRetentionPreset =
  | "default"
  | "30d"
  | "90d"
  | "1y"
  | "3y"
  | "7y"
  | "keep_all"
  | "custom"
  | "legacy";

/**
 * {@link RetentionPolicyDto} plus what the page needs to describe the rule
 * accurately instead of reducing it to a single cutoff: which preset it is
 * (a built-in one has a ready-made, accurate sentence), and, for a custom
 * policy, its own tiers, so the page can tell whether restore points are
 * thinned before the cutoff instead of all being kept up to it.
 *
 * `preset` is optional so a legacy row can serialize as the plain,
 * documented `RetentionPolicyDto` (see {@link summarizeRetention}); every
 * row this feature itself creates always names a preset.
 */
export interface DashboardRetentionPolicy extends RetentionPolicyDto {
  preset?: DashboardRetentionPreset;
  /** Only set for "custom": the tiers a built-in preset resolves to are looked up by id instead. */
  tiers?: Tier[];
}

interface SnapshotPolicy extends DashboardRetentionPolicy {
  isDefault: boolean;
  scoped: boolean;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function isTier(value: unknown): value is Tier {
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

/** The age past which a tier list keeps nothing; null when the last tier is open-ended. */
function cutoffOf(tiers: readonly Tier[]): number | null {
  if (tiers.length === 0) {
    return null;
  }
  const last = [...tiers].sort((a, b) => a.fromDays - b.fromDays).at(-1);
  return last?.toDays ?? null;
}

const YEAR_DAYS = 365;

/** The cutoff of a built-in preset, mirroring packages/core/src/retention/tiers.ts. */
function builtinCutoff(preset: string): number | null | undefined {
  switch (preset) {
    case "default":
      return YEAR_DAYS;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "1y":
      return YEAR_DAYS;
    case "3y":
      return YEAR_DAYS * 3;
    case "7y":
      return YEAR_DAYS * 7;
    case "keep_all":
      return null;
    default:
      return undefined;
  }
}

/** The row as a snapshot policy, or null when it governs something else or is unreadable. */
export function snapshotPolicyOf(row: RetentionPolicyRow): SnapshotPolicy | null {
  const scope = row.appliesTo ?? {};
  if (scope.target !== "snapshots") {
    return null;
  }
  const ids = Array.isArray(scope.protectedObjectIds)
    ? scope.protectedObjectIds.filter((id) => typeof id === "string")
    : [];
  const preset = typeof scope.preset === "string" ? scope.preset : null;
  if (preset === null) {
    // A row saved before presets existed: read its own keepDays/keepLast,
    // falling back to the plain years column (oldest rows have neither).
    const keepDays =
      nonNegativeInt(scope.keepDays) ??
      (row.years !== null && row.years >= 0 ? row.years * 365 : null);
    return {
      name: row.name,
      keepDays,
      keepLast: Math.max(1, nonNegativeInt(scope.keepLast) ?? 1),
      preset: "legacy",
      isDefault: row.isDefault,
      scoped: ids.length > 0,
    };
  }
  let keepDays: number | null;
  let tiers: Tier[] | undefined;
  if (preset === "custom") {
    tiers = Array.isArray(scope.tiers) ? scope.tiers.filter(isTier) : [];
    if (tiers.length === 0) {
      return null;
    }
    keepDays = cutoffOf(tiers);
  } else {
    const cutoff = builtinCutoff(preset);
    if (cutoff === undefined) {
      return null;
    }
    keepDays = cutoff;
  }
  return {
    name: row.name,
    // The tiered rule always keeps at least the newest restore point of an object.
    keepDays,
    keepLast: 1,
    preset: (preset === "custom" ? "custom" : preset) as DashboardRetentionPreset,
    tiers,
    isDefault: row.isDefault,
    scoped: ids.length > 0,
  };
}

/**
 * The tenant-wide policy (the default one first, as the worker picks it) and
 * the number of policies limited to single objects. No tenant-wide policy
 * means every snapshot is kept.
 *
 * The response's `policy` field is documented (dashboard/dto.ts
 * `RetentionPolicyDto`) as exactly `{name, keepDays, keepLast}` — a row saved
 * before presets existed ("legacy") only ever had those three fields, and a
 * caller of the DTO is entitled to rely on that shape (dashboard.pg.test.ts
 * asserts it with `toEqual`). A row this feature itself created always has a
 * named preset, so it is safe to widen with `preset`/`tiers` too: a wiring
 * request tracks folding that into the documented DTO and the web-side type
 * formally (packages/i18n aside, dto.ts and apps/web/.../dashboard/api.ts are
 * both outside this item's owned paths).
 */
export function summarizeRetention(rows: readonly RetentionPolicyRow[]): {
  policy: DashboardRetentionPolicy | null;
  scopedPolicies: number;
} {
  const policies = rows
    .map(snapshotPolicyOf)
    .filter((policy): policy is SnapshotPolicy => policy !== null);
  const tenantWide = policies.filter((policy) => !policy.scoped);
  const chosen = tenantWide.find((policy) => policy.isDefault) ?? tenantWide[0] ?? null;
  const policy: DashboardRetentionPolicy | null = chosen
    ? chosen.preset === "legacy"
      ? // The documented DTO shape exactly: a legacy row's `preset`/`tiers`
        // stay internal to this module, never reach the wire.
        { name: chosen.name, keepDays: chosen.keepDays, keepLast: chosen.keepLast }
      : {
          name: chosen.name,
          keepDays: chosen.keepDays,
          keepLast: chosen.keepLast,
          preset: chosen.preset,
          tiers: chosen.tiers,
        }
    : null;
  return {
    policy,
    scopedPolicies: policies.filter((policy) => policy.scoped).length,
  };
}
