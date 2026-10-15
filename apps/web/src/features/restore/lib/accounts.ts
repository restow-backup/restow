import type { ObjectKind, RestoreTargetAccount, SnapshotObject } from "@/features/restore/api";
import { objectLabel } from "@/features/restore/explorer/entry-icon";
import { protectedObjectAddress, protectedObjectName } from "@/lib/protected-object";

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

/**
 * The address shown under an account's name: the owner's primary address (a
 * mailbox and the OneDrive of the same person show the same one), the login
 * address of an IMAP account, or null. Never the opaque Entra id of a mailbox
 * or drive, and nothing when it would only repeat the name.
 */
export function accountAddress(
  object: Pick<SnapshotObject, "kind" | "displayName" | "externalId" | "ownerEmail">,
): string | null {
  return protectedObjectAddress(object);
}

/**
 * The label of a suggested target account: its name with its owner's
 * address, so two people of the same name stay apart. The option's value
 * stays the external id the restore is sent with.
 */
export function accountOptionLabel(account: RestoreTargetAccount): string {
  const name = protectedObjectName(account);
  const address = protectedObjectAddress(account);
  return address ? `${name} · ${address}` : name;
}
