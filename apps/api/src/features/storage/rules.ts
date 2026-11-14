import {
  type StorageLocation,
  type StorageRole,
  storageLocationMoves,
  storageLocationsOverlap,
} from "@restow/core";

/**
 * Every kind a `storage_targets` row can carry, including `installation_default`
 * (the placeholder that stands for the retired environment default once a
 * storage migration replaces it, docs/STORAGE.md; it is never a
 * {@link StorageLocation} of its own, so it is not part of that type).
 */
export type TargetKind = StorageLocation["kind"] | "installation_default";

/**
 * Every role a `storage_targets` row can carry, including `previous` (a
 * retired primary, read-only, docs/STORAGE.md). {@link StorageRole} (core) is
 * narrower on purpose: it is what a person may *choose* when adding a target,
 * and a target is never created with role `previous` directly.
 */
export type AnyTargetRole = StorageRole | "previous";

/**
 * The rules for changing a tenant's storage targets (pure, no I/O).
 *
 * The invariant they protect: every pack the chunk index knows stays readable
 * from the tenant's primary. Backups are written to the primary and every copy;
 * the tenant uses the installation default (environment) as its primary until
 * it has a primary target of its own. Hence:
 *
 *   - a primary target can only be added while the tenant has no data; once it
 *     has data, a new location starts as a copy, is mirrored, and is promoted;
 *   - the primary's location is fixed while it holds data, and it cannot be
 *     removed then (promote another target first);
 *   - a copy must not share storage with a location already in use, or it is
 *     no independent copy;
 *   - a mounted filesystem path is part of the server, so only a provider admin
 *     may configure, change or remove a local target.
 */

export type StorageRuleViolation =
  | "local_requires_provider_admin"
  | "primary_exists"
  | "tenant_has_data"
  | "location_overlap"
  | "location_locked"
  | "primary_holds_data"
  | "already_primary"
  | "not_verified"
  | "migration_in_progress"
  | "not_a_copy";

/** What the rules need to know about the tenant's current setup. */
export interface StorageSituation {
  readonly isProviderAdmin: boolean;
  /** The tenant has at least one pack (its chunk store holds data). */
  readonly tenantHasData: boolean;
  /** The tenant has a primary target row (else the installation default is its primary). */
  readonly hasPrimaryTarget: boolean;
  /**
   * Locations the tenant currently writes to, other than the target being
   * changed: its target rows, plus the installation default while that is the primary.
   */
  readonly locationsInUse: readonly StorageLocation[];
}

/**
 * May the viewer change a target of this kind? A mounted filesystem is part
 * of the server, and so is the placeholder standing for the retired
 * installation default (docs/STORAGE.md) — both are provider-admin only.
 */
export function canManageKind(kind: TargetKind, isProviderAdmin: boolean): boolean {
  const serverManaged = kind === "local" || kind === "installation_default";
  return !serverManaged || isProviderAdmin;
}

function overlapsAny(location: StorageLocation, inUse: readonly StorageLocation[]): boolean {
  return inUse.some((other) => storageLocationsOverlap(location, other));
}

export function decideCreate(
  situation: StorageSituation,
  target: { readonly role: StorageRole; readonly location: StorageLocation },
): StorageRuleViolation | null {
  if (!canManageKind(target.location.kind, situation.isProviderAdmin)) {
    return "local_requires_provider_admin";
  }
  if (target.role === "primary") {
    if (situation.hasPrimaryTarget) {
      return "primary_exists";
    }
    if (situation.tenantHasData) {
      return "tenant_has_data";
    }
  }
  if (overlapsAny(target.location, situation.locationsInUse)) {
    return "location_overlap";
  }
  return null;
}

/**
 * A new target replacing the tenant's current primary (docs/STORAGE.md,
 * "Replace the primary"): the direct-create checks above (`primary_exists`,
 * `tenant_has_data`) are exactly the situations this path exists for, so it
 * skips them; only the destination's location must still be free, and at most
 * one migration may run for a tenant at a time (the same invariant
 * `storage_migrations_tenant_unfinished_uq` enforces in the database).
 */
