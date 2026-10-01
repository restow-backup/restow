import { describe, expect, it } from "vitest";
import { createFakeGraph, graphError } from "../graph/testing/fake-graph.js";
import { getGroup, groupKindOf, searchGroups } from "./groups.js";

const GROUP_ID = "8f3c2a61-6c5e-4d8e-9a3b-0c7d1e2f4a5b";

const groups = [
  {
    id: "g-2",
    displayName: "backup users",
    mail: null,
    mailEnabled: false,
    securityEnabled: true,
    groupTypes: [],
  },
  {
    id: "g-1",
    displayName: "Backup Team",
    mail: "team@x.y",
    mailEnabled: true,
    securityEnabled: false,
    groupTypes: ["Unified"],
  },
];

describe("groupKindOf", () => {
  it("labels groups like the Entra admin center", () => {
    expect(
      groupKindOf({ groupTypes: ["Unified"], mailEnabled: true, securityEnabled: false }),
    ).toBe("microsoft365");
    expect(groupKindOf({ groupTypes: [], mailEnabled: false, securityEnabled: true })).toBe(
      "security",
    );
    expect(groupKindOf({ groupTypes: [], mailEnabled: true, securityEnabled: true })).toBe(
      "mail_security",
    );
    expect(groupKindOf({ groupTypes: [], mailEnabled: true, securityEnabled: false })).toBe(
      "distribution",
    );
  });
});

describe("searchGroups", () => {
  it("searches by display name prefix and sorts by name, ignoring case", async () => {
    const graph = createFakeGraph([
      {
        url: (u) => u.pathname === "/v1.0/groups",
        respond: { status: 200, json: { value: groups } },
      },
    ]);
    const result = await searchGroups(graph.client(), " Back'up ");
    expect(result.map((g) => [g.id, g.kind])).toEqual([
      ["g-1", "microsoft365"],
      ["g-2", "security"],
    ]);
    const url = new URL(graph.calls[0]?.url ?? "");
    expect(url.searchParams.get("$filter")).toBe("startswith(displayName,'Back''up')");
    expect(url.searchParams.get("$top")).toBe("25");
  });

  it("lists the first groups for an empty search", async () => {
    const graph = createFakeGraph([
      { url: (u) => u.pathname === "/v1.0/groups", respond: { status: 200, json: { value: [] } } },
    ]);
    await searchGroups(graph.client(), "");
    expect(new URL(graph.calls[0]?.url ?? "").searchParams.has("$filter")).toBe(false);
  });

  it("resolves an object id directly and answers empty when it does not exist", async () => {
    const graph = createFakeGraph([
      {
        url: (u) => u.pathname === `/v1.0/groups/${GROUP_ID}`,
        respond: [
          { status: 200, json: { ...groups[0], id: GROUP_ID } },
          { status: 404, json: graphError("Request_ResourceNotFound") },
        ],
      },
    ]);
    expect((await searchGroups(graph.client(), GROUP_ID)).map((g) => g.id)).toEqual([GROUP_ID]);
    expect(await getGroup(graph.client(), GROUP_ID)).toBeNull();
  });
});
