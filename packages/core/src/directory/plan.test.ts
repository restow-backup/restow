import { describe, expect, it } from "vitest";
import type { UserDeltaEntry } from "../graph/resources/users.js";
import fixture from "../graph/testing/fixtures/users-delta.json" with { type: "json" };
import {
  type DirectoryUserRecord,
  type KnownObject,
  type PlanInput,
  type UserProbe,
  hasMailbox,
  isPartialEntry,
  planDirectory,
  probeTargets,
  toDirectoryUser,
} from "./plan.js";
import { DEFAULT_PROTECTION_RULES, normalizeRules } from "./rules.js";

const entries = [...fixture.initialPage1.value, ...fixture.initialPage2.value] as UserDeltaEntry[];

function user(id: string): DirectoryUserRecord {
  const entry = entries.find((candidate) => candidate.id === id);
  const record = entry ? toDirectoryUser(entry) : null;
  if (!record) {
    throw new Error(`fixture user ${id} is missing or incomplete`);
  }
  return record;
}

const alice = user("user-1");
const shared = user("user-shared");
const guest = user("user-guest");

/** A known object owned by one of the fixture users. */
function known(
  owner: DirectoryUserRecord,
  kind: KnownObject["kind"],
  externalId: string,
  status: KnownObject["status"] = "active",
): KnownObject {
  return {
    externalId,
    kind,
    status,
    origin: "directory_sync",
    displayName: owner.displayName,
    owner: { entraObjectId: owner.entraObjectId, upn: owner.upn, email: owner.email },
  };
}

const probes = (entries: [string, UserProbe][]) => new Map<string, UserProbe>(entries);

function plan(input: Partial<PlanInput>) {
  return planDirectory({
    mode: "initial",
    users: [],
    removedUserIds: [],
    known: [],
    sharedOrBlockedIds: new Set(),
    probes: new Map(),
    rules: DEFAULT_PROTECTION_RULES,
    overrides: {},
    groupMemberIds: null,
    ...input,
  });
}

describe("toDirectoryUser", () => {
  it("maps a complete entry and falls back to the UPN for the address", () => {
    expect(alice).toEqual({
      entraObjectId: "user-1",
      email: "alice@contoso.example",
      upn: "alice@contoso.example",
      mail: "alice@contoso.example",
      displayName: "Alice Example",
      accountEnabled: true,
      userType: "Member",
    });
    const noMail = toDirectoryUser({
      id: "user-x",
      userPrincipalName: "x@contoso.example",
      displayName: null,
      accountEnabled: true,
      userType: "Member",
      mail: null,
    });
    expect(noMail?.email).toBe("x@contoso.example");
    expect(noMail?.mail).toBeNull();
  });

  it("recognises partial and removed entries", () => {
    const partial = fixture.incrementalPage.value[1] as UserDeltaEntry;
    expect(isPartialEntry(partial)).toBe(true);
    expect(toDirectoryUser(partial)).toBeNull();
    // A missing `mail` must not read as "no mailbox".
    const { mail: _mail, ...withoutMail } = entries[0] as UserDeltaEntry;
    expect(isPartialEntry(withoutMail as UserDeltaEntry)).toBe(true);
    const removed = fixture.incrementalPage.value[0] as UserDeltaEntry;
    expect(isPartialEntry(removed)).toBe(false);
    expect(toDirectoryUser(removed)).toBeNull();
  });
});

describe("probing", () => {
  it("probes mailboxes of members with an address and drives of every member", () => {
    const noMail: DirectoryUserRecord = { ...alice, entraObjectId: "user-nomail", mail: null };
    expect(probeTargets([alice, shared, guest, noMail])).toEqual({
      mailbox: ["user-1", "user-shared"],
      drive: ["user-1", "user-shared", "user-nomail"],
    });
  });

  it("trusts a mailbox probe and falls back to the address when it failed", () => {
    expect(hasMailbox(alice, { mailbox: false })).toBe(false);
    expect(hasMailbox(alice, {})).toBe(true);
    expect(hasMailbox({ ...alice, mail: null }, undefined)).toBe(false);
    expect(hasMailbox(guest, { mailbox: true })).toBe(false);
  });
});

