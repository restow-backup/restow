import { describe, expect, it } from "vitest";
import {
  createRestoreSchema,
  pickRestoreTargetKind,
  restoreOptionsSchema,
  storedRestoreOptions,
} from "./schemas.js";

describe("pickRestoreTargetKind", () => {
  it("prefers the Exchange mailbox when an address is both a mailbox and an IMAP account", () => {
    expect(pickRestoreTargetKind({ mailbox: true, imap: true })).toBe("mailbox");
    expect(pickRestoreTargetKind({ mailbox: true, imap: false })).toBe("mailbox");
    expect(pickRestoreTargetKind({ mailbox: false, imap: true })).toBe("imap");
  });

  it("is null for an address that is neither", () => {
    expect(pickRestoreTargetKind({ mailbox: false, imap: false })).toBeNull();
  });
});

describe("storedRestoreOptions", () => {
  it("stores nothing when there are neither options nor a target kind", () => {
    expect(storedRestoreOptions(undefined, null)).toBeUndefined();
  });

  it("keeps the request's own options untouched for ordinary restores", () => {
    expect(storedRestoreOptions({ restoreFolderName: "Wiederhergestellt" }, null)).toEqual({
      restoreFolderName: "Wiederhergestellt",
    });
  });

  it("adds the target kind of an imported mailbox next to the options", () => {
    expect(storedRestoreOptions({ archiveName: "x" }, "mailbox")).toEqual({
      archiveName: "x",
      targetKind: "mailbox",
    });
    expect(storedRestoreOptions(undefined, "imap")).toEqual({ targetKind: "imap" });
  });
});

describe("target kind in a request", () => {
  it("cannot be set by the client: the options schema drops it", () => {
    expect(
      restoreOptionsSchema.parse({ restoreFolderName: "Back", targetKind: "mailbox" }),
    ).toEqual({ restoreFolderName: "Back" });
    const parsed = createRestoreSchema.parse({
      snapshotId: "0f0e0d0c-0b0a-4908-8706-050403020100",
      selection: [{ path: "" }],
      target: { type: "other", accountId: "shared@contoso.test" },
      options: { targetKind: "imap" },
    });
    expect(parsed.options).toEqual({});
  });
});
