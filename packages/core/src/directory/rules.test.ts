import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROTECTION_RULES,
  type ProtectionSubject,
  evaluateProtection,
  isSharedOrBlocked,
  matchesExclusion,
  normalizeOverrides,
  normalizeRules,
  statusForOverride,
  uniqueIdentities,
} from "./rules.js";

const alice: ProtectionSubject = {
  entraObjectId: "user-1",
  upn: "alice@contoso.example",
  mail: "Alice@contoso.example",
  sharedOrBlocked: false,
};

const shared: ProtectionSubject = {
  entraObjectId: "user-shared",
  upn: "info@contoso.example",
  mail: "info@contoso.example",
  sharedOrBlocked: true,
};

describe("normalizeRules", () => {
  it("falls back to protecting everyone", () => {
    expect(normalizeRules(undefined)).toEqual(DEFAULT_PROTECTION_RULES);
    expect(normalizeRules({ mode: "nonsense", exclude: "not-a-list" })).toEqual(
      DEFAULT_PROTECTION_RULES,
    );
  });

  it("only accepts group mode with a group id and de-duplicates the exclusion list", () => {
    expect(normalizeRules({ mode: "group" }).mode).toBe("all");
    expect(normalizeRules({ mode: "group", groupId: "   " }).mode).toBe("all");
    const rules = normalizeRules({
      mode: "group",
      groupId: " grp-1 ",
      groupName: "Backup users",
      exclude: ["Bob@contoso.example", "bob@contoso.example", " ", 42, "svc@contoso.example"],
      includeSharedMailboxes: false,
    });
    expect(rules).toEqual({
      mode: "group",
      groupId: "grp-1",
      groupName: "Backup users",
      exclude: ["Bob@contoso.example", "svc@contoso.example"],
      includeSharedMailboxes: false,
    });
  });

  it("drops the group of an `all` rule set", () => {
    expect(normalizeRules({ mode: "all", groupId: "grp-1", groupName: "x" })).toMatchObject({
      groupId: null,
      groupName: null,
    });
  });

  it("accepts `selected` mode, drops its group but keeps the exclusion list", () => {
    // The list is meaningless while `selected` is active (evaluateProtection
    // never reads it), but it must survive the round-trip: switching back to
    // `all`/`group` later should not silently un-exclude anyone.
    expect(
      normalizeRules({
        mode: "selected",
        groupId: "grp-1",
        groupName: "x",
        exclude: ["scanner@contoso.example"],
        includeSharedMailboxes: false,
      }),
    ).toEqual({
      mode: "selected",
      groupId: null,
      groupName: null,
      exclude: ["scanner@contoso.example"],
      includeSharedMailboxes: false,
    });
  });

  it("keeps only valid overrides", () => {
    expect(normalizeOverrides({ a: "include", b: "exclude", c: "maybe", " ": "include" })).toEqual({
      a: "include",
      b: "exclude",
    });
    expect(normalizeOverrides(["include"])).toEqual({});
    expect(normalizeOverrides(null)).toEqual({});
  });

  it("uniqueIdentities keeps the first spelling", () => {
    expect(uniqueIdentities(["A@x.y", "a@x.y", " b@x.y "])).toEqual(["A@x.y", "b@x.y"]);
  });
});

describe("isSharedOrBlocked", () => {
  it("means a sign-in disabled member with an address", () => {
    expect(isSharedOrBlocked({ accountEnabled: false, mail: "a@x.y", userType: "Member" })).toBe(
      true,
    );
    expect(isSharedOrBlocked({ accountEnabled: false, mail: "a@x.y", userType: null })).toBe(true);
    expect(isSharedOrBlocked({ accountEnabled: true, mail: "a@x.y", userType: "Member" })).toBe(
      false,
    );
    expect(isSharedOrBlocked({ accountEnabled: false, mail: null, userType: "Member" })).toBe(
      false,
    );
    expect(isSharedOrBlocked({ accountEnabled: false, mail: "a@x.y", userType: "Guest" })).toBe(
      false,
    );
  });
});

