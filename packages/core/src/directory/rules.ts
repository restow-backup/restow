/**
 * Protection rules: which mailboxes and OneDrives of a tenant Restow protects.
 *
 * docs/MICROSOFT.md is explicit that a Graph `$filter` on `accountEnabled` is
 * the wrong tool (shared and resource mailboxes are sign-in disabled), so the
 * directory sync enumerates every user object and these rules decide. They are
 * pure functions over plain data; ./config.ts maps them onto the source's
 * `config` jsonb column.
 *
 * Precedence, highest first:
 *   1. a per-object override set by an admin (include / exclude)
 *   2. the exclusion list (object ids, UPNs, mail addresses) — modes `all`/`group` only
 *   3. the shared/blocked-mailbox switch — modes `all`/`group` only
 *   4. the mode: everyone, the (transitive) members of one group, or (mode
 *      `selected`) nobody by default — only an `include` override protects
 *
 * `selected` mode inverts the default: nothing is protected unless an admin
 * explicitly included it. The exclusion list and the shared-mailbox switch
 * are meaningless there (the default already excludes), so they play no part
 * once `mode` is `selected`.
 */

/**
 * Everyone, only the members of one Entra group, or nobody except objects an
 * admin explicitly included.
 */
export type ProtectionMode = "all" | "group" | "selected";

/** An admin's explicit decision for one protected object, beating the rules. */
export type ProtectionOverride = "include" | "exclude";

/** The rule set of one M365 source. */
export interface ProtectionRules {
  readonly mode: ProtectionMode;
  /** Entra group object id when `mode` is `group`. */
  readonly groupId: string | null;
  /** Display name of that group, kept for the UI (the id is what the sync uses). */
  readonly groupName: string | null;
  /**
   * Identities never to protect: Entra object ids, user principal names or
   * SMTP addresses. Matching is case-insensitive.
   */
  readonly exclude: readonly string[];
  /**
   * Whether sign-in disabled member accounts with a mailbox (shared and resource
   * mailboxes, but also blocked users) are in scope. Default true: a shared
   * mailbox is exactly what an admin expects a backup to cover.
   */
  readonly includeSharedMailboxes: boolean;
}

/** Overrides keyed by the protected object's external id. */
export type ProtectionOverrides = Readonly<Record<string, ProtectionOverride>>;

/** Rules as they may appear in a jsonb column: everything optional and untrusted. */
export interface ProtectionRulesRecord {
  readonly mode?: unknown;
  readonly groupId?: unknown;
  readonly groupName?: unknown;
  readonly exclude?: unknown;
  readonly includeSharedMailboxes?: unknown;
}

/** Plain, serialisable form of {@link ProtectionRules} (API bodies, jsonb). */
export interface ProtectionRulesDto {
  mode: ProtectionMode;
  groupId: string | null;
  groupName: string | null;
  exclude: string[];
  includeSharedMailboxes: boolean;
}

export const DEFAULT_PROTECTION_RULES: ProtectionRules = {
  mode: "all",
  groupId: null,
  groupName: null,
  exclude: [],
  includeSharedMailboxes: true,
};

/** Lower-case and trim an identity for comparison; empty input becomes null. */
export function normalizeIdentity(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

/** De-duplicate identities case-insensitively while keeping the first spelling. */
export function uniqueIdentities(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = normalizeIdentity(value);
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(value.trim());
    }
  }
  return result;
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Turn an untrusted record into a valid rule set, dropping what cannot be used. */
export function normalizeRules(record: ProtectionRulesRecord | null | undefined): ProtectionRules {
  if (!record) {
    return DEFAULT_PROTECTION_RULES;
  }
  const groupId = trimmedString(record.groupId);
  const mode: ProtectionMode =
    record.mode === "group" && groupId !== null
      ? "group"
      : record.mode === "selected"
        ? "selected"
        : "all";
  // The exclusion list only means anything in `all`/`group` mode (see
  // `evaluateProtection`, which returns before ever reading it in `selected`
  // mode), but it is kept regardless of the current mode: wiping it on save
  // would silently drop identities an admin excluded on purpose (privacy,
  // service accounts) the moment the source switches back to `all`/`group`.
  const exclude = Array.isArray(record.exclude)
    ? uniqueIdentities(record.exclude.filter((entry): entry is string => typeof entry === "string"))
    : [];
  return {
    mode,
    groupId: mode === "group" ? groupId : null,
    groupName: mode === "group" ? trimmedString(record.groupName) : null,
    exclude,
    includeSharedMailboxes:
      typeof record.includeSharedMailboxes === "boolean" ? record.includeSharedMailboxes : true,
  };
}

