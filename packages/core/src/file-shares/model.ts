/**
 * The fixed vocabulary of file share backup (docs/FILESHARES.md 4, 7): where a share's restic
 * repository lives, the paths every restore point has, the installation settings with their
 * bounds, the job settings' defaults and the exclude list a job turns into. Pure, no I/O.
 */
import type { RetentionRules } from "../endpoints/retention-policy.js";

/** The storage prefix of a share's restic repository (on the tenant's primary target). */
export function fileShareRepositoryPrefix(shareId: string): string {
  return `file-shares/${shareId}/`;
}

/** The key of a share's restic cache folder on the server (`RepositoryAccess.repositoryKey`). */
export function fileShareRepositoryKey(shareId: string): string {
  return `file-share-${shareId}`;
}

/** Where the share root is in every restore point (4.4): restic records the runner's mount. */
export const SHARE_SNAPSHOT_ROOT = "/share";
/** Where the runner's metadata (sidecar, manifest) is in every restore point. */
export const SHARE_SNAPSHOT_META = "/.restow";
/** The permissions sidecar and the manifest in the metadata folder (4.6). */
export const SHARE_SIDECAR_FILE = "acls.jsonl.gz";
export const SHARE_MANIFEST_FILE = "manifest.json";

/** The restic host and tag of every share restore point (4.4). */
export const SHARE_SNAPSHOT_HOST = "restow-share";

/** Sample files the runner hashes per backup for the restore check (4.3). */
export const SHARE_SAMPLES_PER_RUN = 20;
/** Every this many runs the runner reads all permissions again instead of reusing them (4.3). */
export const SHARE_REREAD_PERMISSIONS_EVERY = 30;

/** Retention of a share job without its own rules: 30 daily, 12 weekly, 12 monthly (7.5). */
export const DEFAULT_SHARE_RETENTION: RetentionRules = {
  keepDaily: 30,
  keepWeekly: 12,
  keepMonthly: 12,
};

/**
 * "Skip temporary and system files" (7.5): Office lock files, temporary files, thumbnails,
 * desktop.ini and Finder files, recycle bins, and the snapshot folders of NetApp, Synology and
 * QNAP, which would otherwise back up every server-side snapshot again.
 */
export const SHARE_SYSTEM_FILE_PATTERNS: readonly string[] = [
  "~$*",
  "*.tmp",
  "Thumbs.db",
  "desktop.ini",
  ".DS_Store",
  "*.lck",
  "$RECYCLE.BIN",
  "System Volume Information",
  ".snapshot",
  "~snapshot",
  "#recycle",
  "#snapshot",
  "@eaDir",
  ".@__thumb",
];

/** The installation settings of 7.4 with every default filled in and every bound applied. */
export interface FileShareSettings {
  maxConcurrentRunners: number;
  runnerMemoryMiB: number;
  goMemLimitPercent: number;
  maxRunHours: number;
  defaultReadConcurrency: number;
  tenantsMayUsePrivateNetworks: boolean;
  /** 0 = none. */
  defaultShareQuotaGib: number;
  /** 0 = none. */
  tenantShareQuotaGib: number;
  tenantShareQuotaGibByTenant: Readonly<Record<string, number>>;
  catalog: { enabled: boolean; maxEntriesPerShare: number };
}

export const FILE_SHARE_SETTINGS_DEFAULTS: FileShareSettings = {
  maxConcurrentRunners: 2,
  runnerMemoryMiB: 2048,
  goMemLimitPercent: 80,
  maxRunHours: 72,
  defaultReadConcurrency: 4,
  tenantsMayUsePrivateNetworks: false,
  defaultShareQuotaGib: 0,
  tenantShareQuotaGib: 0,
  tenantShareQuotaGibByTenant: {},
  catalog: { enabled: true, maxEntriesPerShare: 20_000_000 },
};

/** The largest budget (GiB) a share or a tenant can have (1 PiB). */
export const MAX_SHARE_QUOTA_GIB = 1024 * 1024;

/** The mounter's own caps (3.8), which win over the settings. */
export interface MounterRunnerCaps {
  /** RESTOW_MOUNTER_MAX_RUNNERS (default 8). */
  maxRunners: number;
  /** RESTOW_MOUNTER_RUNNER_MAX_MEMORY_MIB (default 16384). */
  maxMemoryMiB: number;
}

export const DEFAULT_MOUNTER_RUNNER_CAPS: MounterRunnerCaps = {
  maxRunners: 8,
  maxMemoryMiB: 16384,
};

