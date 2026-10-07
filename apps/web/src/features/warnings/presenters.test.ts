import { describe, expect, it } from "vitest";

import type { WarningSummary } from "./api";
import { parseWarningsSearch } from "./paths";
import {
  acknowledgeBlock,
  acknowledgeableRefs,
  acknowledgementApplies,
  itemFolder,
  itemTitle,
  mayAcknowledge,
  outcomeTone,
  refKey,
  stateTone,
} from "./presenters";

function summary(overrides: Partial<WarningSummary> = {}): WarningSummary {
  return {
    target: { kind: "object", id: "o-1", subjectKind: "mailbox", name: "Anna", detail: null },
    state: "open",
    latestRun: {
      id: "r-1",
      outcome: "partial",
      finishedAt: "2026-10-07T10:00:00Z",
      failedItems: 2,
    },
    causes: [{ code: "graph.item_too_large", count: 2 }],
    newCauses: ["graph.item_too_large"],
    acknowledgement: null,
    ...overrides,
  };
}

describe("who may acknowledge", () => {
  it("lets a tenant's administrator and a provider technician or more acknowledge", () => {
    expect(mayAcknowledge({ role: "tenant_admin", isProviderAdmin: false })).toBe(true);
    expect(mayAcknowledge({ role: "tenant_user", isProviderAdmin: false })).toBe(false);
    expect(
      mayAcknowledge({ role: "provider_admin", isProviderAdmin: true, providerRole: "technician" }),
    ).toBe(true);
    expect(
      mayAcknowledge({ role: "provider_admin", isProviderAdmin: true, providerRole: "read_only" }),
    ).toBe(false);
    // A provider admin without a team role is an owner (an older server).
    expect(mayAcknowledge({ role: "provider_admin", isProviderAdmin: true })).toBe(true);
  });
});

describe("why acknowledging is closed", () => {
  it("names the role first, then what the server refuses", () => {
    const open = { state: "open" as const, acknowledge: { allowed: true, refusal: null } };
    expect(acknowledgeBlock(open, true)).toBeNull();
    expect(acknowledgeBlock(open, false)).toBe("notAllowed");
    expect(
      acknowledgeBlock(
        { state: "failed", acknowledge: { allowed: false, refusal: "failed" } },
        true,
      ),
    ).toBe("failed");
    expect(
      acknowledgeBlock(
        { state: "none", acknowledge: { allowed: false, refusal: "no_warning" } },
        true,
      ),
    ).toBe("noWarning");
  });
});

describe("a bulk acknowledgement", () => {
  it("sends the selected rows with an open warning only", () => {
    const items = [
      summary(),
      summary({
        target: { kind: "machine", id: "m-1", subjectKind: "server", name: "fs", detail: null },
      }),
      summary({
        target: { kind: "object", id: "o-2", subjectKind: "mailbox", name: "Ben", detail: null },
        state: "acknowledged",
      }),
    ];
    const selected = new Set(["object:o-1", "machine:m-1", "object:o-2"]);
    expect(acknowledgeableRefs(items, selected)).toEqual([
      { kind: "object", id: "o-1" },
      { kind: "machine", id: "m-1" },
    ]);
    expect(acknowledgeableRefs(items, new Set())).toEqual([]);
    expect(refKey({ kind: "machine", id: "m-1" })).toBe("machine:m-1");
  });
});

describe("tones and words", () => {
  it("keeps a failure red and an acknowledged warning quiet", () => {
    expect(stateTone("failed")).toBe("destructive");
    expect(stateTone("open")).toBe("warning");
    expect(stateTone("acknowledged")).toBe("muted");
    expect(outcomeTone("partial")).toBe("warning");
    expect(outcomeTone("failed")).toBe("destructive");
    expect(outcomeTone("succeeded")).toBe("neutral");
  });

  it("names an item and its folder, falling back to the reference", () => {
    const location = { area: "mail" as const, folder: "Inbox", name: "Report", itemId: "ab" };
    expect(itemTitle(location, "ref")).toBe("Report");
    expect(itemTitle({ ...location, name: " " }, "ref")).toBe("ref");
    expect(itemFolder(location)).toBe("Inbox");
    expect(itemFolder({ ...location, folder: null })).toBeNull();
  });

  it("counts an acknowledgement only while nothing superseded it", () => {
    const ack = {
      acknowledgedAt: "2026-10-07T10:00:00Z",
      acknowledgedBy: "admin@contoso.example",
      note: null,
      causes: [],
      runId: null,
      superseded: false,
    };
    expect(acknowledgementApplies(summary({ acknowledgement: ack }))).toBe(true);
    expect(acknowledgementApplies(summary({ acknowledgement: { ...ack, superseded: true } }))).toBe(
      false,
    );
    expect(acknowledgementApplies(summary())).toBe(false);
  });

  it("reads the tab from the address", () => {
    expect(parseWarningsSearch({ state: "acknowledged" })).toEqual({ state: "acknowledged" });
    expect(parseWarningsSearch({ state: "x" })).toEqual({ state: "open" });
  });
});
