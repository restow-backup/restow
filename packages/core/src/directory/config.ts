/**
 * The directory's share of a source's `config` jsonb column.
 *
 * `sources` has no dedicated columns for the rules, overrides or sync state,
 * so they live under three keys of the config object:
 *
 *   config.scope       { mode, groupId?, exclude } — the rule core. Its shape is
 *                      the documented `SourceConfig.scope` of @restow/db, which
 *                      the sources feature writes as a whole on source edits.
 *   config.protection  what only the directory knows: the shared-mailbox
 *                      switch, the group's display name and per-object
 *                      overrides. Kept apart so a scope edit never drops them.
 *   config.directory   sync state: delta link, full-sync bookkeeping, the
 *                      shared/blocked set and the last run's outcome.
 *
 * Readers accept anything (the column is untrusted jsonb); writers return a
 * new object and leave every other key of the config untouched.
 */
import { parseFailureRecord } from "../failures/record.js";
import type { FailureRecord } from "../failures/types.js";
import type { DeltaMode } from "../graph/delta.js";
import type { PlanCounts } from "./plan.js";
import {
  type ProtectionOverride,
  type ProtectionOverrides,
  type ProtectionRules,
  normalizeOverrides,
  normalizeRules,
  rulesToRecord,
} from "./rules.js";
import type { SyncWarning } from "./sync.js";

export type SourceConfigRecord = Record<string, unknown>;

/** A full enumeration runs at least this often, so late-provisioned OneDrives show up. */
export const FULL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Warnings kept on the source for the UI; the count covers the rest. */
export const MAX_STORED_WARNINGS = 50;

/** Outcome of the most recent sync run, kept for the UI. */
export interface DirectoryLastRun {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly ok: boolean;
  readonly mode: DeltaMode | null;
  readonly counts: PlanCounts | null;
  /** The first {@link MAX_STORED_WARNINGS} warnings. */
  readonly warnings: readonly SyncWarning[];
  readonly warningCount: number;
  /** Failure reason when `ok` is false (never contains secrets). */
  readonly error: string | null;
  /** The classified cause behind `error` (why, what to do); absent in runs stored before it existed. */
  readonly failure?: FailureRecord | null;
}

export interface DirectoryState {
  readonly deltaLink: string | null;
  /** Start of the last run that enumerated the whole directory. */
  readonly lastFullSyncAt: string | null;
  /** When an admin last asked for a full enumeration. */
  readonly fullSyncRequestedAt: string | null;
  /** Sign-in disabled members with an address, as of the last run. */
  readonly sharedOrBlockedIds: readonly string[];
  readonly lastRun: DirectoryLastRun | null;
}

export const EMPTY_DIRECTORY_STATE: DirectoryState = {
  deltaLink: null,
  lastFullSyncAt: null,
  fullSyncRequestedAt: null,
  sharedOrBlockedIds: [],
  lastRun: null,
};

export interface ProtectionConfig {
  readonly rules: ProtectionRules;
  readonly overrides: ProtectionOverrides;
}

function asRecord(value: unknown): SourceConfigRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as SourceConfigRecord)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

// ---------------------------------------------------------------------------
// Protection: rules and overrides
// ---------------------------------------------------------------------------

/** Rules and overrides of a source, with defaults for anything missing. */
export function readProtection(config: unknown): ProtectionConfig {
  const root = asRecord(config);
  const scope = asRecord(root.scope);
  const protection = asRecord(root.protection);
  const group = asRecord(protection.group);
  const groupId = asString(scope.groupId);
  const rules = normalizeRules({
    mode: scope.mode,
    groupId,
    // The label belongs to one group; a scope edit elsewhere must not mislabel another.
    groupName: groupId !== null && group.id === groupId ? group.name : null,
    exclude: scope.exclude,
    includeSharedMailboxes: protection.includeSharedMailboxes,
  });
  return { rules, overrides: normalizeOverrides(protection.overrides) };
}

/**
 * A token that changes whenever the rules or overrides change. The sync plans
 * against one version and commits only if it still holds, so an admin's edit
 * made while a run was in flight is never overwritten.
 */
export function protectionVersion(config: unknown): string {
  const { rules, overrides } = readProtection(config);
  const sortedOverrides = Object.keys(overrides)
    .sort()
    .map((key) => [key, overrides[key]]);
  return JSON.stringify({ rules: rulesToRecord(rules), overrides: sortedOverrides });
}

