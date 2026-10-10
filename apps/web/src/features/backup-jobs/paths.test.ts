import { describe, expect, it } from "vitest";

import {
  JOBS_PATH,
  MAX_SELECTED_IDS,
  jobDefinitionPath,
  jobDefinitionTo,
  jobsListTo,
  newJobTo,
  parseJobDetailSearch,
  parseJobTab,
  parseJobsSearch,
  parseSelectedIds,
} from "./paths.js";

describe("the list address", () => {
  it("reads the kind, the editor and the preselection", () => {
    const noCopy = { source: null, target: null, folder: null };
    expect(parseJobsSearch({ type: "mail" })).toEqual({
      type: "mail",
      create: false,
      select: [],
      copy: noCopy,
    });
    expect(parseJobsSearch({ type: "endpoint", new: 1, select: "a,b" })).toEqual({
      type: "endpoint",
      create: true,
      select: ["a", "b"],
      copy: noCopy,
    });
  });

  it("reads the kinds of file shares and what a new copy job starts with", () => {
    const source = "11111111-1111-4111-8111-111111111111";
    const target = "22222222-2222-4222-8222-222222222222";
    expect(parseJobsSearch({ type: "share" }).type).toBe("share");
    expect(
      parseJobsSearch({ type: "copy", new: 1, source, target, folder: "Projects/2026" }),
    ).toMatchObject({
      type: "copy",
      create: true,
      copy: { source, target, folder: "Projects/2026" },
    });
    expect(parseJobsSearch({ type: "copy", source: "not an id" }).copy.source).toBeNull();
  });

  it("takes the editor flag the way the router parses it: a number, a string or a boolean", () => {
    for (const value of [1, "1", true, "true"]) {
      expect(parseJobsSearch({ type: "mail", new: value }).create).toBe(true);
    }
    for (const value of [0, "0", false, undefined, "yes"]) {
      expect(parseJobsSearch({ type: "mail", new: value }).create).toBe(false);
    }
  });

  it("knows no kind for an unknown one, which is the old address of the run list", () => {
    expect(parseJobsSearch({}).type).toBeNull();
    expect(parseJobsSearch({ type: "other" }).type).toBeNull();
  });

  it("keeps plausible ids only, once each, at most as many as an address may carry", () => {
    expect(parseSelectedIds("a, b ,a,,c d,e\u0000f,ok-1_2")).toEqual(["a", "b", "ok-1_2"]);
    expect(parseSelectedIds(["x,y", "z"])).toEqual(["x", "y", "z"]);
    expect(parseSelectedIds(12345)).toEqual(["12345"]);
    expect(parseSelectedIds(undefined)).toEqual([]);
    const many = Array.from({ length: MAX_SELECTED_IDS + 50 }, (_, index) => `id${index}`).join(
      ",",
    );
    expect(parseSelectedIds(many)).toHaveLength(MAX_SELECTED_IDS);
  });

  it("builds the address of a new job with a selection, for the context menus", () => {
    expect(newJobTo("endpoint", ["m1", "m2"])).toEqual({
      to: JOBS_PATH,
      search: { type: "endpoint", new: 1, select: "m1,m2" },
    });
    expect(newJobTo("mail").search).toEqual({ type: "mail", new: 1 });
    expect(jobsListTo("mail")).toEqual({ to: JOBS_PATH, search: { type: "mail" } });
  });
});

describe("the address of one job", () => {
  it("carries the kind and keeps the overview out of the address", () => {
    expect(jobDefinitionPath("a/b")).toBe("/jobs/definitions/a%2Fb");
    expect(jobDefinitionTo("j1", "mail")).toEqual({
      to: "/jobs/definitions/j1",
      search: { type: "mail" },
    });
    expect(jobDefinitionTo("j1", "endpoint", "scope").search).toEqual({
      type: "endpoint",
      tab: "scope",
    });
  });

  it("reads the tab, the overview for anything else", () => {
    expect(parseJobTab("runs")).toBe("runs");
    expect(parseJobTab("settings")).toBe("settings");
    expect(parseJobTab("nope")).toBe("overview");
    expect(parseJobDetailSearch({ type: "mail", tab: "scope" })).toEqual({
      type: "mail",
      tab: "scope",
    });
    expect(parseJobDetailSearch({})).toEqual({ type: null, tab: "overview" });
  });
});
