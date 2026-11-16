import { describe, expect, it } from "vitest";
import { resticUpload } from "./guards.js";

describe("what a restic upload is for the run size guard (#99)", () => {
  it("takes config as the start of a new repository, and only pack data as more than metadata", () => {
    expect(resticUpload({ kind: "config" })).toEqual({ startsRepository: true, metadata: true });
    expect(resticUpload({ kind: "object", type: "data", name: "a" })).toEqual({
      startsRepository: false,
      metadata: false,
    });
    for (const type of ["index", "snapshots", "keys"] as const) {
      expect(resticUpload({ kind: "object", type, name: "a" })).toEqual({
        startsRepository: false,
        metadata: true,
      });
    }
    expect(resticUpload(undefined)).toEqual({ startsRepository: false, metadata: false });
  });
});
