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
 * dropped. The assignments are written in the receiver's own transaction,
 * so an item never exists without the ones it had when it was received.
 */
import type { archive } from "@restow/core";
import { sql } from "drizzle-orm";
import type { DbExecutor } from "../../../../apps/api/src/lib/tenant-context.js";

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

/**
 * Assign the archive item `itemId` to every mailbox of the tenant the
 * addresses name. Runs inside the tenant-pinned transaction of the receiver
 * (Row Level Security keeps it to the tenant). Returns how many mailboxes it assigned.
 */
export async function assignArchiveItemMailboxes(
  tx: DbExecutor,
  tenantId: string,
  itemId: string,
  addresses: readonly string[],
): Promise<number> {
  if (addresses.length === 0) {
    return 0;
  }
  const list = sql`ARRAY[${sql.join(
    addresses.map((address) => sql`${address}`),
    sql`, `,
  )}]::text[]`;
  const result = await tx.execute(sql`
    insert into archive_item_mailboxes (tenant_id, archive_item_id, protected_object_id)
    select ${tenantId}::uuid, ${itemId}::uuid, po.id
      from protected_objects po
      left join users u on u.id = po.user_id
     where po.tenant_id = ${tenantId}::uuid
       and (
         (po.kind = 'mailbox' and u.id is not null and (
            lower(u.email) = any(${list})
            or lower(u.upn) = any(${list})
            or u.mail_addresses && ${list}
         ))
         or (po.kind = 'imap' and lower(po.external_id) = any(${list}))
       )
    on conflict do nothing
  `);
  return result.rowCount ?? 0;
}
