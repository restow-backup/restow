import { describe, expect, it } from "vitest";
import { FakeGroupDirectory } from "../backup/groups/testing/fake-group.js";
import { createFakeGraph } from "../graph/testing/fake-graph.js";
import type { ProtectionConfig } from "./config.js";
import {
  discoverGroupMailboxes,
  type GroupDiscovery,
  type KnownGroupMailbox,
  planGroupMailboxes,
} from "./group-mailboxes.js";
import { DEFAULT_PROTECTION_RULES, normalizeRules } from "./rules.js";
import { MemoryDirectoryRepository, syncDirectory } from "./sync.js";

const unified = (id: string, displayName: string, extra: Record<string, unknown> = {}) => ({
  id,
  displayName,
  mail: `${id}@contoso.example`,
  mailEnabled: true,
  groupTypes: ["Unified"],
  resourceProvisioningOptions: [],
  ...extra,
});

function directory(): FakeGroupDirectory {
  const groups = new FakeGroupDirectory();
  groups.set(unified("g-sales", "Sales"));
  groups.set(unified("g-team", "Project Team", { resourceProvisioningOptions: ["Team"] }));
  groups.set({
    id: "g-security",
    displayName: "VPN users",
    mailEnabled: false,
    securityEnabled: true,
    groupTypes: [],
  });
  groups.set(unified("g-dyn", "All staff", { groupTypes: ["Unified", "DynamicMembership"] }));
  return groups;
}

/** A users/delta that is always empty, so a sync run is about the groups alone. */
function emptyUsersRoutes() {
  return [
    {
      url: (u: URL) => u.pathname === "/v1.0/users/delta",
      respond: {
        status: 200,
        json: {
          value: [],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/delta?$deltatoken=U1",
        },
      },
    },
  ];
}

function protection(rules = DEFAULT_PROTECTION_RULES): ProtectionConfig {
  return { rules, overrides: {} };
}

describe("discoverGroupMailboxes", () => {
  it("pages through every group and keeps only Microsoft 365 groups", async () => {
    const groups = directory();
    const graph = createFakeGraph(groups.routes());
    const result = await discoverGroupMailboxes(graph.client(), null);
    if (!result.ok) {
      throw new Error("discovery failed");
    }
    expect(result.mode).toBe("initial");
    expect(result.pages).toBe(2);
    expect(result.groups.map((g) => [g.id, g.isTeam]).sort()).toEqual([
      ["g-dyn", false],
      ["g-sales", false],
      ["g-team", true],
    ]);
    expect(result.removedIds).toEqual(["g-security"]);
    expect(result.deltaLink).toContain("$deltatoken=");
    // Only the properties the sync needs are asked for, and never the members.
    const first = new URL(graph.calls[0]?.url ?? "");
    expect(first.searchParams.get("$select")).toBe(
      "id,displayName,description,mail,mailEnabled,groupTypes,resourceProvisioningOptions",
    );
  });

  it("reports a refusal instead of failing", async () => {
    const groups = directory();
    groups.refuse = true;
    const result = await discoverGroupMailboxes(createFakeGraph(groups.routes()).client(), null);
    expect(result).toMatchObject({ ok: false, failure: { status: 403 } });
  });
});

