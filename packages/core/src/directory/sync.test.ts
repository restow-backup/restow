import { describe, expect, it } from "vitest";
import { batchEnvelope, createFakeGraph, graphError } from "../graph/testing/fake-graph.js";
import fixture from "../graph/testing/fixtures/users-delta.json" with { type: "json" };
import type { ProtectionConfig } from "./config.js";
import { DEFAULT_PROTECTION_RULES, normalizeRules } from "./rules.js";
import { MemoryDirectoryRepository, latestPerUser, syncDirectory } from "./sync.js";

type SubAnswer = { status: number; body?: unknown };

interface GraphSetup {
  /** Drive id per user; users without an entry answer 404. */
  drives?: Record<string, string>;
  /** Mailbox probe answer per user; default 200 for every user. */
  mailbox?: Record<string, SubAnswer>;
  /** Drive probe answer overriding `drives`. */
  drive?: Record<string, SubAnswer>;
}

const fullUsers = new Map(
  [...fixture.initialPage1.value, ...fixture.initialPage2.value].map((u) => [u.id, u]),
);

function directoryGraph(setup: GraphSetup = {}) {
  const drives = setup.drives ?? { "user-1": "drive-1" };
  return createFakeGraph([
    {
      url: (u) => u.pathname === "/v1.0/users/delta" && !u.search.includes("token"),
      respond: { status: 200, json: fixture.initialPage1 },
    },
    { url: /\$skiptoken=USERS1/, respond: { status: 200, json: fixture.initialPage2 } },
    { url: /\$deltatoken=USERSDELTA1/, respond: { status: 200, json: fixture.incrementalPage } },
    {
      url: /\$deltatoken=USERSDELTA2/,
      respond: {
        status: 200,
        json: {
          value: [],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/users/delta?$deltatoken=USERSDELTA3",
        },
      },
    },
    {
      url: /\/groups\/grp-1\/transitiveMembers\/microsoft\.graph\.user/,
      respond: { status: 200, json: fixture.groupMembers },
    },
    {
      url: /\/groups\/grp-missing\/transitiveMembers/,
      respond: { status: 404, json: graphError("Request_ResourceNotFound", "no such group") },
    },
    {
      method: "POST",
      url: "/v1.0/$batch",
      respond: (call) =>
        batchEnvelope(call, (sub): SubAnswer => {
          const match = sub.url.match(/^\/users\/([^/?]+)(\/[a-zA-Z]+)?/);
          const id = decodeURIComponent(match?.[1] ?? "");
          const resource = match?.[2];
          if (resource === "/mailboxSettings") {
            return setup.mailbox?.[id] ?? { status: 200, body: { timeZone: "UTC" } };
          }
          if (resource === "/drive") {
            const driveId = drives[id];
            return (
              setup.drive?.[id] ??
              (driveId
                ? { status: 200, body: { id: driveId } }
                : { status: 404, body: graphError("itemNotFound") })
            );
          }
          const full = fullUsers.get(id);
          return full
            ? { status: 200, body: { ...full, displayName: "Alice Example-Renamed" } }
            : { status: 404, body: graphError("Request_ResourceNotFound") };
        }),
    },
  ]);
}

function protection(overrides: Partial<ProtectionConfig> = {}): ProtectionConfig {
  return { rules: DEFAULT_PROTECTION_RULES, overrides: {}, ...overrides };
}

const statuses = (repository: MemoryDirectoryRepository) =>
  [...repository.objects.values()].map((o) => [o.kind, o.externalId, o.status]).sort();