/** Overrides from an untrusted record: only `include` / `exclude` survive. */
export function normalizeOverrides(value: unknown): ProtectionOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const overrides: Record<string, ProtectionOverride> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if ((entry === "include" || entry === "exclude") && key.trim().length > 0) {
      overrides[key] = entry;
    }
  }
  return overrides;
}

/** Serializable form of the rules for a jsonb column or an API response. */
export function rulesToRecord(rules: ProtectionRules): ProtectionRulesDto {
  return {
    mode: rules.mode,
    groupId: rules.groupId,
    groupName: rules.groupName,
    exclude: [...rules.exclude],
    includeSharedMailboxes: rules.includeSharedMailboxes,
  };
}

/**
 * What the rules need to know about the owner of a protected object. The
 * sync builds it from a fresh directory entry, or from what it stored earlier
 * when the user did not change in an incremental run.
 */
export interface ProtectionSubject {
  readonly entraObjectId: string;
  readonly upn: string | null;
  readonly mail: string | null;
  /** Sign-in disabled member account with an address: shared, resource or blocked. */
  readonly sharedOrBlocked: boolean;
}

/** The directory facts that make an account "shared or blocked". */
export interface AccountFacts {
  /** Null when unknown. */
  readonly accountEnabled: boolean | null;
  readonly mail: string | null;
  /** `Member` or `Guest`; null when unknown. */
  readonly userType: string | null;
}

/**
 * Shared, resource or blocked account: sign-in disabled member with an SMTP
 * address. Graph does not tell these apart (docs/MICROSOFT.md), so the rules
 * treat them as one class and the UI labels them "shared or blocked".
 */
export function isSharedOrBlocked(facts: AccountFacts): boolean {
  return (
    facts.accountEnabled === false &&
    facts.mail !== null &&
    (facts.userType ?? "Member").toLowerCase() === "member"
  );
}

/** True when any of the subject's names is on the exclusion list. */
export function matchesExclusion(subject: ProtectionSubject, exclude: readonly string[]): boolean {
  if (exclude.length === 0) {
    return false;
  }
  const names = new Set(
    [subject.entraObjectId, subject.upn, subject.mail]
      .map(normalizeIdentity)
      .filter((name): name is string => name !== null),
  );
  return exclude.some((entry) => {
    const key = normalizeIdentity(entry);
    return key !== null && names.has(key);
  });
}

export type ProtectionStatus = "active" | "excluded";

/** Why an object got its status; written to the sync log. */
export type ProtectionReason =
  | "override_include"
  | "override_exclude"
  | "exclusion_list"
  | "shared_mailbox_disabled"
  | "group_member"
  | "not_in_group"
  | "group_unresolved"
  | "rule_all"
  | "not_selected";

export interface ProtectionDecision {
  readonly status: ProtectionStatus;
  readonly reason: ProtectionReason;
}

export interface EvaluateProtectionInput {
  readonly subject: ProtectionSubject;
  readonly rules: ProtectionRules;
  /** Override recorded for the specific object, if any. */
  readonly override?: ProtectionOverride | null;
  /**
   * Transitive user members of the rule group. Required in `group` mode; null
   * means the membership could not be resolved, which excludes (never silently
   * includes) with reason `group_unresolved`.
   */
  readonly groupMemberIds?: ReadonlySet<string> | null;
}

/** Decide whether one protected object is in scope. */
export function evaluateProtection(input: EvaluateProtectionInput): ProtectionDecision {
  const { subject, rules } = input;
  if (input.override === "include") {
    return { status: "active", reason: "override_include" };
  }
  if (input.override === "exclude") {
    return { status: "excluded", reason: "override_exclude" };
  }
  if (rules.mode === "selected") {
    // Nothing is protected by default; only the override above changes that.
    return { status: "excluded", reason: "not_selected" };
  }
  if (matchesExclusion(subject, rules.exclude)) {
    return { status: "excluded", reason: "exclusion_list" };
  }
  if (!rules.includeSharedMailboxes && subject.sharedOrBlocked) {
    return { status: "excluded", reason: "shared_mailbox_disabled" };
  }
  if (rules.mode === "group") {
    const members = input.groupMemberIds ?? null;
    if (members === null) {
      return { status: "excluded", reason: "group_unresolved" };
    }
    return members.has(subject.entraObjectId)
      ? { status: "active", reason: "group_member" }
      : { status: "excluded", reason: "not_in_group" };
  }
  return { status: "active", reason: "rule_all" };
}

/** Status an override puts an object in right away (orphaned objects stay orphaned). */
export function statusForOverride(override: ProtectionOverride): ProtectionStatus {
  return override === "include" ? "active" : "excluded";
}
