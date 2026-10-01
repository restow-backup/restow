import { describe, expect, it } from "vitest";
import { InMemoryDeltaTokenStore, collectDelta, isRemoved } from "../delta.js";
import { createFakeGraph, must } from "../testing/fake-graph.js";
import fixture from "../testing/fixtures/users-delta.json" with { type: "json" };
import { collect } from "./common.js";
import {
  USER_SELECT,
  type UserDeltaEntry,
  getOrganization,
  hasExchangePlan,
  initialDomainOf,
  isLicensed,
  listGroupMemberIds,
  listUsers,
  looksLikeSharedMailbox,
  usersDelta,
  usersDeltaUrl,
} from "./users.js";

describe("users", () => {
  it("lists users with the documented $select, without filtering on accountEnabled", async () => {
    const graph = createFakeGraph([
      {
        url: (u) => u.pathname === "/v1.0/users" && !u.search.includes("skiptoken"),
        respond: {
          status: 200,
          json: {
            value: fixture.initialPage1.value,
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?$skiptoken=P2",
          },
        },
      },
      {
        url: /\$skiptoken=P2/,
        respond: { status: 200, json: { value: fixture.initialPage2.value } },
      },
    ]);
    const users = await collect(listUsers(graph.client()));
    expect(users.map((u) => u.id)).toEqual(["user-1", "user-shared", "user-guest"]);

    const first = new URL(must(graph.calls[0]).url);
    expect(first.searchParams.get("$select")).toBe(USER_SELECT.join(","));
    expect(first.searchParams.get("$top")).toBe("999");
    expect(first.searchParams.get("$filter")).toBeNull();
    expect(USER_SELECT).toContain("accountEnabled");
  });

  it("runs users/delta through the token store and surfaces removals", async () => {
    const graph = createFakeGraph([
      {
        url: (u) => u.pathname === "/v1.0/users/delta" && !u.search.includes("token"),
        respond: { status: 200, json: fixture.initialPage1 },
      },
      { url: /\$skiptoken=USERS1/, respond: { status: 200, json: fixture.initialPage2 } },
      { url: /\$deltatoken=USERSDELTA1/, respond: { status: 200, json: fixture.incrementalPage } },
    ]);
    const store = new InMemoryDeltaTokenStore();
    const client = graph.client();

    const first = await collectDelta<UserDeltaEntry>({
      client,
      store,
      key: "directory:users",
      initialUrl: usersDeltaUrl(),
    });
    expect(first.summary.mode).toBe("initial");
    expect(first.items).toHaveLength(3);

    const second: UserDeltaEntry[] = [];
    const generator = usersDelta(client, store);
    let next = await generator.next();
    while (!next.done) {
      second.push(...next.value.items);
      next = await generator.next();
    }
    expect(next.value.mode).toBe("incremental");
    expect(second.map((u) => [u.id, isRemoved(u)])).toEqual([
      ["user-guest", true],
      ["user-1", false],
    ]);
  });

  it("classifies shared mailboxes and licences by heuristics", () => {
    const [alice, shared] = fixture.initialPage1.value;
    const guest = must(fixture.initialPage2.value[0]);
    expect(looksLikeSharedMailbox(must(alice))).toBe(false);
    expect(looksLikeSharedMailbox(must(shared))).toBe(true);
    expect(looksLikeSharedMailbox(guest)).toBe(false);
    expect(isLicensed(must(alice))).toBe(true);
    expect(isLicensed(must(shared))).toBe(false);
    expect(hasExchangePlan(must(alice))).toBe(true);
    expect(hasExchangePlan(must(shared))).toBe(false);
  });

  it("collects transitive group member ids through the user cast", async () => {
    const graph = createFakeGraph([
      {
        url: /groups\/g1\/transitiveMembers\/microsoft\.graph\.user/,
        respond: { status: 200, json: fixture.groupMembers },
      },
    ]);
    const ids = await listGroupMemberIds(graph.client(), "g1");
    expect([...ids]).toEqual(["user-1", "user-shared"]);
    expect(new URL(must(graph.calls[0]).url).searchParams.get("$select")).toBe("id");
  });

  it("reads the organisation and its initial domain", async () => {
    const graph = createFakeGraph([
      { url: "/v1.0/organization", respond: { status: 200, json: fixture.organization } },
    ]);
    const organization = await getOrganization(graph.client());
    expect(organization.displayName).toBe("Contoso GmbH");
    expect(initialDomainOf(organization)).toBe("contoso.onmicrosoft.com");
  });
});
