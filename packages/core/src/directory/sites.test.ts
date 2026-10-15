import { describe, expect, it } from "vitest";
import { FakeSharePoint } from "../backup/sharepoint/testing.js";
import { DEFAULT_PROTECTION_RULES } from "./rules.js";
import { type KnownSite, planSites } from "./sites.js";
import { MemoryDirectoryRepository, syncDirectory } from "./sync.js";

const usersDeltaRoute = {
  url: (url: URL) => url.pathname === "/v1.0/users/delta",
  respond: {
    status: 200,
    json: {
      value: [],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/delta?$deltatoken=U1",
    },
  },
};

function known(
  externalId: string,
  status: KnownSite["status"],
  displayName = externalId,
): KnownSite {
  return { externalId, status, origin: "directory_sync", displayName };
}

describe("planSites", () => {
  const all = { sites: "all" as const };
  const selected = { sites: "selected" as const };

  it("protects every listed site in mode all and only included ones in mode selected", () => {
    const sites = [
      { id: "s1", displayName: "Sales", webUrl: null },
      { id: "s2", displayName: "HR", webUrl: null },
    ];
    expect(planSites({ sites, known: [], rules: all, overrides: {} }).sites).toEqual([
      expect.objectContaining({ externalId: "s1", status: "active", change: "created" }),
      expect.objectContaining({ externalId: "s2", status: "active", change: "created" }),
    ]);
    const plan = planSites({ sites, known: [], rules: selected, overrides: { s2: "include" } });
    expect(plan.sites.map((site) => [site.externalId, site.status, site.reason])).toEqual([
      ["s1", "excluded", "not_selected"],
      ["s2", "active", "override_include"],
    ]);
  });

  it("writes nothing for unchanged sites, renames and rescopes the others, orphans missing ones", () => {
    const plan = planSites({
      sites: [
        { id: "s1", displayName: "Sales", webUrl: null },
        { id: "s2", displayName: "People", webUrl: null },
        { id: "s3", displayName: "Legal", webUrl: null },
      ],
      known: [
        known("s1", "active", "Sales"),
        known("s2", "active", "HR"),
        known("s3", "active", "Legal"),
        known("s4", "active"),
        known("s5", "orphaned"),
      ],
      rules: all,
      overrides: { s3: "exclude" },
    });
    expect(plan.sites.map((site) => [site.externalId, site.change, site.status])).toEqual([
      ["s2", "updated", "active"],
      ["s3", "rescoped", "excluded"],
    ]);
    expect(plan.orphanExternalIds).toEqual(["s4"]);
    expect(plan.discovered).toBe(3);
  });

  it("keeps known sites when the listing failed and only re-applies the rules", () => {
    const plan = planSites({
      sites: null,
      known: [known("s1", "active"), known("s2", "orphaned")],
      rules: selected,
      overrides: {},
    });
    expect(plan.orphanExternalIds).toEqual([]);
    expect(plan.sites).toEqual([
      expect.objectContaining({ externalId: "s1", status: "excluded", change: "rescoped" }),
    ]);
    expect(plan.discovered).toBeNull();
  });
});

describe("syncDirectory with sites", () => {
  it("discovers sites, leaves personal sites to the OneDrives and queues new ones", async () => {
    const sp = new FakeSharePoint([usersDeltaRoute]);
    sp.addSite({ id: "host,1,1", displayName: "Sales" });
    sp.addSite({ id: "host,2,2", displayName: "Project X (Team)" });
    sp.addSite({
      id: "host-my,3,3",
      displayName: "Alice",
      webUrl: "https://contoso-my.sharepoint.com/personal/alice_contoso_com",
    });
    const repository = new MemoryDirectoryRepository({
      rules: DEFAULT_PROTECTION_RULES,
      overrides: {},
    });
    const result = await syncDirectory({ client: sp.graph.client(), repository, sites: true });
    expect([...repository.sites.values()].map((site) => [site.externalId, site.status])).toEqual([
      ["host,1,1", "active"],
      ["host,2,2", "active"],
    ]);
    expect(result.sitesDiscovered).toBe(2);
    expect(result.newlyActive).toEqual([
      { externalId: "host,1,1", kind: "site" },
      { externalId: "host,2,2", kind: "site" },
    ]);
    expect(result.warnings).toEqual([]);

    // A second run with nothing new queues nothing.
    const again = await syncDirectory({ client: sp.graph.client(), repository, sites: true });
    expect(again.newlyActive).toEqual([]);
  });

  it("reports a missing Sites.Read.All consent as a warning and keeps the users' sync", async () => {
    const sp = new FakeSharePoint([usersDeltaRoute]);
    sp.refuseSiteListing = 403;
    const repository = new MemoryDirectoryRepository({
      rules: DEFAULT_PROTECTION_RULES,
      overrides: {},
    });
    repository.sites.set("host,1,1", known("host,1,1", "active"));
    const result = await syncDirectory({ client: sp.graph.client(), repository, sites: true });
    expect(result.warnings).toEqual([
      expect.objectContaining({ kind: "sites_unavailable", status: 403, code: "accessDenied" }),
    ]);
    expect(repository.sites.get("host,1,1")?.status).toBe("active");
    expect(repository.deltaLink).toContain("U1");
  });

  it("does not list sites unless asked", async () => {
    const sp = new FakeSharePoint([usersDeltaRoute]);
    const repository = new MemoryDirectoryRepository({
      rules: DEFAULT_PROTECTION_RULES,
      overrides: {},
    });
    await syncDirectory({ client: sp.graph.client(), repository });
    expect(sp.graph.callsTo("GET", "getAllSites")).toEqual([]);
  });
});
