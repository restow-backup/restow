import { describe, expect, it } from "vitest";

import type { PveGuest } from "@/features/pve/api";

import type { EndpointSummary } from "./api.js";
import {
  containerMatches,
  machineMatches,
  onlyMachine,
  restorableGuests,
} from "./file-restore-page.js";
import { fileRestoreContainerTo, fileRestoreTo, parseFileRestoreSearch } from "./paths.js";

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

describe("Proxmox VE guests in file restore (#62)", () => {
  const guest = (over: Partial<PveGuest>): PveGuest =>
    ({
      id: "g",
      vmid: 300,
      kind: "ct",
      name: null,
      lastSuccessAt: null,
      backups: { first: null, last: null },
      ...over,
    }) as PveGuest;
  const last = { at: "2026-10-14T22:00:00.000Z", contains: 1, added: 1, unreadable: 0 };

  it("offers the containers and the VMs with a restore point", () => {
    const result = restorableGuests({
      clusters: [],
      jobs: [],
      restorePool: "restow-restore",
      guests: [
        guest({ id: "b", name: "zeta", backups: { first: null, last } }),
        guest({ id: "a", name: "alpha", backups: { first: null, last } }),
        guest({ id: "none" }),
        // A server before 0.3.5 names no sizes: its last success stands in.
        guest({ id: "old", name: "mid", backups: undefined, lastSuccessAt: last.at }),
        guest({ id: "vm", kind: "vm", backups: { first: null, last } }),
      ],
    });
    expect(result.containers.map((g) => g.id)).toEqual(["a", "old", "b"]);
    expect(result.vms.map((g) => g.id)).toEqual(["vm"]);
    expect(restorableGuests(undefined)).toEqual({ containers: [], vms: [] });
  });

  it("finds a container by name or VMID", () => {
    const ct = guest({ name: "paperless", vmid: 412 });
    expect(containerMatches(ct, "paper")).toBe(true);
    expect(containerMatches(ct, "412")).toBe(true);
    expect(containerMatches(ct, "ct 412")).toBe(true);
    expect(containerMatches(ct, "db")).toBe(false);
    expect(containerMatches(guest({ kind: "vm", vmid: 100, name: "web" }), "vm 100")).toBe(true);
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

  it("reads and links a Proxmox VE container (#62)", () => {
    expect(parseFileRestoreSearch({ container: "g1" })).toEqual({ container: "g1" });
    expect(parseFileRestoreSearch({ machine: "m1", container: "g1" })).toEqual({ machine: "m1" });
    expect(parseFileRestoreSearch({ container: "", mailbox: "o1" })).toEqual({ mailbox: "o1" });
    expect(fileRestoreContainerTo("g1")).toEqual({
      to: "/file-restore",
      search: { container: "g1" },
    });
  });
});