describe("matchesExclusion", () => {
  it("matches object id, UPN and mail case-insensitively", () => {
    expect(matchesExclusion(alice, ["USER-1"])).toBe(true);
    expect(matchesExclusion(alice, ["ALICE@contoso.example"])).toBe(true);
    expect(matchesExclusion(alice, ["bob@contoso.example"])).toBe(false);
    expect(matchesExclusion(alice, [])).toBe(false);
  });
});

describe("evaluateProtection", () => {
  it("protects everyone in `all` mode, shared mailboxes included", () => {
    expect(evaluateProtection({ subject: alice, rules: DEFAULT_PROTECTION_RULES })).toEqual({
      status: "active",
      reason: "rule_all",
    });
    expect(evaluateProtection({ subject: shared, rules: DEFAULT_PROTECTION_RULES })).toEqual({
      status: "active",
      reason: "rule_all",
    });
  });

  it("honours the exclusion list before the mode", () => {
    const rules = normalizeRules({ exclude: ["alice@contoso.example"] });
    expect(evaluateProtection({ subject: alice, rules })).toEqual({
      status: "excluded",
      reason: "exclusion_list",
    });
  });

  it("can leave shared or blocked mailboxes out", () => {
    const rules = normalizeRules({ includeSharedMailboxes: false });
    expect(evaluateProtection({ subject: shared, rules })).toEqual({
      status: "excluded",
      reason: "shared_mailbox_disabled",
    });
    expect(evaluateProtection({ subject: alice, rules }).status).toBe("active");
  });

  it("decides group mode by transitive membership and never includes when unresolved", () => {
    const rules = normalizeRules({ mode: "group", groupId: "grp-1" });
    const members = new Set(["user-1"]);
    expect(evaluateProtection({ subject: alice, rules, groupMemberIds: members })).toEqual({
      status: "active",
      reason: "group_member",
    });
    expect(evaluateProtection({ subject: shared, rules, groupMemberIds: members })).toEqual({
      status: "excluded",
      reason: "not_in_group",
    });
    expect(evaluateProtection({ subject: alice, rules, groupMemberIds: null })).toEqual({
      status: "excluded",
      reason: "group_unresolved",
    });
  });

  it("lets a per-object override beat every rule", () => {
    const rules = normalizeRules({
      mode: "group",
      groupId: "grp-1",
      exclude: ["user-1"],
      includeSharedMailboxes: false,
    });
    expect(
      evaluateProtection({ subject: alice, rules, override: "include", groupMemberIds: null }),
    ).toEqual({ status: "active", reason: "override_include" });
    expect(
      evaluateProtection({ subject: shared, rules, override: "include", groupMemberIds: null }),
    ).toEqual({ status: "active", reason: "override_include" });
    expect(
      evaluateProtection({ subject: alice, rules: DEFAULT_PROTECTION_RULES, override: "exclude" }),
    ).toEqual({ status: "excluded", reason: "override_exclude" });
  });

  it("maps overrides onto an immediate status", () => {
    expect(statusForOverride("include")).toBe("active");
    expect(statusForOverride("exclude")).toBe("excluded");
  });

  it("in `selected` mode excludes everyone by default, regardless of the exclusion list or the shared switch", () => {
    const rules = normalizeRules({
      mode: "selected",
      // These would matter in `all`/`group` mode; `selected` ignores them.
      exclude: ["bob@contoso.example"],
      includeSharedMailboxes: false,
    });
    expect(evaluateProtection({ subject: alice, rules })).toEqual({
      status: "excluded",
      reason: "not_selected",
    });
    expect(evaluateProtection({ subject: shared, rules })).toEqual({
      status: "excluded",
      reason: "not_selected",
    });
  });

  it("in `selected` mode only an `include` override protects", () => {
    const rules = normalizeRules({ mode: "selected" });
    expect(evaluateProtection({ subject: alice, rules, override: "include" })).toEqual({
      status: "active",
      reason: "override_include",
    });
    expect(evaluateProtection({ subject: alice, rules, override: "exclude" })).toEqual({
      status: "excluded",
      reason: "override_exclude",
    });
  });
});
