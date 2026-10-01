import type { TFunction } from "i18next";

import { ApiError } from "@/lib/api";
import { formatInteger } from "@/lib/format";

import type {
  RetentionPolicy,
  RetentionPolicyInput,
  RetentionPreset,
  RetentionScopeObject,
  RetentionTier,
} from "./api.js";

/**
 * Pure display and draft logic for the retention page: no fetching, no
 * side effects, so it is trivial to test on its own (matches the style of
 * apps/web/src/features/schedules/presenters.ts).
 */

export const PRESET_ORDER: readonly RetentionPreset[] = [
  "default",
  "30d",
  "90d",
  "1y",
  "3y",
  "7y",
  "keep_all",
  "custom",
];

const YEAR_DAYS = 365;

/**
 * The cutoff a built-in preset resolves to, mirrored from
 * packages/core/src/retention/tiers.ts so the form can show it before the
 * policy is ever saved or previewed. "custom" has none of its own.
 */
export function builtinCutoffDays(preset: Exclude<RetentionPreset, "custom">): number | null {
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
  }
}

/** How long a policy keeps restore points, as one sentence. */
export function cutoffLabel(cutoffDays: number | null, t: TFunction, language: string): string {
  return cutoffDays === null
    ? t("cutoff.forever")
    : t("cutoff.days", { days: formatInteger(cutoffDays, language) });
}

/** Which objects a policy governs: the tenant default, or the named overrides. */
export function scopeLabel(
  isDefault: boolean,
  objects: readonly RetentionScopeObject[],
  t: TFunction,
): string {
  if (isDefault) {
    return t("scope.tenantWide");
  }
  if (objects.length === 1) {
    return objects[0]?.name ?? t("scope.objects", { count: 1 });
  }
  return t("scope.objects", { count: objects.length });
}

// ---------------------------------------------------------------------------
// The draft: what the create/edit sheet holds while the administrator works
// ---------------------------------------------------------------------------

export type ScopeMode = "tenant" | "objects";

export interface RetentionDraft {
  name: string;
  preset: RetentionPreset;
  /** Editable rows for preset "custom"; ignored (but kept) for a built-in preset. */
  tiers: RetentionTier[];
  scope: ScopeMode;
  objects: RetentionScopeObject[];
}

/** A single open-ended "keep everything" tier: the friendliest starting point for a custom policy. */
export function blankTier(): RetentionTier {
  return { fromDays: 0, toDays: null, keepEveryDays: 0 };
}

/** A sensible split point past the last tier's own start, whether it is open-ended or not. */
const TIER_SPLIT_DAYS = 30;

/**
 * A custom tier list with one more row appended, splitting the current last
 * tier instead of ever producing a zero-length one: when that tier is
 * open-ended (the usual case), the split point is its own start plus
 * {@link TIER_SPLIT_DAYS}, not day 0 — `last.toDays ?? 0` would otherwise
 * close the existing tier at day 0 and start the new one there too, a
 * zero-length tier neither the "to" nor the "from" field (both disabled by
 * contiguity) can then fix.
 */
export function addTier(tiers: readonly RetentionTier[]): RetentionTier[] {
  const last = tiers.at(-1);
  const split = last?.toDays ?? (last?.fromDays ?? 0) + TIER_SPLIT_DAYS;
  return [
    ...tiers.map((tier, i) => (i === tiers.length - 1 ? { ...tier, toDays: split } : tier)),
    { fromDays: split, toDays: null, keepEveryDays: 0 },
  ];
}

/**
 * A custom tier list with the tier at `index` removed, re-linking its
 * neighbours so the list stays contiguous (each tier's `toDays` equals the
 * next tier's `fromDays`) instead of leaving a gap between two fields the
 * editor disables (only the first tier's `from` and the last tier's `to`
 * are ever editable). Falls back to a single blank tier when nothing is left.
 */
export function removeTier(tiers: readonly RetentionTier[], index: number): RetentionTier[] {
  const removed = tiers[index];
  const remaining = tiers.filter((_, i) => i !== index);
  if (remaining.length === 0 || !removed) {
    return remaining.length === 0 ? [blankTier()] : remaining;
  }
  if (index === 0) {
    remaining[0] = { ...(remaining[0] as RetentionTier), fromDays: 0 };
  } else if (index < tiers.length - 1) {
    const boundary = tiers[index - 1]?.toDays ?? 0;
    remaining[index] = { ...(remaining[index] as RetentionTier), fromDays: boundary };
  } else {
    const last = remaining.at(-1);
    if (last) {
      remaining[remaining.length - 1] = { ...last, toDays: null };
    }
  }
  return remaining;
}

export function newDraft(recommendedPreset: RetentionPreset): RetentionDraft {
  return {
    name: "",
    preset: recommendedPreset,
    tiers: [blankTier()],
    scope: "tenant",
    objects: [],
  };
}