describe("syncDirectory", () => {
  it("enumerates the directory, probes mailboxes and drives, and commits the delta link", async () => {
    const graph = directoryGraph();
    const repository = new MemoryDirectoryRepository(protection());
    const now = () => new Date("2026-09-23T08:00:00.000Z");

    const result = await syncDirectory({ client: graph.client(), repository, now });

    expect(result.mode).toBe("initial");
    expect(result.pages).toBe(2);
    expect(result.warnings).toEqual([]);
    expect(result.counts).toMatchObject({ users: 3, guests: 1, created: 3, orphaned: 0 });
    expect(repository.deltaLink).toContain("USERSDELTA1");
    expect(repository.lastFullSyncAt).toBe("2026-09-23T08:00:00.000Z");
    expect([...repository.sharedOrBlockedIds]).toEqual(["user-shared"]);
    expect([...repository.users.keys()].sort()).toEqual(["user-1", "user-guest", "user-shared"]);
    expect(statuses(repository)).toEqual([
      ["mailbox", "user-1", "active"],
      ["mailbox", "user-shared", "active"],
      ["onedrive", "drive-1", "active"],
    ]);

    // Guests are never probed; members are, both probes in one $batch.
    const batches = graph.callsTo("POST", "/$batch");
    expect(batches).toHaveLength(1);
    const probed = (batches[0]?.json as { requests: { id: string }[] }).requests.map((r) => r.id);
    expect(probed.sort()).toEqual([
      "drive:user-1",
      "drive:user-shared",
      "mailbox:user-1",
      "mailbox:user-shared",
    ]);
  });

  it("continues from the delta link, completes partial entries and orphans removed users", async () => {
    const graph = directoryGraph();
    const repository = new MemoryDirectoryRepository(protection());
    const client = graph.client();

    await syncDirectory({ client, repository });
    const second = await syncDirectory({ client, repository });

    expect(second.mode).toBe("incremental");
    expect(second.counts).toMatchObject({ users: 1, removedUsers: 1, updated: 2, orphaned: 0 });
    expect(repository.deltaLink).toContain("USERSDELTA2");
    // The partial entry for user-1 was completed through $batch; its objects follow the rename.
    expect(repository.users.get("user-1")?.displayName).toBe("Alice Example-Renamed");
    expect(repository.objects.get("user-1")?.displayName).toBe("Alice Example-Renamed");
    expect(repository.objects.get("user-shared")?.status).toBe("active");
    // An incremental run is not a full sync.
    expect(repository.commits[1]?.fullSyncAt).toBeNull();
  });

  it("keeps the old delta link when the commit fails, so no change is lost", async () => {
    const graph = directoryGraph();
    const repository = new MemoryDirectoryRepository(protection());
    repository.deltaLink = "https://graph.microsoft.com/v1.0/users/delta?$deltatoken=USERSDELTA1";
    repository.beforeCommit = () => {
      throw new Error("database unavailable");
    };

    await expect(syncDirectory({ client: graph.client(), repository })).rejects.toThrow(
      "database unavailable",
    );
    expect(repository.deltaLink).toContain("USERSDELTA1");
  });

  it("plans again when an admin changes an override during the run", async () => {
    const graph = directoryGraph();
    const repository = new MemoryDirectoryRepository(protection());
    let raced = false;
    repository.beforeCommit = () => {
      if (!raced) {
        raced = true;
        repository.protection = protection({ overrides: { "drive-1": "exclude" } });
      }
    };

    await syncDirectory({ client: graph.client(), repository });

    expect(repository.commits).toHaveLength(1);
    expect(repository.objects.get("drive-1")?.status).toBe("excluded");
  });

  it("re-scopes unchanged users on an incremental run after a rule change", async () => {
    const graph = directoryGraph();
    const repository = new MemoryDirectoryRepository(protection());
    const client = graph.client();
    await syncDirectory({ client, repository });
    await syncDirectory({ client, repository });

    repository.protection = protection({
      rules: normalizeRules({ includeSharedMailboxes: false }),
    });
    const third = await syncDirectory({ client, repository });

    expect(third.mode).toBe("incremental");
    expect(third.counts).toMatchObject({ users: 0, rescoped: 1 });
    expect(repository.objects.get("user-shared")?.status).toBe("excluded");
    expect(repository.objects.get("user-1")?.status).toBe("active");
  });

  it("enumerates everything again when a full sync is requested", async () => {
    const graph = directoryGraph();
    const repository = new MemoryDirectoryRepository(protection());
    const client = graph.client();
    await syncDirectory({ client, repository });

    const full = await syncDirectory({ client, repository, full: true });

    expect(full.mode).toBe("initial");
    expect(full.counts).toMatchObject({ users: 3, created: 0, updated: 0, orphaned: 0 });
    expect(graph.callsTo("GET", "deltatoken=USERSDELTA1")).toHaveLength(0);
  });

  it("resolves group membership transitively and excludes non-members", async () => {
    const graph = directoryGraph();
    const repository = new MemoryDirectoryRepository(
      protection({
        rules: normalizeRules({
          mode: "group",
          groupId: "grp-1",
          exclude: ["info@contoso.example"],
        }),
        overrides: { "drive-1": "exclude" },
      }),
    );
    const result = await syncDirectory({ client: graph.client(), repository });

    expect(result.warnings).toEqual([]);
    expect(statuses(repository)).toEqual([
      ["mailbox", "user-1", "active"],
      ["mailbox", "user-shared", "excluded"],
      ["onedrive", "drive-1", "excluded"],
    ]);
  });

  it("warns and excludes when the rule group cannot be resolved", async () => {
    const graph = directoryGraph();
    const repository = new MemoryDirectoryRepository(
      protection({ rules: normalizeRules({ mode: "group", groupId: "grp-missing" }) }),
    );
    const result = await syncDirectory({ client: graph.client(), repository });

    expect(result.warnings).toEqual([
      expect.objectContaining({ kind: "group_unresolved", groupId: "grp-missing", status: 404 }),
    ]);
    expect([...repository.objects.values()].every((o) => o.status === "excluded")).toBe(true);
  });

  it("reports failed probes and never guesses a drive", async () => {
    const graph = directoryGraph({
      drive: { "user-1": { status: 403, body: graphError("accessDenied", "Access denied") } },
      mailbox: {
        "user-shared": { status: 404, body: graphError("MailboxNotEnabledForRESTAPI") },
        "user-1": { status: 403, body: graphError("ErrorAccessDenied", "Access is denied.") },
      },
    });
    const repository = new MemoryDirectoryRepository(protection());
    const result = await syncDirectory({ client: graph.client(), repository });

    expect(result.warnings).toEqual([
      expect.objectContaining({
        kind: "mailbox_probe_failed",
        userId: "user-1",
        user: "alice@contoso.example",
        status: 403,
        code: "ErrorAccessDenied",
      }),
      expect.objectContaining({ kind: "drive_probe_failed", userId: "user-1", status: 403 }),
    ]);
    // Mailbox probe failed: the address decides. No mailbox in Exchange: none is created.
    expect(statuses(repository)).toEqual([["mailbox", "user-1", "active"]]);
  });

  it("stops before calling Graph when the job is already aborted", async () => {
    const graph = directoryGraph();
    const controller = new AbortController();
    controller.abort();
    await expect(
      syncDirectory({
        client: graph.client(),
        repository: new MemoryDirectoryRepository(protection()),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "JobAbortedError" });
    expect(graph.calls).toHaveLength(0);
  });
});

describe("latestPerUser", () => {
  it("merges changes and lets removals and re-creations win", () => {
    const merged = latestPerUser([
      { id: "a", displayName: "A" },
      { id: "a", mail: "a@x.y" },
      { id: "b", displayName: "B" },
      { id: "b", "@removed": { reason: "deleted" } },
      { id: "c", "@removed": { reason: "changed" } },
      { id: "c", displayName: "C again" },
    ]);
    expect(merged.get("a")).toEqual({ id: "a", displayName: "A", mail: "a@x.y" });
    expect(merged.get("b")).toEqual({ id: "b", "@removed": { reason: "deleted" } });
    expect(merged.get("c")).toEqual({ id: "c", displayName: "C again" });
  });
});
