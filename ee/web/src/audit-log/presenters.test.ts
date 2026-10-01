import { describe, expect, it } from "vitest";

import type { ChainReport } from "./api";
import {
  actionCategory,
  actionChoices,
  actionLabelKey,
  breakEntryId,
  describeActor,
  formatAnchorDate,
  formatDetails,
  formatDuration,
  groupActions,
  isOpaqueId,
  matchesActionSearch,
  shortHash,
  sortChainReports,
} from "./presenters";

describe("actions", () => {
  it("derives label keys and categories from dotted codes", () => {
    expect(actionLabelKey("tenant.member.added")).toBe("events.tenant.member.added");
    expect(actionCategory("tenant.member.added")).toBe("tenant");
    expect(actionCategory("login")).toBe("login");
  });

  it("groups the facet by category with totals, both levels sorted", () => {
    expect(
      groupActions([
        { action: "tenant.updated", count: 1 },
        { action: "restore.requested", count: 4 },
        { action: "tenant.created", count: 2 },
        { action: "restore.downloaded", count: 1 },
      ]),
    ).toEqual([
      {
        category: "restore",
        total: 5,
        actions: [
          { action: "restore.downloaded", count: 1 },
          { action: "restore.requested", count: 4 },
        ],
      },
      {
        category: "tenant",
        total: 3,
        actions: [
          { action: "tenant.created", count: 2 },
          { action: "tenant.updated", count: 1 },
        ],
      },
    ]);
    expect(groupActions([])).toEqual([]);
  });
});

describe("describeActor", () => {
  it("recognizes the labels the API writes", () => {
    expect(describeActor("system")).toEqual({ kind: "system" });
    expect(describeActor("entra:admin-consent")).toEqual({ kind: "adminConsent" });
    expect(describeActor("api-key:k1")).toEqual({ kind: "apiKey", id: "k1" });
    expect(describeActor("user:u1")).toEqual({ kind: "user", id: "u1" });
    expect(describeActor("ops@example.com")).toEqual({ kind: "label", label: "ops@example.com" });
    expect(describeActor("api-key:")).toEqual({ kind: "label", label: "api-key:" });
  });
});

describe("shortHash", () => {
  it("keeps the ends of a long hash", () => {
    expect(shortHash(`${"a".repeat(8)}${"b".repeat(52)}cdef`)).toBe("aaaaaaaa…cdef");
    expect(shortHash("short")).toBe("short");
  });
});

function report(overrides: Partial<ChainReport>): ChainReport {
  return {
    tenantId: "t",
    tenantName: "T",
    status: "intact",
    verifiedEntries: 1,
    head: null,
    anchors: { total: 0, verified: 0, latest: null },
    firstBreak: null,
    ...overrides,
  };
}

describe("sortChainReports", () => {
  it("lists broken chains first, then the installation, then tenants by name", () => {
    const sorted = sortChainReports([
      report({ tenantId: "b", tenantName: "Zeta", status: "intact" }),
      report({ tenantId: "c", tenantName: "Alpha", status: "empty" }),
      report({ tenantId: null, tenantName: null, status: "intact" }),
      report({ tenantId: "d", tenantName: "Beta", status: "broken" }),
      report({ tenantId: "e", tenantName: "Alpha", status: "intact" }),
    ]);
    expect(sorted.map((item) => item.tenantId)).toEqual(["d", null, "e", "b", "c"]);
  });
});

describe("breakEntryId", () => {
  it("points at the entry of hash and link breaks only", () => {
    expect(
      breakEntryId({
        reason: "hash_mismatch",
        position: 2,
        entryId: "x",
        createdAt: "2026-09-21T10:00:00.000Z",
        storedHash: "a",
        computedHash: "b",
      }),
    ).toBe("x");
    expect(
      breakEntryId({
        reason: "anchor_mismatch",
        position: 2,
        anchorDate: "2026-09-21",
        anchoredHash: "a",
        anchoredCount: 2,
        chainHash: null,
        chainCount: 0,
      }),
    ).toBeNull();
  });
});

describe("formatDetails", () => {
  it("pretty-prints details and treats empty ones as absent", () => {
    expect(formatDetails({ items: 3 })).toBe('{\n  "items": 3\n}');
    expect(formatDetails({})).toBeNull();
    expect(formatDetails(null)).toBeNull();
  });
});

