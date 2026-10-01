import { describe, expect, it } from "vitest";
import {
  EMPTY_DIRECTORY_STATE,
  FULL_SYNC_INTERVAL_MS,
  MAX_STORED_WARNINGS,
  capWarnings,
  fullSyncReason,
  protectionVersion,
  readDirectoryState,
  readProtection,
  writeDirectoryState,
  writeOverride,
  writeRules,
} from "./config.js";
import { DEFAULT_PROTECTION_RULES, normalizeRules } from "./rules.js";
import type { SyncWarning } from "./sync.js";

describe("protection in sources.config", () => {
  it("defaults to protecting everyone", () => {
    expect(readProtection(undefined)).toEqual({ rules: DEFAULT_PROTECTION_RULES, overrides: {} });
    expect(readProtection("garbage")).toEqual({ rules: DEFAULT_PROTECTION_RULES, overrides: {} });
  });

  it("keeps the documented scope shape and stores directory-only data apart", () => {
    const rules = normalizeRules({
      mode: "group",
      groupId: "grp-1",
      groupName: "Backup users",
      exclude: ["svc@x.y"],
      includeSharedMailboxes: false,
    });
    const config = writeRules({ authKind: "password", scope: { mode: "all" } }, rules);
    expect(config).toEqual({
      authKind: "password",
      scope: { mode: "group", groupId: "grp-1", exclude: ["svc@x.y"] },
      protection: {
        includeSharedMailboxes: false,
        group: { id: "grp-1", name: "Backup users" },
        overrides: {},
      },
    });
    expect(readProtection(config).rules).toEqual(rules);
  });

  it("round-trips `selected` mode with no group, keeping the exclusion list for a later switch back", () => {
    const rules = normalizeRules({ mode: "selected", exclude: ["stale@x.y"], groupId: "grp-1" });
    const config = writeRules({}, rules);
    expect(config).toEqual({
      scope: { mode: "selected", exclude: ["stale@x.y"] },
      protection: { includeSharedMailboxes: true, group: null, overrides: {} },
    });
    expect(readProtection(config).rules).toEqual(rules);
  });

  it("survives a scope edit by the sources feature without losing overrides", () => {
    const withOverride = writeOverride(
      writeRules({}, normalizeRules({ mode: "group", groupId: "grp-1", groupName: "Old" })),
      "user-1",
      "exclude",
    );
    // The sources feature replaces `scope` as a whole.
    const edited = { ...withOverride, scope: { mode: "group", groupId: "grp-2", exclude: [] } };
    const { rules, overrides } = readProtection(edited);
    expect(overrides).toEqual({ "user-1": "exclude" });
    expect(rules.groupId).toBe("grp-2");
    // The stored label belongs to the old group and is not shown for the new one.
    expect(rules.groupName).toBeNull();
    expect(rules.includeSharedMailboxes).toBe(true);
  });

  it("sets and removes per-object overrides", () => {
    const set = writeOverride({}, "drive-1", "include");
    expect(readProtection(set).overrides).toEqual({ "drive-1": "include" });
    expect(readProtection(writeOverride(set, "drive-1", null)).overrides).toEqual({});
  });

  it("changes the version exactly when rules or overrides change", () => {
    const base = writeRules({ other: 1 }, DEFAULT_PROTECTION_RULES);
    expect(protectionVersion(base)).toBe(protectionVersion({ ...base, other: 2 }));
    expect(protectionVersion(base)).not.toBe(
      protectionVersion(writeOverride(base, "x", "exclude")),
    );
    expect(protectionVersion(base)).not.toBe(
      protectionVersion(writeRules(base, normalizeRules({ exclude: ["a@x.y"] }))),
    );
    // Override order does not matter.
    const ab = writeOverride(writeOverride(base, "a", "include"), "b", "exclude");
    const ba = writeOverride(writeOverride(base, "b", "exclude"), "a", "include");
    expect(protectionVersion(ab)).toBe(protectionVersion(ba));
  });
});

