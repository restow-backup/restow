import { describe, expect, it } from "vitest";
import { mailJobObjectIds, mailObjectEligible, mailObjectsInNoJob } from "./scope.js";

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

describe("mail objects in no job", () => {
  const all = (id: string, enabled = true) => ({ id, scopeMode: "all" as const, enabled });
  const selected = (id: string, enabled = true) => ({
    id,
    scopeMode: "selected" as const,
    enabled,
  });

  it("an enabled all job covers every eligible object, so none is in no job", () => {
    expect([...mailObjectsInNoJob([all("j1")], [], objects)]).toEqual([]);
  });

  it("a selected job covers only its members: the others are in no job", () => {
    const members = [{ jobId: "j1", protectedObjectId: "a" }];
    expect([...mailObjectsInNoJob([selected("j1")], members, objects)]).toEqual(["b", "c"]);
  });

  it("an object taken out of a selected job is in no job", () => {
    const members = [
      { jobId: "j1", protectedObjectId: "a" },
      { jobId: "j1", protectedObjectId: "b" },
    ];
    expect(mailObjectsInNoJob([selected("j1")], members, objects).has("c")).toBe(true);
    expect(mailObjectsInNoJob([selected("j1")], members, objects).has("a")).toBe(false);
  });

  it("a disabled job covers nothing", () => {
    const members = [{ jobId: "j1", protectedObjectId: "a" }];
    expect([...mailObjectsInNoJob([selected("j1", false)], members, objects)].sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect([...mailObjectsInNoJob([all("j1", false)], [], objects)].sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("the members of a disabled job stay out of an enabled all job", () => {
    const members = [{ jobId: "j2", protectedObjectId: "b" }];
    expect([...mailObjectsInNoJob([all("j1"), selected("j2", false)], members, objects)]).toEqual([
      "b",
    ]);
  });

  it("an object that may not be backed up (not eligible) is never in no job", () => {
    expect(mailObjectsInNoJob([], [], objects).has("d")).toBe(false);
    expect([...mailObjectsInNoJob([], [], objects)]).toEqual(["a", "b", "c"]);
  });

  it("every object is in no job when the tenant has no job", () => {
    expect(mailObjectsInNoJob([], [], objects).size).toBe(3);
  });

  it("only the objects of a source that works are eligible", () => {
    const active = { status: "active" };
    expect(mailObjectEligible(active, { kind: "m365", status: "active" })).toBe(true);
    expect(mailObjectEligible(active, { kind: "imap", status: "error" })).toBe(true);
    expect(mailObjectEligible(active, { kind: "m365", status: "disabled" })).toBe(false);
    expect(mailObjectEligible(active, { kind: "import", status: "active" })).toBe(false);
    expect(mailObjectEligible({ status: "excluded" }, { kind: "m365", status: "active" })).toBe(
      false,
    );
  });
});