export function decideReplacePrimary(
  situation: Pick<StorageSituation, "isProviderAdmin" | "locationsInUse">,
  target: { readonly location: StorageLocation; readonly migrationInProgress: boolean },
): StorageRuleViolation | null {
  if (!canManageKind(target.location.kind, situation.isProviderAdmin)) {
    return "local_requires_provider_admin";
  }
  if (target.migrationInProgress) {
    return "migration_in_progress";
  }
  if (overlapsAny(target.location, situation.locationsInUse)) {
    return "location_overlap";
  }
  return null;
}

export function decideUpdate(
  situation: StorageSituation,
  target: {
    readonly role: AnyTargetRole;
    readonly current: StorageLocation;
    /** The new addressing, when the change includes one. */
    readonly next: StorageLocation | null;
    /**
     * A storage migration is unfinished for this tenant. Its worker job
     * opened the source and destination backends once at start and keeps
     * writing to that same addressing throughout (`storage-migration.ts`);
     * changing either target's location out from under it would silently
     * switch the primary over to an empty or unrelated location. Ignored for
     * a change that does not move the location (a name edit): that carries
     * no such risk.
     */
    readonly migrationInProgress?: boolean;
  },
): StorageRuleViolation | null {
  if (!canManageKind(target.current.kind, situation.isProviderAdmin)) {
    return "local_requires_provider_admin";
  }
  if (target.next === null || !movesLocation(target.current, target.next)) {
    return null;
  }
  if (target.migrationInProgress) {
    return "migration_in_progress";
  }
  if (target.role === "primary" && situation.tenantHasData) {
    return "location_locked";
  }
  if (overlapsAny(target.next, situation.locationsInUse)) {
    return "location_overlap";
  }
  return null;
}

export function decideDelete(
  situation: StorageSituation,
  target: { readonly role: AnyTargetRole; readonly kind: TargetKind },
): StorageRuleViolation | null {
  if (!canManageKind(target.kind, situation.isProviderAdmin)) {
    return "local_requires_provider_admin";
  }
  if (target.role === "primary" && situation.tenantHasData) {
    return "primary_holds_data";
  }
  return null;
}

/**
 * Promotion checks that need no storage access; the service additionally
 * proves the copy holds everything the primary holds before it switches.
 */
export function decidePromote(
  situation: Pick<StorageSituation, "isProviderAdmin">,
  target: {
    readonly role: AnyTargetRole;
    readonly kind: TargetKind;
    readonly status: "unverified" | "ok" | "error";
    /**
     * A storage migration is unfinished for this tenant. Promoting another
     * copy while one runs would collide with the migration's own switch (the
     * single-primary constraint, or retiring a target that already stopped
     * being primary) — refused up front instead of surfacing as a raw
     * constraint violation or a corrupted switch.
     */
    readonly migrationInProgress?: boolean;
  },
): StorageRuleViolation | null {
  if (!canManageKind(target.kind, situation.isProviderAdmin)) {
    return "local_requires_provider_admin";
  }
  if (target.role === "primary") {
    return "already_primary";
  }
  // Only a copy can be promoted: a `previous` target is a retired primary a
  // storage migration already switched away from through its own, hash-
  // verified path (docs/STORAGE.md); this shortcut is not for it.
  if (target.role !== "copy") {
    return "not_a_copy";
  }
  if (target.migrationInProgress) {
    return "migration_in_progress";
  }
  if (target.status !== "ok") {
    return "not_verified";
  }
  return null;
}

/**
 * Whether new addressing points at other storage. Region and addressing style
 * only describe how to talk to the same bucket, so correcting them never moves
 * data; the path, the service (endpoint), the bucket and the prefix do.
 */
export function movesLocation(current: StorageLocation, next: StorageLocation): boolean {
  return storageLocationMoves(current, next);
}

/**
 * Stored credentials are only ever sent to the service they were saved for
 * (like a stored IMAP password and its host): pointing an S3 target at another
 * endpoint, or testing it there, needs the key pair again.
 */