describe("planGroupMailboxes", () => {
  const discovery = (
    mode: GroupDiscovery["mode"],
    groups: Array<[string, string]>,
    removedIds: string[] = [],
  ): GroupDiscovery => ({
    mode,
    groups: groups.map(([id, displayName]) => ({ id, displayName, mail: null, isTeam: false })),
    removedIds,
    deltaLink: "link",
    pages: 1,
  });
  const known = (
    externalId: string,
    status: KnownGroupMailbox["status"],
    displayName = externalId,
  ): KnownGroupMailbox => ({ externalId, status, origin: "directory_sync", displayName });

  it("creates new groups as not selected by default, active in `all` mode", () => {
    const selected = planGroupMailboxes({
      discovery: discovery("initial", [["g1", "One"]]),
      known: [],
      rules: { groups: "selected" },
      overrides: {},
    });
    expect(selected.groups).toEqual([
      {
        externalId: "g1",
        displayName: "One",
        status: "excluded",
        reason: "not_selected",
        change: "created",
      },
    ]);
    const all = planGroupMailboxes({
      discovery: discovery("initial", [["g1", "One"]]),
      known: [],
      rules: { groups: "all" },
      overrides: {},
    });
    expect(all.groups[0]?.status).toBe("active");
  });

  it("honours overrides, renames, removals and a full enumeration's absences", () => {
    const plan = planGroupMailboxes({
      discovery: discovery("resync", [
        ["g1", "One renamed"],
        ["g2", "Two"],
      ]),
      known: [known("g1", "active", "One"), known("g2", "excluded", "Two"), known("g3", "active")],
      rules: { groups: "selected" },
      overrides: { g1: "include", g2: "include" },
    });
    expect(plan.groups.map((g) => [g.externalId, g.status, g.change])).toEqual([
      ["g1", "active", "updated"],
      ["g2", "active", "rescoped"],
    ]);
    expect(plan.orphanExternalIds).toEqual(["g3"]);
    expect(plan.discovered).toBe(2);
  });

  it("on an incremental run orphans only removed groups and re-scopes the rest", () => {
    const plan = planGroupMailboxes({
      discovery: discovery("incremental", [], ["g2"]),
      known: [known("g1", "excluded"), known("g2", "active"), known("g3", "orphaned")],
      rules: { groups: "all" },
      overrides: {},
    });
    expect(plan.orphanExternalIds).toEqual(["g2"]);
    expect(plan.groups.map((g) => [g.externalId, g.status, g.change])).toEqual([
      ["g1", "active", "rescoped"],
    ]);
  });

  it("brings an orphaned group back when the delta names it again", () => {
    const plan = planGroupMailboxes({
      discovery: discovery("incremental", [["g1", "g1"]]),
      known: [known("g1", "orphaned")],
      rules: { groups: "all" },
      overrides: {},
    });
    expect(plan.groups.map((g) => [g.externalId, g.status])).toEqual([["g1", "active"]]);
  });

  it("without a listing only re-scopes what is known", () => {
    const plan = planGroupMailboxes({
      discovery: null,
      known: [known("g1", "excluded"), known("g2", "orphaned")],
      rules: { groups: "all" },
      overrides: {},
    });
    expect(plan).toEqual({
      groups: [
        {
          externalId: "g1",
          displayName: "g1",
          status: "active",
          reason: "rule_all",
          change: "rescoped",
        },
      ],
      orphanExternalIds: [],
      discovered: null,
    });
  });
});

describe("syncDirectory with group mailboxes", () => {
  it("discovers the groups, stores their delta link and reads only changes next time", async () => {
    const groups = directory();
    const graph = createFakeGraph([...emptyUsersRoutes(), ...groups.routes()]);
    const repository = new MemoryDirectoryRepository(protection(normalizeRules({ groups: "all" })));

    const first = await syncDirectory({ client: graph.client(), repository, groups: true });
    expect(first.groupsDiscovered).toBe(3);
    expect(first.warnings).toEqual([]);
    expect([...repository.groups.values()].map((g) => [g.externalId, g.status]).sort()).toEqual([
      ["g-dyn", "active"],
      ["g-sales", "active"],
      ["g-team", "active"],
    ]);
    expect(first.newlyActive.filter((o) => o.kind === "group")).toHaveLength(3);
    expect(repository.groupsDeltaLink).toContain("$deltatoken=");

    groups.changes = [
      { id: "g-sales", "@removed": { reason: "changed" } },
      unified("g-new", "New group"),
    ];
    const second = await syncDirectory({ client: graph.client(), repository, groups: true });
    expect(second.groupsDiscovered).toBe(1);
    expect(repository.groups.get("g-sales")?.status).toBe("orphaned");
    expect(repository.groups.get("g-new")?.status).toBe("active");
    expect(second.newlyActive).toEqual([{ externalId: "g-new", kind: "group" }]);
    const deltaCalls = graph.calls.filter((c) => c.url.includes("/groups/delta"));
    expect(new URL(deltaCalls.at(-1)?.url ?? "").searchParams.get("$deltatoken")).not.toBeNull();
  });

  it("keeps the known groups and warns when the groups cannot be read", async () => {
    const groups = directory();
    const graph = createFakeGraph([...emptyUsersRoutes(), ...groups.routes()]);
    const repository = new MemoryDirectoryRepository(protection());
    await syncDirectory({ client: graph.client(), repository, groups: true });
    const link = repository.groupsDeltaLink;
    groups.refuse = true;
    const result = await syncDirectory({ client: graph.client(), repository, groups: true });
    expect(result.warnings.map((w) => w.kind)).toEqual(["groups_unavailable"]);
    expect(result.groupsDiscovered).toBeNull();
    expect(repository.groupsDeltaLink).toBe(link);
    expect(repository.groups.size).toBe(3);
  });

  it("leaves the groups alone unless asked", async () => {
    const groups = directory();
    const graph = createFakeGraph([...emptyUsersRoutes(), ...groups.routes()]);
    const repository = new MemoryDirectoryRepository(protection());
    const result = await syncDirectory({ client: graph.client(), repository });
    expect(result.groupsDiscovered).toBeNull();
    expect(graph.calls.some((c) => c.url.includes("/groups/delta"))).toBe(false);
  });
});
