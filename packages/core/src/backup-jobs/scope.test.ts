import { describe, expect, it } from "vitest";
import { mailJobObjectIds } from "./scope.js";

const objects = [
  { id: "a", eligible: true },
  { id: "b", eligible: true },
  { id: "c", eligible: true },
  { id: "d", eligible: false },
];

describe("mail job scope", () => {
  it("a selected job covers its eligible members", () => {
    const members = [
      { jobId: "j1", protectedObjectId: "a" },
      { jobId: "j1", protectedObjectId: "d" },
      { jobId: "j2", protectedObjectId: "b" },
    ];
    expect(mailJobObjectIds({ id: "j1", scopeMode: "selected" }, members, objects)).toEqual(["a"]);
  });

  it("an all job covers every eligible object that no other job holds, new ones included", () => {
    const members = [
      { jobId: "j2", protectedObjectId: "b" },
      { jobId: "j1", protectedObjectId: "c" },
    ];
    expect(mailJobObjectIds({ id: "j1", scopeMode: "all" }, members, objects)).toEqual(["a", "c"]);
    expect(
      mailJobObjectIds({ id: "j1", scopeMode: "all" }, members, [
        ...objects,
        { id: "new", eligible: true },
      ]),
    ).toEqual(["a", "c", "new"]);
  });

  it("covers nothing for a selected job without members", () => {
    expect(mailJobObjectIds({ id: "j1", scopeMode: "selected" }, [], objects)).toEqual([]);
  });
});
