import { describe, expect, it } from "vitest";
import {
  isNotBackedUpBackup,
  isServiceLimitedBackup,
  notBackedUpOf,
  notCountedFailureJobRaw,
} from "./service-limit.js";

const inactive = { code: "graph.mailbox_inactive", params: { reason: "account_disabled" } };

describe("backups that are no failure of the object", () => {
  it("tells a backup of a disabled or unlicensed account apart from a held-back one", () => {
    expect(isNotBackedUpBackup({ queue: "backup", status: "failed", failure: inactive })).toBe(
      true,
    );
    expect(isServiceLimitedBackup({ queue: "backup", status: "failed", failure: inactive })).toBe(
      false,
    );
    expect(notBackedUpOf({ queue: "backup", status: "failed", failure: inactive })).toBe(
      "account_disabled",
    );
    expect(
      notBackedUpOf({
        queue: "backup",
        status: "failed",
        failure: { code: "config.object_inactive", params: { reason: "no_license" } },
      }),
    ).toBe("no_license");
    // Only a backup reads this way, and only when it failed.
    expect(notBackedUpOf({ queue: "restore", status: "failed", failure: inactive })).toBeNull();
    expect(notBackedUpOf({ queue: "backup", status: "completed", failure: inactive })).toBeNull();
    expect(
      notBackedUpOf({
        queue: "backup",
        status: "failed",
        failure: { code: "graph.access_denied" },
      }),
    ).toBeNull();
  });

  it("reads a locked OneDrive or site as not backed up, never as failed", () => {
    const locked = { code: "graph.object_locked", params: { reason: "locked", httpStatus: 423 } };
    expect(isNotBackedUpBackup({ queue: "backup", status: "failed", failure: locked })).toBe(true);
    expect(isServiceLimitedBackup({ queue: "backup", status: "failed", failure: locked })).toBe(
      false,
    );
    expect(notBackedUpOf({ queue: "backup", status: "failed", failure: locked })).toBe("locked");
  });

  it("refuses anything but a table alias in raw SQL", () => {
    expect(() => notCountedFailureJobRaw("j; drop table jobs")).toThrow(/not a table alias/);
    expect(() => notCountedFailureJobRaw("j")).not.toThrow();
  });
});