function intIn(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** The stored settings (`settings.file_share_settings`) with defaults and bounds applied. */
export function fileShareSettingsOf(
  raw: Record<string, unknown> | null | undefined,
  caps: MounterRunnerCaps = DEFAULT_MOUNTER_RUNNER_CAPS,
): FileShareSettings {
  const value = raw ?? {};
  const d = FILE_SHARE_SETTINGS_DEFAULTS;
  const catalog = (value.catalog ?? {}) as Record<string, unknown>;
  const byTenant: Record<string, number> = {};
  const rawByTenant = value.tenantShareQuotaGibByTenant;
  if (rawByTenant && typeof rawByTenant === "object") {
    for (const [tenantId, gib] of Object.entries(rawByTenant as Record<string, unknown>)) {
      if (typeof gib === "number" && Number.isFinite(gib) && gib >= 0) {
        byTenant[tenantId] = Math.min(MAX_SHARE_QUOTA_GIB, Math.round(gib));
      }
    }
  }
  return {
    maxConcurrentRunners: intIn(
      value.maxConcurrentRunners,
      1,
      Math.max(1, caps.maxRunners),
      Math.min(d.maxConcurrentRunners, Math.max(1, caps.maxRunners)),
    ),
    runnerMemoryMiB: intIn(
      value.runnerMemoryMiB,
      512,
      Math.max(512, caps.maxMemoryMiB),
      Math.min(d.runnerMemoryMiB, Math.max(512, caps.maxMemoryMiB)),
    ),
    goMemLimitPercent: intIn(value.goMemLimitPercent, 50, 90, d.goMemLimitPercent),
    maxRunHours: intIn(value.maxRunHours, 1, 336, d.maxRunHours),
    defaultReadConcurrency: intIn(value.defaultReadConcurrency, 1, 16, d.defaultReadConcurrency),
    tenantsMayUsePrivateNetworks: value.tenantsMayUsePrivateNetworks === true,
    defaultShareQuotaGib: intIn(value.defaultShareQuotaGib, 0, MAX_SHARE_QUOTA_GIB, 0),
    tenantShareQuotaGib: intIn(value.tenantShareQuotaGib, 0, MAX_SHARE_QUOTA_GIB, 0),
    tenantShareQuotaGibByTenant: byTenant,
    catalog: {
      enabled: catalog.enabled !== false,
      maxEntriesPerShare: intIn(
        catalog.maxEntriesPerShare,
        1000,
        1_000_000_000,
        d.catalog.maxEntriesPerShare,
      ),
    },
  };
}

/** GOMEMLIMIT of a runner in MiB: the percentage of its memory limit. */
export function goMemLimitMiB(
  settings: Pick<FileShareSettings, "runnerMemoryMiB" | "goMemLimitPercent">,
): number {
  return Math.floor((settings.runnerMemoryMiB * settings.goMemLimitPercent) / 100);
}

/** The mounter's caps from its environment variables, as the worker sees them (or the defaults). */
export function mounterRunnerCapsFromEnv(
  env: Record<string, string | undefined> = process.env,
): MounterRunnerCaps {
  const num = (value: string | undefined, fallback: number) => {
    const parsed = Number(value?.trim());
    return value && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  };
  return {
    maxRunners: num(env.RESTOW_MOUNTER_MAX_RUNNERS, DEFAULT_MOUNTER_RUNNER_CAPS.maxRunners),
    maxMemoryMiB: num(
      env.RESTOW_MOUNTER_RUNNER_MAX_MEMORY_MIB,
      DEFAULT_MOUNTER_RUNNER_CAPS.maxMemoryMiB,
    ),
  };
}

/** A share job's settings (`BackupJobShareSettings`, 7.5) as the runner session needs them. */
export interface ShareJobSettingsInput {
  excludes?: readonly string[];
  presets?: { systemFiles?: boolean };
  fileTypes?: { exclude: readonly string[] };
  excludeLargerThanGib?: number | null;
  readConcurrency?: number;
  skipOffline?: boolean;
}

const EXTENSION = /^[A-Za-z0-9][A-Za-z0-9_+-]{0,31}$/;

/**
 * The exclude patterns of a share job (7.5): its own lines, the preset list (on unless switched
 * off) and one `*.<ext>` per skipped file type, without duplicates and blank lines. The runner
 * writes them to restic's exclude file (escaping a leading `#`).
 */
export function shareExcludePatterns(settings: ShareJobSettingsInput | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (pattern: string) => {
    const trimmed = pattern.replace(/[\r\n]+/g, "").trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  };
  for (const line of settings?.excludes ?? []) {
    add(line);
  }
  if (settings?.presets?.systemFiles !== false) {
    for (const pattern of SHARE_SYSTEM_FILE_PATTERNS) {
      add(pattern);
    }
  }
  for (const ext of settings?.fileTypes?.exclude ?? []) {
    const clean = ext.replace(/^\*?\./, "").trim();
    if (EXTENSION.test(clean)) {
      add(`*.${clean}`);
    }
  }
  return out;
}

/** The include folders of a member, cleaned: relative, no empty segments, no duplicates. */
export function shareIncludes(includes: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of includes ?? []) {
    const clean = raw
      .split("/")
      .filter((segment) => segment.length > 0)
      .join("/");
    if (clean && !out.includes(clean)) {
      out.push(clean);
    }
  }
  return out;
}

/** A path relative to the share root as it is in a restore point (`/share/<rel>`). */
export function snapshotPathOf(relative: string): string {
  const clean = relative.replace(/^\/+|\/+$/g, "");
  return clean ? `${SHARE_SNAPSHOT_ROOT}/${clean}` : SHARE_SNAPSHOT_ROOT;
}

/**
 * The path relative to the share root of a path in a restore point, or null for a path outside
 * the share (the runner's `/.restow` folder, anything else).
 */
export function shareRelativePath(snapshotPath: string, root = SHARE_SNAPSHOT_ROOT): string | null {
  const base = root.replace(/\/+$/, "");
  if (snapshotPath === base) {
    return "";
  }
  return snapshotPath.startsWith(`${base}/`) ? snapshotPath.slice(base.length + 1) : null;
}
