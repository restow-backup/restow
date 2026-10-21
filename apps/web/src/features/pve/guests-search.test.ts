import { describe, expect, it } from "vitest";

import type { PveGuest } from "./api";
import { filterGuests, guestRows, NO_JOB, parsePveSearch, sortGuests } from "./guests-search";

/** The address of VMs & containers and what it does to the guests (0.4.3). */

function g(vmid: number, over: Partial<PveGuest> = {}): PveGuest {
  return {
    id: `g-${vmid}`,
    clusterId: "c-1",
    vmid,
    kind: "ct",
    name: `guest-${vmid}`,
    node: "pmx01",
    status: "running",
    template: false,
    privileged: false,
    present: true,
    diskBytes: 0,
    jobId: "j-1",
    jobName: "Nightly",
    lastBackupAt: "2026-10-20T01:00:00Z",
    lastSuccessAt: "2026-10-20T01:00:00Z",
    lastRunStatus: "succeeded",
    lastRunError: null,
    bitmapState: null,
    attention: [],
    ...over,
  } as PveGuest;
}

describe("the page's search", () => {
  it("keeps what it knows and drops defaults and junk", () => {
    expect(
      parsePveSearch({
        tab: "guests",
        q: "  web ",
        kind: "vm",
        state: "problems",
        sort: "name",
        desc: "true",
        page: "1",
        size: 50,
        guest: "g-1",
        other: "x",
      }),
    ).toEqual({ q: "web", kind: "vm", state: "problems", sort: "name", desc: true, guest: "g-1" });
    expect(parsePveSearch({ tab: "nodes", page: 3, size: 100, kind: "lxc", state: "bad" })).toEqual(
      {
        tab: "nodes",
        page: 3,
        size: 100,
      },
    );
  });
});

describe("filtering and sorting guests", () => {
  const guests = [
    g(101, { name: "web01", node: "pmx01" }),
    g(205, { name: "db", node: "pmx02", kind: "vm", lastRunStatus: "failed" }),
    g(300, { name: "mail", jobId: null, jobName: null, attention: ["no_job"] }),
    g(102, { name: "Web02", lastBackupAt: null, lastSuccessAt: null, lastRunStatus: null }),
  ];
  const rows = guestRows(guests, () => null);
  const ids = (list: { guest: PveGuest }[]) => list.map((row) => row.guest.vmid);

  it("searches the ID as a prefix and the name anywhere, ignoring case", () => {
    expect(ids(filterGuests(rows, { q: "web" }))).toEqual([101, 102]);
    expect(ids(filterGuests(rows, { q: "20" }))).toEqual([205]);
  });

  it("filters by node, kind, job (also none) and state", () => {
    expect(ids(filterGuests(rows, { node: "pmx02" }))).toEqual([205]);
    expect(ids(filterGuests(rows, { kind: "vm" }))).toEqual([205]);
    expect(ids(filterGuests(rows, { job: NO_JOB }))).toEqual([300]);
    expect(ids(filterGuests(rows, { state: "problems" }))).toEqual([205, 300, 102]);
    expect(ids(filterGuests(rows, { state: "no_backup" }))).toEqual([300, 102]);
  });

  it("sorts by ID by default and by any sortable column, ties by ID", () => {
    expect(ids(sortGuests(rows, {}))).toEqual([101, 102, 205, 300]);
    expect(ids(sortGuests(rows, { sort: "name" }))).toEqual([205, 300, 101, 102]);
    expect(ids(sortGuests(rows, { sort: "state" }))[0]).toBe(205);
    expect(ids(sortGuests(rows, { sort: "lastBackup", desc: true })).at(-1)).toBe(102);
  });

  it("handles thousands of guests quickly", () => {
    const many = guestRows(
      Array.from({ length: 5000 }, (_, index) => g(1000 + index, { name: `vm-${index}` })),
      () => null,
    );
    const started = performance.now();
    sortGuests(filterGuests(many, { q: "vm-4", state: "ok" }), { sort: "name" });
    expect(performance.now() - started).toBeLessThan(500);
  });
});