export function draftFromPolicy(policy: RetentionPolicy): RetentionDraft {
  return {
    name: policy.name,
    preset: policy.preset,
    tiers: policy.preset === "custom" ? policy.tiers : [blankTier()],
    scope: policy.isDefault ? "tenant" : "objects",
    objects: policy.protectedObjects,
  };
}

export type DraftField = "name" | "objects" | "tiers";

export type DraftCheck =
  | { ok: true }
  | { ok: false; field: DraftField; reason: "required" | "gap" };

/** Whether the draft is complete enough to save or preview; the API judges the tiers themselves. */
export function checkDraft(draft: RetentionDraft): DraftCheck {
  if (draft.name.trim().length === 0) {
    return { ok: false, field: "name", reason: "required" };
  }
  if (draft.scope === "objects" && draft.objects.length === 0) {
    return { ok: false, field: "objects", reason: "required" };
  }
  if (draft.preset === "custom") {
    if (draft.tiers.length === 0) {
      return { ok: false, field: "tiers", reason: "required" };
    }
    const sorted = [...draft.tiers].sort((a, b) => a.fromDays - b.fromDays);
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i]?.toDays !== sorted[i + 1]?.fromDays) {
        return { ok: false, field: "tiers", reason: "gap" };
      }
    }
  }
  return { ok: true };
}

function scopeIds(draft: RetentionDraft): string[] | null {
  return draft.scope === "tenant" ? null : draft.objects.map((object) => object.id);
}

export function inputFromDraft(draft: RetentionDraft): RetentionPolicyInput {
  return {
    name: draft.name.trim(),
    preset: draft.preset,
    tiers: draft.preset === "custom" ? draft.tiers : undefined,
    protectedObjectIds: scopeIds(draft),
  };
}

/**
 * The rule fields of a draft — everything a preview (or the worker) actually
 * cares about, deliberately without `name`. The preview's request also
 * doubles as its query key (see useRetentionPreview): keeping name out of it
 * means a rename alone never invalidates the settled preview, so it stays
 * ready to submit instead of forcing another debounce wait for a number that
 * would not have changed anyway.
 */
export function previewInputFromDraft(draft: RetentionDraft): Omit<RetentionPolicyInput, "name"> {
  return {
    preset: draft.preset,
    tiers: draft.preset === "custom" ? draft.tiers : undefined,
    protectedObjectIds: scopeIds(draft),
  };
}

/** Only the fields a save changed, compared against the saved policy. */
export function patchFromDraft(
  before: RetentionPolicy,
  draft: RetentionDraft,
): Partial<RetentionPolicyInput> {
  const input = inputFromDraft(draft);
  const patch: Partial<RetentionPolicyInput> = {};
  if (input.name !== before.name) {
    patch.name = input.name;
  }
  if (input.preset !== before.preset) {
    patch.preset = input.preset;
  }
  if (input.preset === "custom" && JSON.stringify(input.tiers) !== JSON.stringify(before.tiers)) {
    patch.tiers = input.tiers;
  }
  const beforeIds = before.protectedObjects.map((object) => object.id).sort();
  const afterIds = [...(input.protectedObjectIds ?? [])].sort();
  if (JSON.stringify(beforeIds) !== JSON.stringify(afterIds)) {
    patch.protectedObjectIds = input.protectedObjectIds;
  }
  return patch;
}

// ---------------------------------------------------------------------------
// API problems
// ---------------------------------------------------------------------------

const PROBLEM_CODES = new Set([
  "object_not_found",
  "object_already_scoped",
  "default_exists",
  "empty",
  "start",
  "from_days",
  "keep_every_days",
  "to_days",
  "open_ended",
  "gap",
  "required",
]);

export interface FieldProblem {
  /** The request field the API named (`name`, `tiers`, `protectedObjectIds`). */
  field: string;
  /** Translation key (retention namespace) of the reason. */
  key: string;
}

/** The field and translated reason of a policy the API refused, or null for other errors. */
export function fieldProblem(error: unknown): FieldProblem | null {
  if (!(error instanceof ApiError) || error.status !== 422 || !error.problem) {
    return null;
  }
  const field = typeof error.problem.field === "string" ? error.problem.field : null;
  const code = typeof error.problem.code === "string" ? error.problem.code : null;
  if (!field) {
    return null;
  }
  return { field, key: code && PROBLEM_CODES.has(code) ? `problems.${code}` : "problems.generic" };
}

/**
 * Whether saving this draft deserves a confirmation first: the settled
 * preview (the same @restow/core run the worker does) says the next run
 * would actually remove at least one restore point. This covers every case
 * that matters, not just an edit that shortens an existing policy's cutoff:
 * creating the tenant's first policy (which turns "keep everything" into
 * pruning), narrowing an object override, or switching between two presets
 * with the same cutoff but different thinning (e.g. "1y" to "default").
 * `undefined`/`null` (no settled preview yet) never confirms on its own —
 * the caller only asks once it has one.
 */
export function isStricterChange(previewRestorePoints: number | null | undefined): boolean {
  return typeof previewRestorePoints === "number" && previewRestorePoints > 0;
}
