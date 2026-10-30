import type { User } from "@restow/db";
import { describe, expect, it } from "vitest";
import { NO_FACTS, type ObjectFacts } from "./facts.js";
import { toDirectoryUser, type UserObjectRow } from "./users.js";

/**
 * The per-user `recoveryReadiness` of GET /v1/users follows the tenant readiness (verify
 * summary.ts `toConfirm`): an object no longer backed up that waits for an admin's "Yes,
 * intended" keeps the user yellow, with or without a backup of its own.
 */
const NOW = new Date("2026-10-29T12:00:00Z");

const user = {
  id: "user-1",
  displayName: "Alice",
  email: "alice@contoso.example",
  upn: "alice@contoso.example",
  entraObjectId: "entra-1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
} as User;

function object(overrides: Partial<UserObjectRow> = {}): UserObjectRow {
  return {
    id: "drive-1",
    userId: user.id,
    kind: "onedrive",
    status: "orphaned",
    statusReason: "locked",
    inactiveSince: new Date("2026-10-28T03:00:00Z"),
    statusConfirmedAt: null,
    externalId: "b!drive-1",
    displayName: "Alice OneDrive",
    sourceKind: "m365",
    ...overrides,
  };
}

const greenFacts: ObjectFacts = {
  snapshot: {
    id: "snap-1",
    sequence: 1,
    completedAt: new Date("2026-10-27T03:00:00Z"),
    itemCount: 10,
    byteSize: 1024,
  },
  job: null,
  verify: {
    rating: "green",
    kind: "verify",
    checkedAt: new Date("2026-10-27T04:00:00Z"),
    reasons: [],
  },
};

const readinessOf = (row: UserObjectRow, facts: ObjectFacts) =>
  toDirectoryUser(user, [row], new Map([[row.id, facts]]), NOW).recoveryReadiness;

describe("v1 users: recoveryReadiness and the confirmation", () => {
  it("reads yellow for an unconfirmed locked OneDrive with a green check, green once confirmed", () => {
    expect(readinessOf(object(), greenFacts)).toBe("yellow");
    expect(
      readinessOf(object({ statusConfirmedAt: new Date("2026-10-29T10:00:00Z") }), greenFacts),
    ).toBe("green");
  });

  it("reads a shut-down IMAP account like any confirmed orphan: it is confirmed by the answer", () => {
    const shutDown = object({
      id: "imap-1",
      kind: "imap",
      sourceKind: "imap",
      statusReason: "login_refused",
      statusConfirmedAt: new Date("2026-10-29T10:00:00Z"),
    });
    expect(readinessOf(shutDown, greenFacts)).toBe("green");
    expect(readinessOf(shutDown, NO_FACTS)).toBeNull();
    const dto = toDirectoryUser(user, [shutDown], new Map([[shutDown.id, greenFacts]]), NOW);
    expect(dto.objects[0]).toMatchObject({ status: "orphaned", statusReason: "login_refused" });
  });

  it("reads yellow, not null, for an unconfirmed orphan without a backup", () => {
    const mailbox = object({ id: "mb-1", kind: "mailbox", statusReason: "no_license" });
    expect(readinessOf(mailbox, NO_FACTS)).toBe("yellow");
    expect(
      readinessOf({ ...mailbox, statusConfirmedAt: new Date("2026-10-29T10:00:00Z") }, NO_FACTS),
    ).toBeNull();
  });
});