function withProtection(
  current: SourceConfigRecord,
  rules: ProtectionRules,
  overrides: ProtectionOverrides,
): SourceConfigRecord {
  const scope: Record<string, unknown> = { mode: rules.mode, exclude: [...rules.exclude] };
  if (rules.groupId !== null) {
    scope.groupId = rules.groupId;
  }
  return {
    ...current,
    scope,
    protection: {
      includeSharedMailboxes: rules.includeSharedMailboxes,
      group:
        rules.groupId !== null && rules.groupName !== null
          ? { id: rules.groupId, name: rules.groupName }
          : null,
      overrides: { ...overrides },
    },
  };
}

/** Replace the rules, keeping overrides and the rest of the config. */
export function writeRules(config: unknown, rules: ProtectionRules): SourceConfigRecord {
  const current = asRecord(config);
  return withProtection(
    current,
    normalizeRules(rulesToRecord(rules)),
    readProtection(current).overrides,
  );
}

/** Set, replace or (with null) remove the override of one protected object. */
export function writeOverride(
  config: unknown,
  externalId: string,
  override: ProtectionOverride | null,
): SourceConfigRecord {
  const current = asRecord(config);
  const { rules, overrides } = readProtection(current);
  const next: Record<string, ProtectionOverride> = { ...overrides };
  if (override === null) {
    delete next[externalId];
  } else {
    next[externalId] = override;
  }
  return withProtection(current, rules, next);
}

// ---------------------------------------------------------------------------
// Sync state
// ---------------------------------------------------------------------------

function asMode(value: unknown): DeltaMode | null {
  return value === "initial" || value === "incremental" || value === "resync" ? value : null;
}

function asLastRun(value: unknown): DirectoryLastRun | null {
  const record = asRecord(value);
  const startedAt = asString(record.startedAt);
  const finishedAt = asString(record.finishedAt);
  if (startedAt === null || finishedAt === null) {
    return null;
  }
  const warnings = Array.isArray(record.warnings) ? (record.warnings as SyncWarning[]) : [];
  return {
    startedAt,
    finishedAt,
    ok: record.ok === true,
    mode: asMode(record.mode),
    counts:
      record.counts && typeof record.counts === "object" ? (record.counts as PlanCounts) : null,
    warnings,
    warningCount: typeof record.warningCount === "number" ? record.warningCount : warnings.length,
    error: asString(record.error),
    failure: parseFailureRecord(record.failure),
  };
}

/** Sync state of a source. */
export function readDirectoryState(config: unknown): DirectoryState {
  const directory = asRecord(asRecord(config).directory);
  return {
    deltaLink: asString(directory.deltaLink),
    lastFullSyncAt: asString(directory.lastFullSyncAt),
    fullSyncRequestedAt: asString(directory.fullSyncRequestedAt),
    sharedOrBlockedIds: asStringList(directory.sharedOrBlockedIds),
    lastRun: asLastRun(directory.lastRun),
  };
}

/** Replace the sync state, keeping the rest of the config. */
export function writeDirectoryState(config: unknown, state: DirectoryState): SourceConfigRecord {
  const current = asRecord(config);
  return {
    ...current,
    directory: {
      deltaLink: state.deltaLink,
      lastFullSyncAt: state.lastFullSyncAt,
      fullSyncRequestedAt: state.fullSyncRequestedAt,
      sharedOrBlockedIds: [...state.sharedOrBlockedIds],
      lastRun: state.lastRun,
    },
  };
}

/** Keep the first warnings and the total, so a tenant-wide failure stays readable. */
export function capWarnings(warnings: readonly SyncWarning[]): {
  warnings: SyncWarning[];
  warningCount: number;
} {
  return { warnings: warnings.slice(0, MAX_STORED_WARNINGS), warningCount: warnings.length };
}

/** Why the next run must enumerate the whole directory; null when changes suffice. */
export type FullSyncReason = "no_delta_link" | "never" | "requested" | "interval";

function timeOf(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/**
 * Decide whether the next run enumerates everything. users/delta reports user
 * changes only; a OneDrive provisioned on first use changes no user property,
 * so a periodic full enumeration is what makes it appear.
 */
export function fullSyncReason(
  state: DirectoryState,
  now: Date,
  intervalMs: number = FULL_SYNC_INTERVAL_MS,
): FullSyncReason | null {
  if (state.deltaLink === null) {
    return "no_delta_link";
  }
  const lastFull = timeOf(state.lastFullSyncAt);
  if (lastFull === null) {
    return "never";
  }
  const requested = timeOf(state.fullSyncRequestedAt);
  if (requested !== null && requested >= lastFull) {
    return "requested";
  }
  return now.getTime() - lastFull >= intervalMs ? "interval" : null;
}
