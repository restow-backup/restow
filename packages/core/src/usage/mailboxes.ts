/**
 * The rule for counting protected mailboxes, used for the usage figures of the
 * dashboards, the tenant pages and the integration API (for example for a
 * provider's billing). Nothing limits or enforces the number.
 *
 * A mailbox in this count is an actively protected Exchange Online mailbox
 * (user, shared and resource mailboxes alike) or an IMAP account. A user's
 * OneDrive is protected together with their mailbox and never counts a second
 * time; only a OneDrive whose owner has no actively protected mailbox counts
 * once, on its own. Excluded and orphaned objects do not count: they are no
 * longer protected, and their backups stay restorable regardless.
 */

/** The fields of a protected object the counting rule looks at. */
export interface MailboxCountable {
  kind: "mailbox" | "onedrive" | "imap";
  status: "active" | "excluded" | "orphaned";
  /** Directory user the object belongs to; null for IMAP accounts and unmatched objects. */
  userId: string | null;
}

/**
 * Protected mailboxes among `objects`, which must all belong to one tenant
 * (directory user ids are tenant-scoped).
 */
export function countProtectedMailboxes(objects: Iterable<MailboxCountable>): number {
  const active = [...objects].filter((object) => object.status === "active");
  const ownersWithMailbox = new Set(
    active
      .filter((object) => object.kind === "mailbox" && object.userId !== null)
      .map((object) => object.userId),
  );
  return active.filter(
    (object) =>
      object.kind !== "onedrive" || object.userId === null || !ownersWithMailbox.has(object.userId),
  ).length;
}