export function credentialsBoundElsewhere(
  stored: StorageLocation | null,
  next: StorageLocation,
): boolean {
  if (next.kind !== "s3") {
    return false;
  }
  return stored?.kind !== "s3" || stored.endpoint !== next.endpoint;
}

// --- Promoting a copy ------------------------------------------------------------------

/**
 * Why a copy cannot be made the primary right now (docs/STORAGE.md, "Promoting a copy"). The
 * dialog lists every one of them before the click, each with what the administrator can do; the
 * promotion itself refuses with the first.
 */
export type PromotionBlockerCode =
  | "local_requires_provider_admin"
  | "already_primary"
  | "not_a_copy"
  | "migration_in_progress"
  | "not_verified"
  | "active_endpoints"
  | "switch_blocked_by_runs"
  | "switch_blocked_by_repair"
  | "storage_jobs_running"
  | "copy_pass_running"
  | "repository_copies_incomplete"
  | "copy_incomplete"
  | "unreachable";

export interface PromotionBlocker {
  readonly code: PromotionBlockerCode;
  /** `storage_jobs_running`: the queues with a queued or running job. */
  readonly queues?: readonly string[];
  /** `repository_copies_incomplete`: how many repositories are not complete on the copy. */
  readonly repositories?: number;
}

/**
 * Where the copy of one restic repository stands for a promotion:
 *
 *   - `current`: the last copy succeeded, its check passed, it lacked nothing, and it started
 *     after the newest restore point the server recorded for the object;
 *   - `outdated`: it was current, but a newer restore point was recorded since;
 *   - `behind`: restore points were missing after the last copy;
 *   - `failed`: the last copy or its check failed;
 *   - `requested`: a copy was asked for ("Catch up now") and has not run yet;
 *   - `pending`: never copied (a new repository, a copy target added recently);
 *   - `not_created`: the repository is being created (its first backup has not finished).
 */
export type RepositoryCopyReadiness =
  | "current"
  | "outdated"
  | "behind"
  | "failed"
  | "requested"
  | "pending"
  | "not_created";

/** What a promotion needs to know about one repository and its copy on the target. */
export interface RepositoryCopyFacts {
  /** The repository exists (`repository_ready_at`; a machine's always does). */
  readonly created: boolean;
  /** The `repository_copies` row of this repository and the target; null when there is none. */
  readonly row: {
    readonly state: "pending" | "current" | "behind" | "failed";
    readonly missingSnapshots: number;
    readonly lastAttemptAt: Date | null;
    readonly lastCheckOk: boolean | null;
  } | null;
  /** When the server last recorded a restore point of the object (null: none). */
  readonly newestBackup: Date | null;
}

export function repositoryCopyReadiness(facts: RepositoryCopyFacts): RepositoryCopyReadiness {
  const { row } = facts;
  if (!facts.created) {
    return "not_created";
  }
  if (!row) {
    return "pending";
  }
  if (row.lastAttemptAt === null) {
    return row.state === "pending" ? "pending" : "requested";
  }
  if (row.state === "failed" || row.lastCheckOk === false) {
    return "failed";
  }
  if (row.state === "pending") {
    return "pending";
  }
  if (row.state === "behind" || row.missingSnapshots > 0) {
    return "behind";
  }
  // The pass lists the primary after it starts: a restore point recorded before that start is in
  // its listing, a later one may not be.
  if (facts.newestBackup && row.lastAttemptAt < facts.newestBackup) {
    return "outdated";
  }
  return "current";
}

/** Everything the promotion of one copy depends on, read from the database and the storage. */
export interface PromotionFacts {
  readonly isProviderAdmin: boolean;
  readonly target: {
    readonly role: AnyTargetRole;
    readonly kind: TargetKind;
    readonly status: "unverified" | "ok" | "error";
  };
  readonly migrationInProgress: boolean;
  /** An agent still backs up to the primary (an active machine). */
  readonly activeEndpoints: boolean;
  /** A Proxmox VE backup or a file share run is running. */
  readonly runningRepositoryRun: boolean;
  /** A repository repair is queued or running. */
  readonly repairActive: boolean;
  /** Queues of the tenant's queued or running jobs that write to storage. */
  readonly writeJobQueues: readonly string[];
  /** The worker copies this tenant's repositories right now. */
  readonly copyPassRunning: boolean;
  /** Each restic repository of the tenant and its copy on the target. */
  readonly repositories: readonly RepositoryCopyFacts[];
  /** The file-level comparison (packs, manifests, keys, archive records): null while not run. */
  readonly files: { readonly complete: boolean } | "unreachable" | null;
}

