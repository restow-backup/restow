import { describe, expect, it } from "vitest";
import { contentDisposition } from "./headers.js";
import {
  createRestoreSchema,
  isReplaceModeAllowedFor,
  normalizeStoredRestoreMode,
} from "./schemas.js";

describe("createRestoreSchema", () => {
  const base = {
    snapshotId: "3f5c9c2e-7d0f-4c2e-9a4b-1d2f3e4a5b6c",
    selection: [{ path: "Inbox", kind: "folder" }],
    target: { type: "download" },
  };

  it("accepts a minimal download request and defaults the mode", () => {
    const parsed = createRestoreSchema.parse(base);
    expect(parsed.mode).toBe("rename");
    expect(parsed.reason).toBeUndefined();
    expect(parsed.options).toBeUndefined();
  });

  it("requires an account for restores into another account", () => {
    expect(createRestoreSchema.safeParse({ ...base, target: { type: "other" } }).success).toBe(
      false,
    );
    expect(
      createRestoreSchema.safeParse({ ...base, target: { type: "other", accountId: "  " } })
        .success,
    ).toBe(false);
    const parsed = createRestoreSchema.parse({
      ...base,
      target: { type: "other", accountId: " bob@example.com " },
    });
    expect(parsed.target).toEqual({ type: "other", accountId: "bob@example.com" });
  });

  it("normalizes selection paths and rejects an empty or oversized selection", () => {
    const parsed = createRestoreSchema.parse({ ...base, selection: [{ path: "/Inbox/" }] });
    expect(parsed.selection).toEqual([{ path: "Inbox" }]);
    expect(createRestoreSchema.safeParse({ ...base, selection: [] }).success).toBe(false);
    const tooMany = Array.from({ length: 5001 }, (_, index) => ({ path: `f${index}` }));
    expect(createRestoreSchema.safeParse({ ...base, selection: tooMany }).success).toBe(false);
  });

  it("accepts item ids and trims the reason, rejecting a token reason", () => {
    const parsed = createRestoreSchema.parse({
      ...base,
      selection: [{ itemId: "AAMk" }],
      reason: "  ticket 4711  ",
    });
    expect(parsed.selection).toEqual([{ itemId: "AAMk" }]);
    expect(parsed.reason).toBe("ticket 4711");
    expect(createRestoreSchema.safeParse({ ...base, reason: " x " }).success).toBe(false);
  });

  it("rejects unknown modes and targets", () => {
    expect(createRestoreSchema.safeParse({ ...base, mode: "merge" }).success).toBe(false);
    expect(createRestoreSchema.safeParse({ ...base, target: { type: "elsewhere" } }).success).toBe(
      false,
    );
  });

  it("accepts presentation options but no path separators in the folder name", () => {
    const parsed = createRestoreSchema.parse({
      ...base,
      options: { restoreFolderName: " Wiederhergestellt 2026-09-23 ", archiveName: "anna.zip" },
    });
    expect(parsed.options).toEqual({
      restoreFolderName: "Wiederhergestellt 2026-09-23",
      archiveName: "anna.zip",
    });
    expect(
      createRestoreSchema.safeParse({ ...base, options: { restoreFolderName: "a/b" } }).success,
    ).toBe(false);
    expect(
      createRestoreSchema.safeParse({ ...base, options: { restoreFolderName: "a\u0007b" } })
        .success,
    ).toBe(false);
  });
});

describe("isReplaceModeAllowedFor", () => {
  it("refuses 'replace' into any account, original or another one", () => {
    expect(isReplaceModeAllowedFor("replace", "original")).toBe(false);
    expect(isReplaceModeAllowedFor("replace", "other")).toBe(false);
  });

  it("lets 'replace' through for a download target, since mode has no effect there", () => {
    expect(isReplaceModeAllowedFor("replace", "download")).toBe(true);
  });

  it("never refuses 'rename' or 'skip', for any target", () => {
    for (const mode of ["rename", "skip"] as const) {
      for (const targetType of ["original", "other", "download"] as const) {
        expect(isReplaceModeAllowedFor(mode, targetType)).toBe(true);
      }
    }
  });
});

describe("normalizeStoredRestoreMode", () => {
  it("stores a download's 'replace' as 'rename': nothing was ever replaced", () => {
    expect(normalizeStoredRestoreMode("replace", "download")).toBe("rename");
  });

  it("leaves every other combination unchanged", () => {
    for (const mode of ["rename", "skip"] as const) {
      for (const targetType of ["original", "other", "download"] as const) {
        expect(normalizeStoredRestoreMode(mode, targetType)).toBe(mode);
      }
    }
    // "replace" into an account is refused before storage
    // (isReplaceModeAllowedFor); nothing normalizes it.
    expect(normalizeStoredRestoreMode("replace", "original")).toBe("replace");
  });
});

describe("contentDisposition", () => {
  it("offers an ASCII fallback and a UTF-8 file name", () => {
    expect(contentDisposition("Wiederherstellung Müller.zip")).toBe(
      `attachment; filename="Wiederherstellung M_ller.zip"; filename*=UTF-8''Wiederherstellung%20M%C3%BCller.zip`,
    );
  });

  it("never lets a quote or backslash break out of the header value", () => {
    expect(contentDisposition('a"b\\c.zip')).toContain('filename="a_b_c.zip"');
  });
});
