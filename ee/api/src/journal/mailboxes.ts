/**
 * Which protected mailboxes an archived journal report belongs to (#32,
 * docs/ARCHIVE.md). A journal report names its envelope recipients and its
 * sender, not one mailbox: the item belongs to every mailbox of the tenant
 * whose address the envelope names, as a recipient, as the sender (sent
 * mail), as the mailbox a delegate sent for, or as a mailbox that forwarded it.
 *
 * Addresses are compared lowercase with the owner's primary address, UPN and
 * every SMTP alias the directory sync stored (`users.mail_addresses`); an IMAP
 * account by its login. A report that names no mailbox of the tenant stays
 * assigned to the tenant only: it is archived all the same, nothing is ever
 * dropped. The assignments are written in the transaction that appends the
 * item (@restow/core archive/append.ts), so an item never exists without the
 * ones it had when it was received.
 */
import type { archive } from "@restow/core";

// The assignment itself is the core's since 0.4.4 (packages/db archive-append.ts): every
// capture path assigns through the shared archive append.
export { assignArchiveItemMailboxes } from "@restow/db";

/** The addresses of an envelope that make a mailbox the owner of the mail, lowercase, once each. */
export function envelopeAddresses(envelope: archive.JournalEnvelope): string[] {
  const addresses = new Set<string>();
  const add = (value: string | null | undefined) => {
    const address = value?.trim().toLowerCase();
    if (address?.includes("@")) {
      addresses.add(address);
    }
  };
  add(envelope.sender);
  add(envelope.onBehalfOf);
  for (const recipient of envelope.recipients) {
    add(recipient.address);
    add(recipient.forwardedBy);
  }
  return [...addresses];
}
