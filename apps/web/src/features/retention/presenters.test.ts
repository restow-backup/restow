import { ApiError } from "@/lib/api";
import { describe, expect, it } from "vitest";
import type { RetentionPolicy } from "./api.js";
import {
  addTier,
  blankTier,
  builtinCutoffDays,
  checkDraft,
  draftFromPolicy,
  fieldProblem,
  inputFromDraft,
  isStricterChange,
  newDraft,
  patchFromDraft,
  previewInputFromDraft,
  removeTier,
  scopeLabel,
} from "./presenters.js";

const POLICY: RetentionPolicy = {
  id: "p1",
  name: "Standard",
  preset: "default",
  tiers: [
    { fromDays: 0, toDays: 30, keepEveryDays: 0 },
    { fromDays: 30, toDays: 90, keepEveryDays: 1 },
    { fromDays: 90, toDays: 365, keepEveryDays: 7 },
  ],
  cutoffDays: 365,
  isDefault: true,
  protectedObjects: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key) as never;

describe("builtinCutoffDays", () => {
  it("mirrors packages/core/src/retention/tiers.ts", () => {
    expect(builtinCutoffDays("default")).toBe(365);
    expect(builtinCutoffDays("30d")).toBe(30);
    expect(builtinCutoffDays("90d")).toBe(90);
    expect(builtinCutoffDays("1y")).toBe(365);
    expect(builtinCutoffDays("3y")).toBe(1095);
    expect(builtinCutoffDays("7y")).toBe(2555);
    expect(builtinCutoffDays("keep_all")).toBeNull();
  });
});

describe("scopeLabel", () => {
  it("names the tenant default, a single object, or a count", () => {
    expect(scopeLabel(true, [], t)).toBe("scope.tenantWide");
    expect(scopeLabel(false, [{ id: "a", name: "Anna", kind: "mailbox" }], t)).toBe("Anna");
    expect(
      scopeLabel(
        false,
        [
          { id: "a", name: "Anna", kind: "mailbox" },
          { id: "b", name: "Bo", kind: "mailbox" },
        ],
        t,
      ),
    ).toBe('scope.objects:{"count":2}');
  });
});

describe("draft building and checking", () => {
  it("starts a new draft on the recommended preset, unscoped, with a blank custom tier", () => {
    expect(newDraft("default")).toEqual({
      name: "",
      preset: "default",
      tiers: [blankTier()],
      scope: "tenant",
      objects: [],
    });
  });

  it("rebuilds a draft from a saved policy", () => {
    const scoped: RetentionPolicy = {
      ...POLICY,
      preset: "custom",
      isDefault: false,
      protectedObjects: [{ id: "a", name: "Anna", kind: "mailbox" }],
      tiers: [{ fromDays: 0, toDays: null, keepEveryDays: 3 }],
    };
    expect(draftFromPolicy(scoped)).toEqual({
      name: "Standard",
      preset: "custom",
      tiers: [{ fromDays: 0, toDays: null, keepEveryDays: 3 }],
      scope: "objects",
      objects: [{ id: "a", name: "Anna", kind: "mailbox" }],
    });
  });

  it("requires a name", () => {
    const draft = newDraft("30d");
    expect(checkDraft(draft)).toEqual({ ok: false, field: "name", reason: "required" });
  });

  it("requires at least one object when scoped", () => {
    const draft = { ...newDraft("30d"), name: "x", scope: "objects" as const };
    expect(checkDraft(draft)).toEqual({ ok: false, field: "objects", reason: "required" });
  });

  it("requires a contiguous custom tier list", () => {
    const draft = {
      ...newDraft("custom"),
      name: "x",
      tiers: [
        { fromDays: 0, toDays: 10, keepEveryDays: 0 },
        { fromDays: 20, toDays: null, keepEveryDays: 1 },
      ],
    };
    expect(checkDraft(draft)).toEqual({ ok: false, field: "tiers", reason: "gap" });
  });

  it("accepts a complete draft", () => {
    const draft = { ...newDraft("keep_all"), name: "Standard" };
    expect(checkDraft(draft)).toEqual({ ok: true });
  });
});

describe("inputFromDraft / patchFromDraft", () => {
  it("carries tiers only for a custom preset, and null protectedObjectIds for the tenant scope", () => {
    expect(inputFromDraft({ ...newDraft("default"), name: "Standard" })).toEqual({
      name: "Standard",
      preset: "default",
      tiers: undefined,
      protectedObjectIds: null,
    });
    const custom = {
      ...newDraft("custom"),
      name: "x",
      scope: "objects" as const,
      objects: [{ id: "a", name: "Anna", kind: "mailbox" as const }],
    };
    expect(inputFromDraft(custom)).toEqual({
      name: "x",
      preset: "custom",
      tiers: [blankTier()],
      protectedObjectIds: ["a"],
    });
  });

  it("reports only the fields that actually changed", () => {
    const draft = draftFromPolicy(POLICY);
    expect(patchFromDraft(POLICY, draft)).toEqual({});
    expect(patchFromDraft(POLICY, { ...draft, name: "Renamed" })).toEqual({ name: "Renamed" });
    expect(patchFromDraft(POLICY, { ...draft, preset: "30d" })).toEqual({ preset: "30d" });
  });
});