describe("formatting", () => {
  it("formats durations in the UI language", () => {
    expect(formatDuration(840, "en")).toContain("840");
    expect(formatDuration(3240, "en")).toContain("3.2");
    expect(formatDuration(3240, "de")).toContain("3,2");
    expect(formatDuration(Number.NaN, "en")).toContain("0");
  });

  it("formats anchor days as UTC calendar days", () => {
    expect(formatAnchorDate("2026-09-21", "de")).toBe("21.09.2026");
    expect(formatAnchorDate("2026-01-01", "en")).toBe("Jan 1, 2026");
  });
});

describe("isOpaqueId", () => {
  it("recognises a UUID in either letter case and nothing a person can read", () => {
    expect(isOpaqueId("5b0a77d2-0c9a-4e0f-8c64-1f2d3a4b5c6d")).toBe(true);
    expect(isOpaqueId("5B0A77D2-0C9A-4E0F-8C64-1F2D3A4B5C6D")).toBe(true);
    expect(isOpaqueId("anna@contoso.example")).toBe(false);
    expect(isOpaqueId("Fabrikam M365")).toBe(false);
    expect(isOpaqueId("all")).toBe(false);
    expect(isOpaqueId("5b0a77d2-0c9a-4e0f-8c64")).toBe(false);
  });
});

describe("action filter rows", () => {
  const labels = {
    category: (category: string) =>
      ({ restore: "Wiederherstellung", tenant: "Mandanten", access: "Zugriff" })[category] ??
      category,
    action: (action: string) =>
      ({
        "restore.requested": "Wiederherstellung angefordert",
        "restore.downloaded": "Wiederherstellung heruntergeladen",
        "tenant.created": "Mandant angelegt",
      })[action] ?? null,
  };
  const groups = groupActions([
    { action: "tenant.created", count: 2 },
    { action: "restore.requested", count: 4 },
    { action: "restore.downloaded", count: 1 },
    { action: "access", count: 3 },
    { action: "tenant.unknown_new_code", count: 1 },
  ]);

  it("makes the category row the choice for the whole category, with no extra 'all of' row", () => {
    const rows = actionChoices(groups, labels, "de");
    expect(rows.map((row) => row.category.value)).toEqual(["tenant", "restore", "access"]);
    const restore = rows.find((row) => row.category.value === "restore");
    expect(restore?.category.label).toBe("Wiederherstellung");
    expect(restore?.actions.map((item) => item.value)).toEqual([
      "restore.requested",
      "restore.downloaded",
    ]);
    // The URL keeps its values: the prefix for a category, the code for an action.
    expect(rows.flatMap((row) => [row.category, ...row.actions]).map((row) => row.value)).toEqual([
      "tenant",
      "tenant.created",
      "tenant.unknown_new_code",
      "restore",
      "restore.requested",
      "restore.downloaded",
      "access",
    ]);
  });

  it("lists a single action named like its category as the category row alone", () => {
    const access = actionChoices(groups, labels, "de").find(
      (row) => row.category.value === "access",
    );
    expect(access?.actions).toEqual([]);
    expect(access?.category.label).toBe("Zugriff");
  });

  it("shows an unknown code as it is", () => {
    const tenant = actionChoices(groups, labels, "de").find(
      (row) => row.category.value === "tenant",
    );
    expect(tenant?.actions.map((item) => item.label)).toContain("tenant.unknown_new_code");
  });

  it("finds rows by category and action labels, any case, with or without umlauts", () => {
    const rows = actionChoices(groups, labels, "de");
    const restore = rows.find((row) => row.category.value === "restore");
    const requested = restore?.actions[0];
    expect(matchesActionSearch(requested?.keywords ?? [], "angef")).toBe(true);
    expect(matchesActionSearch(requested?.keywords ?? [], "WIEDERHER angef")).toBe(true);
    // Labels in the UI language only: the English code does not match in German.
    expect(matchesActionSearch(requested?.keywords ?? [], "requested")).toBe(false);
    expect(matchesActionSearch(requested?.keywords ?? [], "mandant")).toBe(false);
    // A category row answers to its actions too, so it stays above a matching action.
    expect(matchesActionSearch(restore?.category.keywords ?? [], "heruntergeladen")).toBe(true);
    expect(matchesActionSearch(["Prüfung gestartet"], "prufung")).toBe(true);
    expect(matchesActionSearch(["Prüfung gestartet"], "  ")).toBe(true);
  });
});
