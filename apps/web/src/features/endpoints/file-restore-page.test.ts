import { describe, expect, it } from "vitest";

import type { EndpointSummary } from "./api.js";
import { machineMatches, onlyMachine } from "./file-restore-page.js";
import { fileRestoreTo, parseFileRestoreSearch } from "./paths.js";

const machine = (displayName: string | null, hostname: string) =>
  ({ displayName, hostname }) as EndpointSummary;

describe("machineMatches", () => {
  it("matches the label and the host name, ignoring case and surrounding spaces", () => {
    expect(machineMatches(machine("Main file server", "fs-01"), "FILE")).toBe(true);
    expect(machineMatches(machine("Main file server", "fs-01"), " fs-0 ")).toBe(true);
    expect(machineMatches(machine(null, "web-01"), "web")).toBe(true);
  });

  it("keeps every machine for an empty search and none for a miss", () => {
    expect(machineMatches(machine(null, "web-01"), "  ")).toBe(true);
    expect(machineMatches(machine("Main file server", "fs-01"), "mail")).toBe(false);
  });
});

describe("onlyMachine", () => {
  it("chooses the one machine, and nothing for more or none", () => {
    expect(onlyMachine([{ id: "m1" }])).toBe("m1");
    expect(onlyMachine([{ id: "m1" }, { id: "m2" }])).toBeNull();
    expect(onlyMachine([])).toBeNull();
  });
});

describe("file restore search", () => {
  it("reads the machine, or an earlier version's mailbox link (sent on to the explorer)", () => {
    expect(parseFileRestoreSearch({ machine: "m1" })).toEqual({ machine: "m1" });
    expect(parseFileRestoreSearch({ mailbox: "o1" })).toEqual({ mailbox: "o1" });
    expect(parseFileRestoreSearch({ machine: "m1", mailbox: "o1" })).toEqual({ machine: "m1" });
    expect(parseFileRestoreSearch({ machine: "", mailbox: 3 })).toEqual({});
    expect(parseFileRestoreSearch({ mailbox: "x".repeat(65) })).toEqual({});
  });

  it("links to file restore with a machine chosen", () => {
    expect(fileRestoreTo("m1")).toEqual({ to: "/file-restore", search: { machine: "m1" } });
  });
});
