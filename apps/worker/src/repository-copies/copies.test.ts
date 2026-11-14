import { describe, expect, it } from "vitest";
import { persistentIds, planCopy } from "./copies.js";

/**
 * How the copy pass matches the snapshots of a copy to the primary's (docs/STORAGE.md, "Promoting
 * a copy"): by restic's persistent id, so a copy target already holding copies made from the
 * earlier primary is not copied again after another copy target was promoted.
 */
describe("persistentIds", () => {
  const id = (tag: string) => tag.padEnd(64, "0");

  it("maps each snapshot of an ordinary primary to itself", () => {
    expect(persistentIds([{ id: id("a1") }, { id: id("a2"), original: null }])).toEqual(
      new Map([
        [id("a1"), id("a1")],
        [id("a2"), id("a2")],
      ]),
    );
  });

  it("maps the earlier primary's ids to the snapshots of a promoted repository copy", () => {
    const ids = persistentIds([
      { id: id("c1"), original: id("a1") },
      // A backup made after the promotion.
      { id: id("n1"), original: null },
    ]);
    expect(ids.get(id("a1"))).toBe(id("c1"));
    expect(ids.get(id("c1"))).toBe(id("c1"));
    expect(ids.get(id("n1"))).toBe(id("n1"));
  });
});

/**
 * What a hold keeps reaches the copy too: otherwise a promotion of the copy would leave the clean
 * restore points from before an attack only on the retired primary.
 */
describe("planCopy", () => {
  const decision = { keep: new Set(["k1", "k2"]), remove: new Set(["r1"]) };

  it("follows the retention rules while nothing holds the primary's retention", () => {
    const plan = planCopy({ held: false, retentionStopped: false }, decision, false);
    expect([...plan.wanted].sort()).toEqual(["k1", "k2"]);
    expect(plan.forgets).toBe(true);
  });

  it("copies every recorded restore point and forgets nothing while a hold, a stopped retention or a write-once primary keeps them", () => {
    for (const plan of [
      planCopy({ held: true }, decision, false),
      planCopy({ held: false, retentionStopped: true }, decision, false),
      planCopy({ held: false }, decision, true),
    ]) {
      expect([...plan.wanted].sort()).toEqual(["k1", "k2", "r1"]);
      expect(plan.forgets).toBe(false);
    }
  });
});
