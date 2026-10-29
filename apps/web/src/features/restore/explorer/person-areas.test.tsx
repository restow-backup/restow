import { beforeAll, describe, expect, it } from "vitest";

import { render } from "@/components/kit/test-utils";
import type { SnapshotObject } from "@/features/restore/api";
import { i18n } from "@/i18n";

import { PersonAreas } from "./person-areas";

/**
 * The areas of a person's backups name why an orphaned mailbox is not backed up: removed from
 * its source (a warning), or its account disabled or unlicensed (neutral: it still exists and
 * its backups resume with it).
 */

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function mailbox(over: Partial<SnapshotObject> = {}): SnapshotObject {
  return {
    id: "m1",
    kind: "mailbox",
    externalId: "user-1",
    displayName: "Alice",
    status: "active",
    sourceKind: "m365",
    ownerEmail: "alice@contoso.example",
    own: false,
    snapshotCount: 3,
    latestSnapshotId: "s3",
    latestSnapshotAt: "2026-09-20T10:00:00.000Z",
    readiness: "green",
    ...over,
  };
}

function areas(object: SnapshotObject): string {
  return render(
    <PersonAreas
      person={{
        key: "user:u1",
        name: "Alice",
        address: "alice@contoso.example",
        own: false,
        accountDeleted: false,
        objects: [object],
      }}
      objectId={null}
      path=""
      snapshotId={null}
      restorePointsKnown={false}
      onArea={() => {}}
      onOpenFolder={() => {}}
    />,
  );
}

describe("PersonAreas", () => {
  it("names a disabled or unlicensed account as not backed up, not as removed", () => {
    const disabled = areas(mailbox({ status: "orphaned", statusReason: "account_disabled" }));
    expect(disabled).toContain("Not backed up: account disabled");
    expect(disabled).not.toContain(">Removed<");
    const unlicensed = areas(mailbox({ status: "orphaned", statusReason: "no_license" }));
    expect(unlicensed).toContain("Not backed up: no licence");
    expect(unlicensed).not.toContain(">Removed<");
  });

  it("keeps the warning for a mailbox removed from its source", () => {
    const removed = areas(mailbox({ status: "orphaned" }));
    expect(removed).toContain(">Removed<");
    expect(removed).not.toContain("Not backed up");
  });
});
