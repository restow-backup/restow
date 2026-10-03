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
