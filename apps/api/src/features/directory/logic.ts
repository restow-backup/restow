import {
  type ProtectionMode,
  type ProtectionOverride,
  type ProtectionRules,
  normalizeRules,
  statusForOverride,
} from "@restow/core";
import type { ProtectionOverrideInput, RulesInput } from "./schemas.js";

/** Pure helpers of the directory feature (no I/O), tested in logic.test.ts. */

export type ObjectStatus = "active" | "excluded" | "orphaned";
/** `import` never reaches the directory (imported mailboxes have no protection scope), see service.ts. */
export type SourceKind = "m365" | "imap" | "import";

/** Validated request body -> rule set (the same normalisation the sync applies). */
export function rulesFromInput(input: RulesInput): ProtectionRules {
  return normalizeRules({
    mode: input.mode,
    groupId: input.groupId ?? null,
    groupName: input.groupName ?? null,
    exclude: input.exclude,
    includeSharedMailboxes: input.includeSharedMailboxes,
  });
}

export interface OverrideDecision {
  /** Status to store now. */
  readonly status: ObjectStatus;
  /** Override to record on an M365 source; null removes it. IMAP objects keep none. */
  readonly override: ProtectionOverride | null;
  /** True when only a directory sync can settle the status (rules may need Graph). */
  readonly needsSync: boolean;
}

/**
 * What an admin's decision does to one object. Include and exclude apply at
 * once. A reset returns an M365 object to its rules, which only a sync can
 * evaluate (group membership lives in Entra); an IMAP account has no rules,
 * so a reset simply protects it again. An orphaned object keeps its status:
 * the mailbox or drive is gone, and a recorded override waits for its return.
 */
export function decideOverride(
  action: ProtectionOverrideInput["action"],
  current: ObjectStatus,
  sourceKind: SourceKind,
): OverrideDecision {
  if (sourceKind === "imap" || sourceKind === "import") {
    const status = action === "exclude" ? "excluded" : "active";
    return { status: current === "orphaned" ? current : status, override: null, needsSync: false };
  }
  if (action === "reset") {
    return { status: current, override: null, needsSync: current !== "orphaned" };
  }
  return {
    status: current === "orphaned" ? current : statusForOverride(action),
    override: action,
    needsSync: false,
  };
}

/** True when a requested full enumeration has not run since the request. */
export function fullSyncPending(
  requestedAt: string | null,
  lastFullSyncAt: string | null,
): boolean {
  if (requestedAt === null) {
    return false;
  }
  if (lastFullSyncAt === null) {
    return true;
  }
  return Date.parse(requestedAt) >= Date.parse(lastFullSyncAt);
}

/** A LIKE pattern matching `text` anywhere, with the wildcards in it escaped. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * An `excluded` M365 object is "not selected" rather than "excluded" when its
 * source is in `selected` mode and nothing explicitly excluded it: that mode's
 * default (nothing protected unless chosen) is not a decision made against
 * this particular object, so the UI must not say so. An `exclude` override,
 * even in `selected` mode, still reads as a deliberate exclusion.
 */
export function isNotSelected(
  sourceKind: SourceKind,
  mode: ProtectionMode,
  status: ObjectStatus,
  override: ProtectionOverride | null,
): boolean {
  return (
    sourceKind === "m365" && mode === "selected" && status === "excluded" && override !== "exclude"
  );
}