describe("planDirectory: a full enumeration", () => {
  it("creates a mailbox per mailbox owner and a OneDrive per provisioned drive", () => {
    const result = plan({
      users: [alice, shared, guest],
      probes: probes([
        ["user-1", { mailbox: true, driveId: "drive-1" }],
        ["user-shared", { mailbox: true, driveId: null }],
      ]),
    });
    expect(result.objects.map((o) => [o.kind, o.externalId, o.status, o.reason, o.change])).toEqual(
      [
        ["mailbox", "user-1", "active", "rule_all", "created"],
        ["onedrive", "drive-1", "active", "rule_all", "created"],
        ["mailbox", "user-shared", "active", "rule_all", "created"],
      ],
    );
    expect(result.sharedOrBlockedIds).toEqual(["user-shared"]);
    expect(result.counts).toEqual({
      users: 3,
      removedUsers: 0,
      guests: 1,
      created: 3,
      updated: 0,
      rescoped: 0,
      orphaned: 0,
    });
  });

  it("writes nothing when nothing changed", () => {
    const result = plan({
      users: [alice, shared],
      known: [known(alice, "mailbox", "user-1"), known(shared, "mailbox", "user-shared")],
      probes: probes([
        ["user-1", { mailbox: true, driveId: null }],
        ["user-shared", { mailbox: true, driveId: null }],
      ]),
    });
    expect(result.objects).toEqual([]);
    expect(result.orphanExternalIds).toEqual([]);
  });

  it("applies rules and per-object overrides independently per object", () => {
    const result = plan({
      users: [alice, shared],
      probes: probes([["user-1", { driveId: "drive-1" }]]),
      rules: normalizeRules({ mode: "group", groupId: "grp-1" }),
      overrides: { "drive-1": "exclude", "user-shared": "include" },
      groupMemberIds: new Set(["user-1"]),
    });
    expect(result.objects.map((o) => [o.externalId, o.status, o.reason])).toEqual([
      ["user-1", "active", "group_member"],
      ["drive-1", "excluded", "override_exclude"],
      ["user-shared", "active", "override_include"],
    ]);
  });

  it("in `selected` mode protects only objects an admin explicitly included", () => {
    const result = plan({
      users: [alice, shared],
      probes: probes([
        ["user-1", { mailbox: true, driveId: "drive-1" }],
        ["user-shared", { mailbox: true, driveId: null }],
      ]),
      rules: normalizeRules({ mode: "selected" }),
      overrides: { "user-1": "include" },
    });
    expect(result.objects.map((o) => [o.externalId, o.status, o.reason])).toEqual([
      ["user-1", "active", "override_include"],
      // Not overridden: no protection by default, no matter its owner or drive.
      ["drive-1", "excluded", "not_selected"],
      ["user-shared", "excluded", "not_selected"],
    ]);
  });

  it("orphans what the directory no longer lists and revives what came back", () => {
    const gone: DirectoryUserRecord = { ...alice, entraObjectId: "user-gone", email: "gone@x.y" };
    const result = plan({
      mode: "resync",
      users: [alice],
      known: [
        known(alice, "mailbox", "user-1", "orphaned"),
        known(gone, "mailbox", "user-gone"),
        { ...known(gone, "onedrive", "drive-unlinked"), owner: null },
        known(gone, "onedrive", "drive-old", "orphaned"),
      ],
    });
    expect(result.objects.map((o) => [o.externalId, o.status, o.change])).toEqual([
      ["user-1", "active", "updated"],
    ]);
    // Already orphaned objects are not written again.
    expect([...result.orphanExternalIds].sort()).toEqual(["drive-unlinked", "user-gone"]);
    expect(result.counts.orphaned).toBe(2);
  });

  it("replaces the shared/blocked set instead of accumulating it", () => {
    const result = plan({
      mode: "initial",
      users: [alice],
      sharedOrBlockedIds: new Set(["user-shared", "user-old"]),
    });
    expect(result.sharedOrBlockedIds).toEqual([]);
  });
});

