import { describe, expect, it } from "vitest";
import { MAX_CONTINUATION_DAYS, mayContinueForFree } from "./continuation.js";

/** When an interrupted job keeps its attempt (#47). */
describe("mayContinueForFree", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  const started = new Date("2026-10-10T12:00:00Z");

  it("continues an interruption (time limit or shutdown) that saved a checkpoint", () => {
    for (const reason of ["expired", "shutdown", "update"] as const) {
      expect(mayContinueForFree({ reason, checkpointed: true, startedAt: started, now })).toBe(
        true,
      );
    }
  });

  it("continues a shutdown or an update's drain without a checkpoint (#46)", () => {
    for (const reason of ["shutdown", "update"] as const) {
      expect(mayContinueForFree({ reason, checkpointed: false, startedAt: started, now })).toBe(
        true,
      );
      expect(mayContinueForFree({ reason, checkpointed: false, startedAt: null, now })).toBe(false);
    }
  });

  it("counts errors, cancels and attempts without progress as usual", () => {
    expect(mayContinueForFree({ reason: null, checkpointed: true, startedAt: started, now })).toBe(
      false,
    );
    expect(
      mayContinueForFree({ reason: "cancelled", checkpointed: true, startedAt: started, now }),
    ).toBe(false);
    expect(
      mayContinueForFree({ reason: "expired", checkpointed: false, startedAt: started, now }),
    ).toBe(false);
    expect(
      mayContinueForFree({ reason: "expired", checkpointed: true, startedAt: null, now }),
    ).toBe(false);
  });

  it(`stops continuing for free ${MAX_CONTINUATION_DAYS} days after the first start`, () => {
    const day = 24 * 60 * 60 * 1000;
    const edge = new Date(now.getTime() - MAX_CONTINUATION_DAYS * day);
    const past = new Date(edge.getTime() - 1);
    expect(
      mayContinueForFree({ reason: "expired", checkpointed: true, startedAt: edge, now }),
    ).toBe(true);
    expect(
      mayContinueForFree({ reason: "expired", checkpointed: true, startedAt: past, now }),
    ).toBe(false);
    expect(
      mayContinueForFree({ reason: "shutdown", checkpointed: false, startedAt: past, now }),
    ).toBe(false);
  });
});
