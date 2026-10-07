import { describe, expect, it } from "vitest";

import { SNAPSHOTS_GRID } from "./components/snapshots-tab";
import { FILE_RESTORE_GRID } from "./file-restore-page";

/** The fractions of a `grid-cols-[minmax(a,Nfr)_minmax(b,Mfr)]` template, in order. */
function fractions(template: string): number[] {
  return [...template.matchAll(/(\d+(?:\.\d+)?)fr/g)].map((match) => Number(match[1]));
}

/**
 * File restore layout (U-4): the files of a restore point get about half the
 * page width beside the machine list and the timeline, no longer a third
 * squeezed by a fixed 22rem timeline.
 */
describe("file restore layout", () => {
  it("gives the files half the width on the file restore page", () => {
    const [list = 0, rest = 0] = fractions(FILE_RESTORE_GRID);
    const [timeline = 0, files = 0] = fractions(SNAPSHOTS_GRID);
    const restShare = rest / (list + rest);
    const filesShare = restShare * (files / (timeline + files));
    expect(filesShare).toBeCloseTo(0.5);
  });

  it("no longer fixes the timeline at 22rem", () => {
    expect(SNAPSHOTS_GRID).not.toContain("22rem");
    expect(SNAPSHOTS_GRID.startsWith("lg:grid-cols-")).toBe(true);
    expect(FILE_RESTORE_GRID.startsWith("xl:grid-cols-")).toBe(true);
  });
});
