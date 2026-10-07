import { describe, expect, it } from "vitest";

import { ApiError, NetworkError } from "@/lib/api";

import {
  type RestoreFormContext,
  archiveNameFor,
  buildRestoreRequest,
  defaultTarget,
  hasErrors,
  initialFormState,
  modeApplies,
  originalTargetDescriptionKey,
  restoreErrorOf,
  restoreModesFor,
  restoreStamp,
  targetAvailable,
  usesRestoreFolder,
  validateRestoreForm,
} from "./request";
import { EMPTY_SELECTION, selectionOf } from "./selection";

describe("originalTargetDescriptionKey", () => {
  it("says that mail kept side by side goes into a new folder, not where it came from", () => {
    expect(originalTargetDescriptionKey("mailbox", "rename")).toBe(
      "dialog.target.originalDescriptionFolder",
    );
    expect(originalTargetDescriptionKey("imap", "rename")).toBe(
      "dialog.target.originalDescriptionFolder",
    );
  });

  it("keeps the plain promise where items really go back where they came from", () => {
    expect(originalTargetDescriptionKey("mailbox", "skip")).toBe(
      "dialog.target.originalDescription",
    );
    // OneDrive renames a file next to the existing one instead of using a new folder.
    expect(originalTargetDescriptionKey("onedrive", "rename")).toBe(
      "dialog.target.originalDescription",
    );
  });
});

const admin: RestoreFormContext = {
  canRestoreElsewhere: true,
  reasonRequired: true,
  originalAvailable: true,
};
const owner: RestoreFormContext = {
  canRestoreElsewhere: false,
  reasonRequired: false,
  originalAvailable: true,
};
const orphaned: RestoreFormContext = { ...admin, originalAvailable: false };

describe("targets", () => {
  it("opens other accounts to admins only and the original only while it exists", () => {
    expect(targetAvailable("other", owner)).toBe(false);
    expect(targetAvailable("other", admin)).toBe(true);
    expect(targetAvailable("original", orphaned)).toBe(false);
    expect(targetAvailable("download", owner)).toBe(true);
  });

  it("offers only the download in the public demo, and opens with it", () => {
    const demo: RestoreFormContext = { ...admin, downloadOnly: true };
    expect(targetAvailable("original", demo)).toBe(false);
    expect(targetAvailable("other", demo)).toBe(false);
    expect(targetAvailable("download", demo)).toBe(true);
    expect(defaultTarget(demo)).toBe("download");
    expect(initialFormState(demo, "original").target).toBe("download");
  });

  it("defaults to the original location, else to a download", () => {
    expect(defaultTarget(owner)).toBe("original");
    expect(defaultTarget(orphaned)).toBe("download");
    expect(initialFormState(owner, "other").target).toBe("original");
    expect(initialFormState(admin, "other").target).toBe("other");
    expect(initialFormState(owner, "download")).toEqual({
      target: "download",
      accountId: "",
      mode: "rename",
      reason: "",
    });
  });
});

describe("validateRestoreForm", () => {
  it("requires an account for another account and a reason for admin restores", () => {
    const errors = validateRestoreForm(
      { target: "other", accountId: "  ", mode: "rename", reason: " x " },
      admin,
    );
    expect(errors).toEqual({
      accountId: "restore:dialog.errors.accountRequired",
      reason: "restore:dialog.errors.reasonRequired",
    });
    expect(hasErrors(errors)).toBe(true);
  });

  it("accepts a complete form and flags an unavailable target", () => {
    expect(
      validateRestoreForm(
        { target: "other", accountId: "bob@example.com", mode: "skip", reason: "Ticket 4711" },
        admin,
      ),
    ).toEqual({});
    expect(
      validateRestoreForm({ target: "other", accountId: "x", mode: "skip", reason: "" }, owner),
    ).toEqual({ target: "restore:dialog.errors.targetUnavailable" });
  });
});

