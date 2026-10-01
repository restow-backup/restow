import { describe, expect, it } from "vitest";
import {
  containsPattern,
  decideOverride,
  fullSyncPending,
  isNotSelected,
  rulesFromInput,
} from "./logic.js";
import { accountsRequestSchema, objectsQuerySchema, rulesSchema } from "./schemas.js";

describe("rulesFromInput", () => {
  it("normalises a validated body into a rule set", () => {
    const input = rulesSchema.parse({
      mode: "group",
      groupId: " grp-1 ",
      groupName: "Backup",
      exclude: ["A@x.y", "a@x.y"],
    });
    expect(rulesFromInput(input)).toEqual({
      mode: "group",
      groupId: "grp-1",
      groupName: "Backup",
      exclude: ["A@x.y"],
      includeSharedMailboxes: true,
    });
  });

  it("rejects group mode without a group", () => {
    expect(rulesSchema.safeParse({ mode: "group", exclude: [] }).success).toBe(false);
    expect(rulesSchema.safeParse({ mode: "all" }).success).toBe(true);
  });
});

describe("decideOverride", () => {
  it("includes and excludes M365 objects at once and records the override", () => {
    expect(decideOverride("include", "excluded", "m365")).toEqual({
      status: "active",
      override: "include",
      needsSync: false,
    });
    expect(decideOverride("exclude", "active", "m365")).toEqual({
      status: "excluded",
      override: "exclude",
      needsSync: false,
    });
  });

  it("leaves a reset of an M365 object to the sync", () => {
    expect(decideOverride("reset", "excluded", "m365")).toEqual({
      status: "excluded",
      override: null,
      needsSync: true,
    });
  });

  it("keeps no override for IMAP accounts, where a reset means protected", () => {
    expect(decideOverride("exclude", "active", "imap")).toEqual({
      status: "excluded",
      override: null,
      needsSync: false,
    });
    expect(decideOverride("reset", "excluded", "imap")).toEqual({
      status: "active",
      override: null,
      needsSync: false,
    });
  });

  it("never revives an orphaned object but remembers the decision", () => {
    expect(decideOverride("include", "orphaned", "m365")).toEqual({
      status: "orphaned",
      override: "include",
      needsSync: false,
    });
    expect(decideOverride("reset", "orphaned", "m365")).toEqual({
      status: "orphaned",
      override: null,
      needsSync: false,
    });
    expect(decideOverride("include", "orphaned", "imap").status).toBe("orphaned");
  });
});

describe("fullSyncPending", () => {
  it("is pending until a full enumeration started after the request", () => {
    expect(fullSyncPending(null, null)).toBe(false);
    expect(fullSyncPending("2026-09-23T10:00:00Z", null)).toBe(true);
    expect(fullSyncPending("2026-09-23T10:00:00Z", "2026-09-23T09:00:00Z")).toBe(true);
    expect(fullSyncPending("2026-09-23T10:00:00Z", "2026-09-23T11:00:00Z")).toBe(false);
  });
});

describe("containsPattern", () => {
  it("escapes LIKE wildcards", () => {
    expect(containsPattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
  });
});

describe("isNotSelected", () => {
  it("is true only for a `selected`-mode M365 object excluded by default", () => {
    expect(isNotSelected("m365", "selected", "excluded", null)).toBe(true);
    expect(isNotSelected("m365", "selected", "excluded", "exclude")).toBe(false);
    expect(isNotSelected("m365", "selected", "active", null)).toBe(false);
    expect(isNotSelected("m365", "all", "excluded", null)).toBe(false);
    expect(isNotSelected("imap", "selected", "excluded", null)).toBe(false);
  });
});

describe("request schemas", () => {
  it("coerces paging and applies defaults", () => {
    expect(objectsQuerySchema.parse({ page: "2", pageSize: "50", status: "active" })).toEqual({
      page: 2,
      pageSize: 50,
      status: "active",
      sort: "name",
      order: "asc",
    });
    expect(objectsQuerySchema.safeParse({ pageSize: "5000" }).success).toBe(false);
  });

  it("accepts accounts with optional address and name", () => {
    expect(accountsRequestSchema.parse({ accounts: [{ login: "a", email: null }] }).dryRun).toBe(
      false,
    );
    expect(accountsRequestSchema.safeParse({ accounts: [] }).success).toBe(false);
  });
});
