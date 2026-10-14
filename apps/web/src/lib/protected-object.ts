/**
 * How to name a protected object (#55), in one place for every view.
 *
 * `externalId` is a stable identifier, not something to show: only for an
 * IMAP account is it a human-meaningful address (the login). For a mailbox
 * it is the Entra object id, for a OneDrive the Graph drive id. A view names
 * an object by its display name, else its owner's address, and keeps the raw
 * id for a tooltip or "technical details" at most.
 */

export type ProtectedObjectKind = "mailbox" | "onedrive" | "imap";

/**
 * The fields a view may know about an object. The owner's address arrives
 * as `email`/`upn` (directory, verify) or as `ownerEmail` (restore, jobs);
 * whichever a DTO carries is used.
 */
export interface NameableObject {
  kind?: ProtectedObjectKind;
  displayName: string | null;
  externalId: string;
  email?: string | null;
  upn?: string | null;
  ownerEmail?: string | null;
}

/**
 * The IMAP account's login, or the owner's address for any other kind; never
 * the opaque Entra or drive id.
 */
function addressOf(object: NameableObject): string | null {
  if (object.kind === "imap") {
    return object.externalId;
  }
  return object.ownerEmail?.trim() || object.email?.trim() || object.upn?.trim() || null;
}

/**
 * The object's name for labels, messages and sorting: its display name, else
 * its address, else (as a last resort) the raw external id. Use
 * {@link hasOnlyTechnicalId} to tell that last case apart.
 */
export function protectedObjectName(object: NameableObject): string {
  return object.displayName?.trim() || addressOf(object) || object.externalId;
}

/**
 * The address next to the name, when it says something the name does not:
 * the owner's email/UPN, or the IMAP login. Null when it would only repeat
 * the name.
 */
export function protectedObjectAddress(object: NameableObject): string | null {
  const address = addressOf(object);
  if (!address) {
    return null;
  }
  return address.toLowerCase() === protectedObjectName(object).toLowerCase() ? null : address;
}

/**
 * Whether the object has nothing better to show than its technical id: no
 * display name and no address, for a mailbox or OneDrive (an IMAP login is
 * an address). Such a view shows the kind ("Mailbox") with the id as a tooltip.
 */
export function hasOnlyTechnicalId(object: NameableObject): boolean {
  return object.kind !== "imap" && protectedObjectName(object) === object.externalId;
}