/**
 * Every reason the copy cannot become the primary now (pure; the service gathers the facts).
 * With restic repositories the current primary retires read-only like after a "move" (its
 * repositories are not repository copies, so it cannot stay a copy): then every job that writes
 * to storage holds the switch, as for "keep"; without them it stays a copy and keeps receiving
 * writes, and only a running storage check (it mirrors the copies) does.
 */
export function decidePromotion(facts: PromotionFacts): PromotionBlocker[] {
  if (!canManageKind(facts.target.kind, facts.isProviderAdmin)) {
    return [{ code: "local_requires_provider_admin" }];
  }
  if (facts.target.role === "primary") {
    return [{ code: "already_primary" }];
  }
  if (facts.target.role !== "copy") {
    return [{ code: "not_a_copy" }];
  }
  const blockers: PromotionBlocker[] = [];
  if (facts.migrationInProgress) {
    blockers.push({ code: "migration_in_progress" });
  }
  if (facts.target.status !== "ok") {
    blockers.push({ code: "not_verified" });
  }
  if (facts.activeEndpoints) {
    blockers.push({ code: "active_endpoints" });
  }
  if (facts.runningRepositoryRun) {
    blockers.push({ code: "switch_blocked_by_runs" });
  }
  if (facts.repairActive) {
    blockers.push({ code: "switch_blocked_by_repair" });
  }
  const hasRepositories = facts.repositories.length > 0;
  const queues = [
    ...new Set(
      hasRepositories
        ? facts.writeJobQueues
        : facts.writeJobQueues.filter((queue) => queue === "scrub"),
    ),
  ].sort();
  if (queues.length > 0) {
    blockers.push({ code: "storage_jobs_running", queues });
  }
  if (hasRepositories && facts.copyPassRunning) {
    blockers.push({ code: "copy_pass_running" });
  }
  const incomplete = facts.repositories.filter(
    (repository) => repositoryCopyReadiness(repository) !== "current",
  ).length;
  if (incomplete > 0) {
    blockers.push({ code: "repository_copies_incomplete", repositories: incomplete });
  }
  if (facts.files === "unreachable") {
    blockers.push({ code: "unreachable" });
  } else if (facts.files && !facts.files.complete) {
    blockers.push({ code: "copy_incomplete" });
  }
  return blockers;
}

/** What a recorded restic snapshot id becomes on a promoted copy, or null when it is not there. */
export interface CopiedSnapshot {
  readonly id: string;
  /** The id it was copied from (restic's `original`), null for a snapshot made there. */
  readonly original: string | null;
}

/**
 * The id under which a repository copy holds the snapshot the database records as `recorded` (the
 * primary's id, possibly abbreviated): the copy whose persistent id (`original`, else its own) is
 * or begins with it, abbreviated to the same length. Null when the copy holds none of it, or when
 * an abbreviation is ambiguous.
 */
export function idOnCopy(copies: readonly CopiedSnapshot[], recorded: string): string | null {
  if (!recorded) {
    return null;
  }
  const matches = copies.filter((copy) => (copy.original ?? copy.id).startsWith(recorded));
  const exact = matches.filter((copy) => (copy.original ?? copy.id) === recorded);
  // Two copies of one snapshot (never expected) hold the same content: the first will do.
  const [match] = exact.length > 0 ? exact : matches;
  if (!match || (exact.length === 0 && matches.length > 1)) {
    return null;
  }
  return recorded.length >= match.id.length ? match.id : match.id.slice(0, recorded.length);
}
