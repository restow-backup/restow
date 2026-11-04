import { describe, expect, it } from "vitest";
import { FakeGroupDirectory } from "../backup/groups/testing/fake-group.js";
import type { ThrottleInfo } from "../graph/client.js";
import { createFakeGraph } from "../graph/testing/fake-graph.js";
import { FakeMembershipDirectory } from "../graph/testing/fake-memberships.js";
import { MEMBERSHIP_CHUNK, membershipRoles, readGroupMemberships } from "./memberships.js";
import { DEFAULT_PROTECTION_RULES } from "./rules.js";
import { MemoryDirectoryRepository, syncDirectory } from "./sync.js";

const unified = (id: string, displayName: string) => ({
  id,
  displayName,
  mail: `${id}@contoso.example`,
  mailEnabled: true,
  groupTypes: ["Unified"],
  resourceProvisioningOptions: [],
});

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

describe("readGroupMemberships", () => {
  it("reads owners, members and the site of each group through $batch, ids only", async () => {
    const directory = new FakeMembershipDirectory();
    directory.set("g-1", {
      owners: ["u-anna"],
      members: ["u-anna", "u-ben"],
      others: ["device-1"],
      siteId: "contoso.sharepoint.com,1,2",
    });
    directory.set("g-2", { owners: [], members: ["u-ben"], siteId: null });
    const graph = createFakeGraph(directory.routes());

    const chunk = await readGroupMemberships(graph.client(), ["g-1", "g-2"]);
    expect(chunk.failed).toEqual([]);
    expect(chunk.read).toEqual([
      {
        groupId: "g-1",
        owners: ["u-anna"],
        members: ["u-anna", "u-ben"],
        siteId: "contoso.sharepoint.com,1,2",
      },
      { groupId: "g-2", owners: [], members: ["u-ben"], siteId: null },
    ]);
    // One $batch for six reads; each asks for ids only, a page of 999.
    const batches = graph.callsTo("POST", "/$batch");
    expect(batches).toHaveLength(1);
    const payload = (batches[0]?.json ?? { requests: [] }) as { requests: { url: string }[] };
    const urls = payload.requests.map((r) => r.url);
    expect(urls).toHaveLength(6);
    expect(urls[0]).toBe("/groups/g-1/owners?$select=id&$top=999");
    expect(urls[1]).toBe("/groups/g-1/members?$select=id&$top=999");
    expect(urls[2]).toBe("/groups/g-1/sites/root?$select=id");
    // An owner listed as member too is one person, an owner.
    expect([...membershipRoles(chunk.read[0] as never)]).toEqual([
      ["u-anna", "owner"],
      ["u-ben", "member"],
    ]);
  });

  it("follows the next links of large groups page by page", async () => {
    const directory = new FakeMembershipDirectory();
    directory.pageSize = 2;
    const members = Array.from({ length: 5 }, (_, index) => `u-${index}`);
    directory.set("g-big", { owners: ["u-0", "u-1", "u-2"], members, siteId: null });
    const graph = createFakeGraph(directory.routes());

    const chunk = await readGroupMemberships(graph.client(), ["g-big"]);
    expect(chunk.read[0]?.members).toEqual(members);
    expect(chunk.read[0]?.owners).toEqual(["u-0", "u-1", "u-2"]);
    // First pages in the batch, the rest as direct reads on the next links.
    expect(graph.callsTo("GET", "/groups/g-big/members")).toHaveLength(2);
    expect(graph.callsTo("GET", "/groups/g-big/owners")).toHaveLength(1);
  });

  it("waits out throttled sub-responses and reads them again", async () => {
    const directory = new FakeMembershipDirectory();
    directory.set("g-1", { owners: ["u-1"], members: ["u-1"], siteId: null });
    directory.throttle.set("g-1", 3);
    const graph = createFakeGraph(directory.routes());
    const waits: ThrottleInfo[] = [];

    const chunk = await readGroupMemberships(
      graph.client({ onThrottle: (info) => waits.push(info) }),
      ["g-1"],
    );
    expect(chunk.failed).toEqual([]);
    expect(chunk.read).toEqual([
      { groupId: "g-1", owners: ["u-1"], members: ["u-1"], siteId: null },
    ]);
    expect(waits.length).toBeGreaterThan(0);
    expect(waits[0]?.status).toBe(429);
    expect(graph.callsTo("POST", "/$batch").length).toBeGreaterThan(1);
  });

  it("reports a group Graph keeps throttling, and one whose later page fails, as failed", async () => {
    const directory = new FakeMembershipDirectory();
    directory.set("g-hot", { owners: [], members: ["u-1"], siteId: null });
    directory.throttle.set("g-hot", 100);
    directory.pageSize = 1;
    directory.set("g-flaky", { owners: [], members: ["u-1", "u-2"], siteId: null });
    directory.failNextPages.add("g-flaky");
    directory.set("g-ok", { owners: ["u-3"], members: [], siteId: null });
    const graph = createFakeGraph(directory.routes());

    const chunk = await readGroupMemberships(graph.client({ maxRetries: 2 }), [
      "g-hot",
      "g-flaky",
      "g-ok",
    ]);
    expect(chunk.read.map((group) => group.groupId)).toEqual(["g-ok"]);
    expect(chunk.failed.map((failure) => [failure.groupId, failure.status])).toEqual([
      ["g-hot", 429],
      ["g-flaky", 503],
    ]);
  });

  it("skips a group that is gone and fails one Graph refuses; a refused site is unknown", async () => {
    const directory = new FakeMembershipDirectory();
    directory.set("g-1", { owners: ["u-1"], members: [], siteId: "site-1" });
    directory.refuseSites = true;
    const graph = createFakeGraph(directory.routes());
    const chunk = await readGroupMemberships(graph.client(), ["g-1", "g-gone"]);
    expect(chunk.read).toEqual([
      { groupId: "g-1", owners: ["u-1"], members: [], siteId: undefined },
    ]);
    expect(chunk.failed).toEqual([]);

    directory.refuse = true;
    const refused = await readGroupMemberships(graph.client(), ["g-1"]);
    expect(refused.read).toEqual([]);
    expect(refused.failed).toEqual([
      {
        groupId: "g-1",
        status: 403,
        code: "Authorization_RequestDenied",
        message: "Insufficient privileges",
      },
    ]);
  });
});