describe("sync state in sources.config", () => {
  it("round-trips and tolerates garbage", () => {
    expect(readDirectoryState({ directory: 7 })).toEqual(EMPTY_DIRECTORY_STATE);
    const state = {
      deltaLink: "https://graph/users/delta?$deltatoken=A",
      lastFullSyncAt: "2026-09-22T00:00:00.000Z",
      fullSyncRequestedAt: null,
      sharedOrBlockedIds: ["user-shared"],
      lastRun: {
        startedAt: "2026-09-22T00:00:00.000Z",
        finishedAt: "2026-09-22T00:01:00.000Z",
        ok: true,
        mode: "initial" as const,
        counts: null,
        warnings: [],
        warningCount: 0,
        error: null,
        failure: null,
      },
    };
    const config = writeDirectoryState({ scope: { mode: "all" } }, state);
    expect(config.scope).toEqual({ mode: "all" });
    expect(readDirectoryState(config)).toEqual(state);
  });

  it("keeps the classified cause of a failed run, and reads runs stored without one", () => {
    const failure = {
      v: 1 as const,
      code: "graph.permission_missing" as const,
      transient: false,
      params: { permission: "User.Read.All" },
      technical: { httpStatus: 403 },
      occurredAt: "2026-09-22T00:01:00.000Z",
      step: null,
      retry: null,
    };
    const failed = {
      ...EMPTY_DIRECTORY_STATE,
      lastRun: {
        startedAt: "2026-09-22T00:00:00.000Z",
        finishedAt: "2026-09-22T00:01:00.000Z",
        ok: false,
        mode: null,
        counts: null,
        warnings: [],
        warningCount: 0,
        error: "Graph 403",
        failure,
      },
    };
    expect(readDirectoryState(writeDirectoryState({}, failed)).lastRun?.failure).toEqual(failure);
    // A run stored before causes existed has no `failure` key at all.
    const { failure: _dropped, ...legacy } = failed.lastRun;
    const read = readDirectoryState({ directory: { lastRun: legacy } });
    expect(read.lastRun).toMatchObject({ ok: false, error: "Graph 403", failure: null });
  });

  it("caps stored warnings but keeps their number", () => {
    const warning: SyncWarning = {
      kind: "drive_probe_failed",
      userId: "u",
      user: null,
      status: 403,
      code: null,
      message: "denied",
    };
    const many = Array.from({ length: MAX_STORED_WARNINGS + 7 }, () => warning);
    const capped = capWarnings(many);
    expect(capped.warnings).toHaveLength(MAX_STORED_WARNINGS);
    expect(capped.warningCount).toBe(MAX_STORED_WARNINGS + 7);
  });
});

describe("fullSyncReason", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");
  const recent = {
    ...EMPTY_DIRECTORY_STATE,
    deltaLink: "link",
    lastFullSyncAt: "2026-09-23T06:00:00.000Z",
  };

  it("runs incrementally while the last full enumeration is recent", () => {
    expect(fullSyncReason(recent, now)).toBeNull();
  });

  it("enumerates everything without a link, the first time, on request and daily", () => {
    expect(fullSyncReason({ ...recent, deltaLink: null }, now)).toBe("no_delta_link");
    expect(fullSyncReason({ ...recent, lastFullSyncAt: null }, now)).toBe("never");
    expect(
      fullSyncReason({ ...recent, fullSyncRequestedAt: "2026-09-23T07:00:00.000Z" }, now),
    ).toBe("requested");
    expect(
      fullSyncReason({ ...recent, fullSyncRequestedAt: "2026-09-23T05:00:00.000Z" }, now),
    ).toBeNull();
    const dayLater = new Date(Date.parse(recent.lastFullSyncAt) + FULL_SYNC_INTERVAL_MS);
    expect(fullSyncReason(recent, dayLater)).toBe("interval");
  });
});
