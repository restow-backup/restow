import { describe, expect, it } from "vitest";

import type { ReportEvent } from "@/features/reports/api";

import type { ProviderRecipient } from "./api";
import {
  draftsChanged,
  draftsFrom,
  isFloor,
  lockedEventsOf,
  newDraft,
  receives,
  setDelivery,
  toggleEntry,
  toRecipientInputs,
  validateDrafts,
} from "./presenters";

/**
 * Installation › Notifications as a draft: the owners and the mandatory recipients are the floor
 * and keep the critical events and failed deliveries on; `mandatory` goes to the server only from
 * an owner; the list refuses empty, invalid and repeated addresses before saving.
 */

const FLOOR: ReportEvent[] = ["backup.suspicious", "verify.red", "notification.delivery_failed"];

function recipient(over: Partial<ProviderRecipient> = {}): ProviderRecipient {
  return {
    id: "r-1",
    email: "owner@provider.example",
    name: null,
    kind: "owner",
    mandatory: false,
    userId: "u-1",
    events: ["backup.failed"],
    delivery: { error: "immediate", warning: "hourly", info: "daily" },
    language: null,
    lockedEvents: FLOOR,
    failure: null,
    ...over,
  };
}

const owner = recipient();
const member = recipient({
  id: "r-2",
  email: "ops@provider.example",
  name: "Ops",
  kind: "member",
  userId: null,
  events: [],
  delivery: { error: "immediate", warning: "immediate", info: "immediate" },
  lockedEvents: [],
});

describe("the floor", () => {
  it("is the owners and the recipients marked mandatory", () => {
    const [ownerDraft, memberDraft] = draftsFrom({ recipients: [owner, member] });
    expect(isFloor(ownerDraft as never)).toBe(true);
    expect(isFloor(memberDraft as never)).toBe(false);
    expect(isFloor({ kind: "member", mandatory: true })).toBe(true);
    expect(lockedEventsOf({ kind: "owner", mandatory: false }, FLOOR)).toEqual(FLOOR);
    expect(lockedEventsOf({ kind: "member", mandatory: false }, FLOOR)).toEqual([]);
  });

  it("keeps a locked cell on and ticks it whatever the column says", () => {
    const [ownerDraft] = draftsFrom({ recipients: [owner] });
    if (!ownerDraft) throw new Error("no draft");
    expect(receives(ownerDraft, "verify.red", FLOOR)).toBe(true);
    expect(toggleEntry(ownerDraft, "verify.red", false, FLOOR)).toBe(ownerDraft);
    const off = toggleEntry(ownerDraft, "backup.failed", false, FLOOR);
    expect(off.events).toEqual([]);
    const on = toggleEntry(off, "report.weekly", true, FLOOR);
    expect(on.events).toEqual(["report.weekly"]);
  });
});

describe("the delivery modes", () => {
  it("fills missing levels with immediate and changes one level", () => {
    const [draft] = draftsFrom({
      recipients: [recipient({ delivery: { error: "immediate" } as never })],
    });
    if (!draft) throw new Error("no draft");
    expect(draft.delivery).toEqual({ error: "immediate", warning: "immediate", info: "immediate" });
    expect(setDelivery(draft, "info", "daily").delivery.info).toBe("daily");
  });
});

describe("validateDrafts", () => {
  it("refuses an empty, an invalid and a repeated address", () => {
    const empty = newDraft();
    const invalid = { ...newDraft(), email: "not-an-address" };
    const repeated = { ...newDraft(), email: " OWNER@provider.example " };
    const [ownerDraft] = draftsFrom({ recipients: [owner] });
    if (!ownerDraft) throw new Error("no draft");
    expect(validateDrafts([ownerDraft, empty, invalid, repeated])).toEqual({
      [empty.key]: "providerRecipients.errors.required",
      [invalid.key]: "providerRecipients.errors.email",
      [repeated.key]: "providerRecipients.errors.duplicate",
    });
    expect(validateDrafts([ownerDraft])).toEqual({});
  });
});

describe("toRecipientInputs", () => {
  it("sends mandatory only from an owner and never for an owner's own row", () => {
    const drafts = draftsFrom({ recipients: [owner, { ...member, mandatory: true }] });
    const asOwner = toRecipientInputs(drafts, true);
    expect(asOwner[0]).not.toHaveProperty("mandatory");
    expect(asOwner[1]).toMatchObject({ id: "r-2", mandatory: true, name: "Ops" });
    const asAdministrator = toRecipientInputs(drafts, false);
    expect(asAdministrator[1]).not.toHaveProperty("mandatory");
  });

  it("sends a new row without id, lower-cased, with its delivery modes", () => {
    const draft = { ...newDraft(), email: " New@Provider.example ", name: " " };
    expect(toRecipientInputs([draft], true)).toEqual([
      {
        email: "new@provider.example",
        name: null,
        mandatory: false,
        events: [],
        delivery: { error: "immediate", warning: "immediate", info: "immediate" },
        language: null,
      },
    ]);
  });
});

describe("draftsChanged", () => {
  it("ignores the order of the events and the failure, and sees every real change", () => {
    const view = {
      recipients: [
        recipient({
          events: ["backup.failed", "report.daily"],
          failure: {
            since: "2026-11-05T10:00:00.000Z",
            reason: "recipient_rejected",
            detail: null,
          },
        }),
      ],
    };
    const drafts = draftsFrom(view);
    expect(draftsChanged(drafts, view)).toBe(false);
    const [first] = drafts;
    if (!first) throw new Error("no draft");
    expect(
      draftsChanged([{ ...first, events: ["report.daily", "backup.failed"], failure: null }], view),
    ).toBe(false);
    expect(draftsChanged([setDelivery(first, "error", "hourly")], view)).toBe(true);
    expect(draftsChanged([...drafts, newDraft()], view)).toBe(true);
  });
});