describe("modes and options", () => {
  it("applies collision handling only when writing into an account", () => {
    expect(modeApplies("download")).toBe(false);
    expect(modeApplies("original")).toBe(true);
  });

  it("uses a restore folder for mail-like data in keep-both mode only", () => {
    const state = {
      target: "original" as const,
      accountId: "",
      mode: "rename" as const,
      reason: "",
    };
    expect(usesRestoreFolder("mailbox", state)).toBe(true);
    expect(usesRestoreFolder("imap", state)).toBe(true);
    expect(usesRestoreFolder("onedrive", state)).toBe(false);
    expect(usesRestoreFolder("mailbox", { ...state, mode: "skip" })).toBe(false);
    expect(usesRestoreFolder("mailbox", { ...state, target: "download" })).toBe(false);
  });

  it("never offers 'replace', for any kind of account", () => {
    expect(restoreModesFor("mailbox")).toEqual(["rename", "skip"]);
    expect(restoreModesFor("imap")).toEqual(["rename", "skip"]);
    expect(restoreModesFor("onedrive")).toEqual(["rename", "skip"]);
  });

  it("formats stamps and archive names safely", () => {
    const now = new Date(2026, 8, 23, 14, 5);
    expect(restoreStamp(now)).toBe("2026-09-23 1405");
    expect(archiveNameFor("Jürgen Müller (Vertrieb)", now)).toBe(
      "jurgen-muller-vertrieb-2026-09-23-1405.zip",
    );
    expect(archiveNameFor("???", now)).toBe("restore-2026-09-23-1405.zip");
  });
});

describe("buildRestoreRequest", () => {
  const now = new Date(2026, 8, 23, 14, 5);
  const selection = selectionOf({
    path: "mail/Inbox",
    kind: "folder",
    itemId: null,
    subject: null,
    size: 0,
  });
  const input = {
    snapshotId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    objectKind: "mailbox" as const,
    objectLabel: "Anna",
    scope: { kind: "selection" as const, selection },
    context: admin,
    restoreFolderName: "Wiederhergestellt 2026-09-23 1405",
    now,
  };

  it("restores a selection into another account with a reason and a restore folder", () => {
    expect(
      buildRestoreRequest({
        ...input,
        state: {
          target: "other",
          accountId: " bob@example.com ",
          mode: "rename",
          reason: " Ticket ",
        },
      }),
    ).toEqual({
      snapshotId: input.snapshotId,
      selection: [{ path: "mail/Inbox", kind: "folder" }],
      target: { type: "other", accountId: "bob@example.com" },
      mode: "rename",
      reason: "Ticket",
      options: { restoreFolderName: "Wiederhergestellt 2026-09-23 1405" },
    });
  });

  it("downloads everything with an archive name and no reason for the owner", () => {
    expect(
      buildRestoreRequest({
        ...input,
        context: owner,
        scope: { kind: "everything" },
        state: { target: "download", accountId: "", mode: "replace", reason: "ignored" },
      }),
    ).toEqual({
      snapshotId: input.snapshotId,
      selection: [{ path: "", kind: "folder" }],
      target: { type: "download" },
      mode: "rename",
      options: { archiveName: "anna-2026-09-23-1405.zip" },
    });
  });

  it("never sends 'replace' for a mailbox, even from a stale form state", () => {
    const request = buildRestoreRequest({
      ...input,
      objectKind: "mailbox",
      context: owner,
      state: { target: "original", accountId: "", mode: "replace", reason: "" },
    });
    expect(request.mode).toBe("rename");
  });

  it("sends no options when none apply", () => {
    const request = buildRestoreRequest({
      ...input,
      scope: { kind: "selection", selection: EMPTY_SELECTION },
      state: { target: "original", accountId: "", mode: "skip", reason: "Ticket 1" },
    });
    expect(request).not.toHaveProperty("options");
    expect(request.mode).toBe("skip");
  });
});

describe("restoreErrorOf", () => {
  const problem = (status: number, type: string) =>
    new ApiError(status, { type, title: "t", status }, "failed");

  it("puts known problems next to their field or above the form", () => {
    expect(restoreErrorOf(problem(422, "urn:restow:problem:restore-reason-required"))).toEqual({
      field: "reason",
      key: "restore:dialog.errors.reasonRequired",
    });
    expect(restoreErrorOf(problem(422, "urn:restow:problem:restore-target-unknown")).field).toBe(
      "accountId",
    );
    expect(restoreErrorOf(problem(409, "urn:restow:problem:restore-original-gone"))).toEqual({
      field: null,
      key: "restore:dialog.errors.originalGone",
    });
  });

  it("explains a vanished snapshot and falls back to the common messages", () => {
    expect(restoreErrorOf(problem(404, "about:blank")).key).toBe(
      "restore:dialog.errors.snapshotGone",
    );
    expect(restoreErrorOf(problem(403, "about:blank")).key).toBe("common:errors.forbidden");
    expect(restoreErrorOf(new NetworkError(new Error("down"))).key).toBe("common:errors.network");
  });
});
