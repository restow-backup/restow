import type { ObjectKind, SnapshotObject } from "@/features/restore/api";
import { objectLabel } from "@/features/restore/explorer/entry-icon";

/**
 * The account list's type filter (a {@link ObjectKind}, or "all"). Kept
 * separate from cmdk's own text search, which the caller applies on top.
 */
export type AccountTypeFilter = "all" | ObjectKind;

export function matchesAccountType(
  object: Pick<SnapshotObject, "kind">,
  filter: AccountTypeFilter,
): boolean {
  return filter === "all" || object.kind === filter;
}

/** The viewer's own account first, then alphabetically by display name. */
export function sortAccounts(objects: readonly SnapshotObject[]): SnapshotObject[] {
  return [...objects].sort((a, b) => {
    if (a.own !== b.own) {
      return a.own ? -1 : 1;
    }
    return objectLabel(a).localeCompare(objectLabel(b));
  });
}

/** Extra words cmdk's fuzzy search can match, beyond the visible label. */
export function accountKeywords(object: SnapshotObject): string[] {
  return [object.externalId, object.kind, ...(object.ownerEmail ? [object.ownerEmail] : [])];
}