describe("planDirectory: an incremental run", () => {
  it("orphans the objects of removed users and leaves the rest alone", () => {
    const gone: DirectoryUserRecord = { ...alice, entraObjectId: "user-gone", email: "gone@x.y" };
    const result = plan({
      mode: "incremental",
      removedUserIds: ["user-gone"],
      known: [
        known(alice, "mailbox", "user-1"),
        known(alice, "onedrive", "drive-1"),
        known(gone, "mailbox", "user-gone"),
        {
          externalId: "manual-login",
          kind: "mailbox",
          status: "active",
          origin: "manual",
          displayName: null,
          owner: null,
        },
      ],
    });
    expect(result.objects).toEqual([]);
    expect(result.orphanExternalIds).toEqual(["user-gone"]);
  });

  it("re-scopes unchanged users when the rules change", () => {
    const result = plan({
      mode: "incremental",
      known: [
        known(alice, "mailbox", "user-1"),
        known(alice, "onedrive", "drive-1"),
        known(shared, "mailbox", "user-shared"),
      ],
      sharedOrBlockedIds: new Set(["user-shared"]),
      rules: normalizeRules({ exclude: ["alice@contoso.example"], includeSharedMailboxes: false }),
    });
    expect(result.objects.map((o) => [o.externalId, o.status, o.reason, o.change])).toEqual([
      ["user-1", "excluded", "exclusion_list", "rescoped"],
      ["drive-1", "excluded", "exclusion_list", "rescoped"],
      ["user-shared", "excluded", "shared_mailbox_disabled", "rescoped"],
    ]);
    expect(result.counts.rescoped).toBe(3);
  });

  it("follows group membership changes that users/delta never reports", () => {
    const rules = normalizeRules({ mode: "group", groupId: "grp-1" });
    const result = plan({
      mode: "incremental",
      known: [
        known(alice, "mailbox", "user-1", "excluded"),
        known(shared, "mailbox", "user-shared", "active"),
      ],
      rules,
      groupMemberIds: new Set(["user-1"]),
    });
    expect(result.objects.map((o) => [o.externalId, o.status, o.reason])).toEqual([
      ["user-1", "active", "group_member"],
      ["user-shared", "excluded", "not_in_group"],
    ]);
  });

  it("returns an object to the rules after its override was removed", () => {
    const result = plan({
      mode: "incremental",
      known: [known(alice, "mailbox", "user-1", "excluded")],
      overrides: {},
    });
    expect(result.objects.map((o) => [o.externalId, o.status, o.change])).toEqual([
      ["user-1", "active", "rescoped"],
    ]);
  });

  it("never revives an orphaned object of an unchanged user", () => {
    const result = plan({
      mode: "incremental",
      known: [known(alice, "mailbox", "user-1", "orphaned")],
      overrides: { "user-1": "include" },
    });
    expect(result.objects).toEqual([]);
    expect(result.orphanExternalIds).toEqual([]);
  });

  it("maintains the shared/blocked set from the users it saw", () => {
    const enabled: DirectoryUserRecord = { ...shared, accountEnabled: true };
    const result = plan({
      mode: "incremental",
      users: [enabled, { ...alice, accountEnabled: false }],
      removedUserIds: ["user-removed"],
      sharedOrBlockedIds: new Set(["user-shared", "user-removed", "user-other"]),
    });
    expect(result.sharedOrBlockedIds).toEqual(["user-1", "user-other"]);
  });

  it("handles a drive that appeared, vanished, was not probed or was replaced", () => {
    const knownDrive = known(alice, "onedrive", "drive-1", "excluded");
    const base = { mode: "incremental" as const, users: [alice], known: [knownDrive] };

    const vanished = plan({ ...base, probes: probes([["user-1", { driveId: null }]]) });
    expect(vanished.orphanExternalIds).toEqual(["drive-1"]);

    const notProbed = plan(base);
    expect(notProbed.orphanExternalIds).toEqual([]);
    expect(notProbed.objects.map((o) => [o.externalId, o.status, o.change])).toEqual([
      ["user-1", "active", "created"],
      ["drive-1", "active", "updated"],
    ]);

    const replaced = plan({ ...base, probes: probes([["user-1", { driveId: "drive-2" }]]) });
    expect(replaced.orphanExternalIds).toEqual(["drive-1"]);
    expect(replaced.objects.map((o) => [o.externalId, o.change])).toContainEqual([
      "drive-2",
      "created",
    ]);
  });

  it("orphans a mailbox Exchange no longer hosts and every object of a user turned guest", () => {
    const result = plan({
      mode: "incremental",
      users: [alice, guest],
      known: [known(alice, "mailbox", "user-1"), known(guest, "mailbox", "user-guest")],
      probes: probes([["user-1", { mailbox: false }]]),
    });
    expect(result.objects).toEqual([]);
    expect([...result.orphanExternalIds].sort()).toEqual(["user-1", "user-guest"]);
  });
});
