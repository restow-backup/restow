import { describe, expect, it } from "vitest";
import { hashSecret } from "../endpoints/tokens.js";
import { SHARE_SYSTEM_FILE_PATTERNS } from "./model.js";
import { backupSession, issueRunToken, shareRepositoryUrl } from "./session.js";

const base = {
  settings: {},
  includes: [] as string[],
  installation: { defaultReadConcurrency: 4 },
  share: {
    protocol: "smb" as const,
    permissionsMode: "auto" as const,
    rereadPermissions: false,
    allowEmptyOnce: false,
  },
  previous: null,
  backupsSoFar: 0,
  timeZone: "UTC",
  now: new Date("2026-10-10T22:00:00Z"),
};

describe("runner session (5.2)", () => {
  it("issues a 43-character credential and keeps only its hash", () => {
    const { token, hash } = issueRunToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(hashSecret(token));
    expect(issueRunToken().token).not.toBe(token);
  });

  it("points the runner at the api's restic route", () => {
    expect(shareRepositoryUrl("http://api:3000/", "abc")).toBe(
      "rest:http://api:3000/internal/file-shares/restic/abc/",
    );
  });

  it("fills the backup half with the defaults", () => {
    expect(backupSession(base)).toEqual({
      includes: [],
      excludes: [...SHARE_SYSTEM_FILE_PATTERNS],
      caseInsensitive: true,
      excludeLargerThanBytes: 0,
      limitUploadKiB: 0,
      readConcurrency: 4,
      parentSnapshotId: "",
      previous: null,
      allowEmptyOnce: false,
      permissions: "auto",
      rereadPermissions: false,
      skipOffline: true,
      samples: 20,
    });
  });

  it("takes the job's settings, the parent and the bandwidth window of the moment", () => {
    const session = backupSession({
      ...base,
      share: { ...base.share, protocol: "nfs", permissionsMode: "off" },
      includes: ["Finance/", "HR"],
      settings: {
        excludes: ["*.bak"],
        presets: { systemFiles: false },
        excludeLargerThanGib: 2,
        readConcurrency: 8,
        skipOffline: false,
        bandwidthKbps: 8000,
        bandwidthWindows: [
          { days: [1, 2, 3, 4, 5, 6, 7], from: "21:00", to: "23:00", kbps: 80_000 },
        ],
      },
      previous: { resticSnapshotId: "abcdef12", files: 1000 },
      backupsSoFar: 30,
      allowEmptyOnce: true,
    });
    expect(session).toMatchObject({
      includes: ["Finance", "HR"],
      excludes: ["*.bak"],
      caseInsensitive: false,
      excludeLargerThanBytes: 2 * 1024 ** 3,
      limitUploadKiB: Math.floor((80_000 * 1000) / 8 / 1024),
      readConcurrency: 8,
      parentSnapshotId: "abcdef12",
      previous: { snapshotId: "abcdef12", fileCount: 1000 },
      allowEmptyOnce: true,
      permissions: "off",
      rereadPermissions: true,
      skipOffline: false,
    });
  });
});