describe("syncDirectory with memberships", () => {
  function setup(count = 3) {
    const groups = new FakeGroupDirectory();
    const members = new FakeMembershipDirectory();
    for (let index = 1; index <= count; index += 1) {
      groups.set(unified(`g-${index}`, `Group ${index}`));
      members.set(`g-${index}`, {
        owners: [`u-owner-${index}`],
        members: [`u-owner-${index}`, "u-all"],
        siteId: null,
      });
    }
    const graph = createFakeGraph([...emptyUsersRoutes(), ...groups.routes(), ...members.routes()]);
    const repository = new MemoryDirectoryRepository({
      rules: DEFAULT_PROTECTION_RULES,
      overrides: {},
    });
    return { groups, members, graph, repository };
  }

  it("reads every group on the first run, then only the groups the delta reports", async () => {
    const { groups, members, graph, repository } = setup();
    const first = await syncDirectory({
      client: graph.client(),
      repository,
      groups: true,
      memberships: true,
      now: () => new Date("2026-11-01T10:00:00.000Z"),
    });
    expect(first.warnings).toEqual([]);
    expect(first.membershipsRead).toBe(3);
    expect(repository.membershipsSyncedAt).toBe("2026-11-01T10:00:00.000Z");
    expect([...(repository.memberships.get("g-2") ?? [])]).toEqual([
      ["u-owner-2", "owner"],
      ["u-all", "member"],
    ]);

    // Incremental: only the changed group is read again; the others keep their rows.
    members.set("g-2", { owners: ["u-new"], members: [], siteId: null });
    members.set("g-3", { owners: [], members: [], siteId: null });
    groups.changes = [unified("g-2", "Group 2 renamed")];
    const second = await syncDirectory({
      client: graph.client(),
      repository,
      groups: true,
      memberships: true,
      now: () => new Date("2026-11-01T11:00:00.000Z"),
    });
    expect(second.membershipsRead).toBe(1);
    expect(repository.membershipWrites.at(-1)).toEqual(["g-2"]);
    expect([...(repository.memberships.get("g-2") ?? [])]).toEqual([["u-new", "owner"]]);
    expect(repository.memberships.get("g-3")?.size).toBe(2);
    expect(repository.membershipsSyncedAt).toBe("2026-11-01T10:00:00.000Z");

    // A full run reads every group again, and a person who left loses the row.
    const third = await syncDirectory({
      client: graph.client(),
      repository,
      groups: true,
      memberships: true,
      full: true,
      now: () => new Date("2026-11-02T10:00:00.000Z"),
    });
    expect(third.membershipsRead).toBe(3);
    expect(repository.memberships.get("g-3")?.size).toBe(0);
    expect(repository.membershipsSyncedAt).toBe("2026-11-02T10:00:00.000Z");
  });

  it("reads a large tenant in chunks, writing each before the next is read", async () => {
    const { graph, repository } = setup(MEMBERSHIP_CHUNK + 7);
    const result = await syncDirectory({
      client: graph.client(),
      repository,
      groups: true,
      memberships: true,
    });
    expect(result.membershipsRead).toBe(MEMBERSHIP_CHUNK + 7);
    expect(repository.membershipWrites.map((chunk) => chunk.length)).toEqual([MEMBERSHIP_CHUNK, 7]);
  });

  it("keeps the stored rows and warns once when Graph refuses the membership", async () => {
    const { members, graph, repository } = setup();
    await syncDirectory({ client: graph.client(), repository, groups: true, memberships: true });
    members.refuse = true;
    const result = await syncDirectory({
      client: graph.client(),
      repository,
      groups: true,
      memberships: true,
      full: true,
    });
    expect(result.membershipsRead).toBe(0);
    expect(result.warnings).toEqual([
      {
        kind: "memberships_unavailable",
        groups: 3,
        status: 403,
        code: "Authorization_RequestDenied",
        message: "Insufficient privileges",
      },
    ]);
    // The sync itself succeeded; the rows of the last successful read stay.
    expect(repository.memberships.get("g-1")?.size).toBe(2);
  });

  it("leaves the memberships alone unless asked", async () => {
    const { graph, repository } = setup();
    const result = await syncDirectory({ client: graph.client(), repository, groups: true });
    expect(result.membershipsRead).toBeNull();
    expect(graph.calls.some((call) => call.url.includes("$batch"))).toBe(false);
  });
});
