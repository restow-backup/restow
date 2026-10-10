/**
 * What a runner gets when it asks for its session (`GET /internal/file-shares/v1/session`,
 * docs/FILESHARES.md 5.2), built from the run, its shares and its job (pure). The shape is what
 * restow-share reads (agent/internal/share/types.go `Session`); the run credential itself never
 * appears here, the repository password does (the runner needs it for restic).
 */
import { randomBytes } from "node:crypto";
import { effectiveBandwidthKbps } from "../backup-jobs/bandwidth.js";
import { GIB } from "../endpoints/quota.js";
import { hashSecret } from "../endpoints/tokens.js";
import {
  type FileShareSettings,
  SHARE_REREAD_PERMISSIONS_EVERY,
  SHARE_SAMPLES_PER_RUN,
  type ShareJobSettingsInput,
  shareExcludePatterns,
  shareIncludes,
} from "./model.js";

/** A new run credential (5.1): 32 random bytes, base64url (43 characters), and its SHA-256. */
export function issueRunToken(random: (size: number) => Buffer = randomBytes): {
  token: string;
  hash: string;
} {
  const token = random(32).toString("base64url");
  return { token, hash: hashSecret(token) };
}

export interface ShareSessionBackup {
  includes: string[];
  excludes: string[];
  caseInsensitive: boolean;
  excludeLargerThanBytes: number;
  limitUploadKiB: number;
  readConcurrency: number;
  parentSnapshotId: string;
  previous: { snapshotId: string; fileCount: number } | null;
  allowEmptyOnce: boolean;
  permissions: "auto" | "off";
  rereadPermissions: boolean;
  skipOffline: boolean;
  samples: number;
}

export interface ShareSessionRestore {
  snapshotId: string;
  paths: string[];
  destination: "original" | "new_folder" | "folder";
  folder: string;
  conflict: "overwrite" | "keep_both" | "skip" | "";
  restorePermissions: boolean;
  verify: boolean;
  targetShareId: string;
  copy?: {
    jobId: string;
    sourceShareId: string;
    mode: "overwrite" | "mirror";
    mirrorConfirmed: boolean;
    lastCopiedFileCount: number;
    force: boolean;
  };
}

export interface ShareSession {
  run: { id: string; kind: "backup" | "restore"; shareId: string; deadline: string };
  expect: { protocol: "smb" | "nfs"; readOnly: boolean };
  repository: { url: string; repositoryPassword: string };
  backup?: ShareSessionBackup;
  restore?: ShareSessionRestore;
}

/** The restic REST URL of a share's repository as a runner reaches the api (5.2). */
export function shareRepositoryUrl(apiBaseUrl: string, repositoryShareId: string): string {
  return `rest:${apiBaseUrl.replace(/\/+$/, "")}/internal/file-shares/restic/${repositoryShareId}/`;
}

export interface BackupSessionInput {
  /** The job's settings merged with the member's overrides (7.5). */
  settings: ShareJobSettingsInput & {
    bandwidthKbps?: number | null;
    bandwidthWindows?: { days: number[]; from: string; to: string; kbps: number }[];
  };
  includes: readonly string[] | null | undefined;
  installation: Pick<FileShareSettings, "defaultReadConcurrency">;
  share: {
    protocol: "smb" | "nfs";
    permissionsMode: "auto" | "off";
    rereadPermissions: boolean;
    allowEmptyOnce: boolean;
  };
  /** The newest good restore point: the parent and the empty guard's reference. */
  previous: { resticSnapshotId: string; files: number } | null;
  /** Backups of this share so far (every 30th reads all permissions again, 4.3). */
  backupsSoFar: number;
  /** The zone bandwidth windows are read in. */
  timeZone: string;
  now: Date;
  /** A manual run's "back up the empty share once". */
  allowEmptyOnce?: boolean;
}

/** The backup half of a session. */
export function backupSession(input: BackupSessionInput): ShareSessionBackup {
  const settings = input.settings;
  const kbps = effectiveBandwidthKbps(
    settings.bandwidthKbps ?? null,
    settings.bandwidthWindows,
    input.timeZone,
    input.now,
  );
  const larger = settings.excludeLargerThanGib;
  const readConcurrency =
    typeof settings.readConcurrency === "number" && settings.readConcurrency >= 1
      ? Math.min(16, Math.round(settings.readConcurrency))
      : input.installation.defaultReadConcurrency;
  return {
    includes: shareIncludes(input.includes),
    excludes: shareExcludePatterns(settings),
    caseInsensitive: input.share.protocol === "smb",
    excludeLargerThanBytes: typeof larger === "number" && larger > 0 ? Math.round(larger * GIB) : 0,
    // kbit/s to KiB/s, as restic's --limit-upload wants it.
    limitUploadKiB: kbps === null ? 0 : Math.max(1, Math.floor((kbps * 1000) / 8 / 1024)),
    readConcurrency,
    parentSnapshotId: input.previous?.resticSnapshotId ?? "",
    previous: input.previous
      ? { snapshotId: input.previous.resticSnapshotId, fileCount: input.previous.files }
      : null,
    allowEmptyOnce: input.share.allowEmptyOnce || input.allowEmptyOnce === true,
    permissions: input.share.permissionsMode,
    rereadPermissions:
      input.share.rereadPermissions ||
      (input.backupsSoFar > 0 && input.backupsSoFar % SHARE_REREAD_PERMISSIONS_EVERY === 0),
    skipOffline: settings.skipOffline !== false,
    samples: SHARE_SAMPLES_PER_RUN,
  };
}