describe("addTier / removeTier", () => {
  it("splits the starting open-ended tier at a real offset, never a zero-length tier at day 0", () => {
    const result = addTier([blankTier()]);
    expect(result).toEqual([
      { fromDays: 0, toDays: 30, keepEveryDays: 0 },
      { fromDays: 30, toDays: null, keepEveryDays: 0 },
    ]);
    expect(checkDraft({ ...newDraft("custom"), name: "x", tiers: result })).toEqual({ ok: true });
  });

  it("splits a closed last tier at its own end, staying contiguous", () => {
    const tiers = [
      { fromDays: 0, toDays: 14, keepEveryDays: 0 },
      { fromDays: 14, toDays: null, keepEveryDays: 7 },
    ];
    expect(addTier(tiers)).toEqual([
      { fromDays: 0, toDays: 14, keepEveryDays: 0 },
      { fromDays: 14, toDays: 44, keepEveryDays: 7 },
      { fromDays: 44, toDays: null, keepEveryDays: 0 },
    ]);
  });

  it("re-links the neighbours of a removed first, middle or last tier", () => {
    const three = [
      { fromDays: 0, toDays: 14, keepEveryDays: 0 },
      { fromDays: 14, toDays: 60, keepEveryDays: 1 },
      { fromDays: 60, toDays: null, keepEveryDays: 7 },
    ];
    // First removed: the new first tier starts at day 0.
    expect(removeTier(three, 0)).toEqual([
      { fromDays: 0, toDays: 60, keepEveryDays: 1 },
      { fromDays: 60, toDays: null, keepEveryDays: 7 },
    ]);
    // Middle removed: the tier after it now starts where the one before it ends.
    expect(removeTier(three, 1)).toEqual([
      { fromDays: 0, toDays: 14, keepEveryDays: 0 },
      { fromDays: 14, toDays: null, keepEveryDays: 7 },
    ]);
    // Last removed: the new last tier becomes open-ended.
    expect(removeTier(three, 2)).toEqual([
      { fromDays: 0, toDays: 14, keepEveryDays: 0 },
      { fromDays: 14, toDays: null, keepEveryDays: 1 },
    ]);
    for (const index of [0, 1, 2]) {
      const result = removeTier(three, index);
      expect(checkDraft({ ...newDraft("custom"), name: "x", tiers: result })).toEqual({ ok: true });
    }
  });

  it("falls back to a single blank tier once nothing is left", () => {
    expect(removeTier([blankTier()], 0)).toEqual([blankTier()]);
  });
});

describe("previewInputFromDraft", () => {
  it("carries the rule fields, deliberately without name", () => {
    const draft = { ...newDraft("default"), name: "Anything" };
    expect(previewInputFromDraft(draft)).toEqual({
      preset: "default",
      tiers: undefined,
      protectedObjectIds: null,
    });
  });

  it("stays identical (same JSON) across a rename, so a rename never resets the settled preview", () => {
    const before = previewInputFromDraft({ ...newDraft("30d"), name: "Standard" });
    const after = previewInputFromDraft({ ...newDraft("30d"), name: "Renamed" });
    expect(JSON.stringify(before)).toBe(JSON.stringify(after));
  });
});

describe("fieldProblem", () => {
  it("reads the field and a known code from a 422 problem", () => {
    const error = new ApiError(
      422,
      { type: "about:blank", title: "x", status: 422, field: "tiers", code: "gap" },
      "x",
    );
    expect(fieldProblem(error)).toEqual({ field: "tiers", key: "problems.gap" });
  });

  it("falls back to a generic key for an unknown code, and null for anything else", () => {
    const error = new ApiError(
      422,
      { type: "about:blank", title: "x", status: 422, field: "name", code: "mystery" },
      "x",
    );
    expect(fieldProblem(error)).toEqual({ field: "name", key: "problems.generic" });
    expect(fieldProblem(new Error("boom"))).toBeNull();
  });
});

describe("isStricterChange", () => {
  it("confirms whenever the settled preview would actually remove a restore point", () => {
    // Creating the tenant's first policy: "keep everything" becomes pruning.
    expect(isStricterChange(3)).toBe(true);
    // Editing an existing policy the same way.
    expect(isStricterChange(1)).toBe(true);
    // Nothing due yet: no confirmation needed, whatever the cutoff looks like.
    expect(isStricterChange(0)).toBe(false);
    // No settled preview yet: never confirms on its own.
    expect(isStricterChange(undefined)).toBe(false);
    expect(isStricterChange(null)).toBe(false);
  });
});
