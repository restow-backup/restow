/**
 * Archive recipient addressing (docs/IMAP.md, journal receiver section): the receiver
 * accepts two kinds of address on the journal host, each a random opaque token, never an id:
 *
 *   - `journal+<token>`: the tenant's address (`tenants.journal_token`). Exchange Online's
 *     journal rule delivers reports to it; plain copies sent to it (Google Workspace
 *     routing, a hoster's `always_bcc`) are assigned to the tenant's mailboxes by the
 *     addresses in their headers.
 *   - `archive+<token>` (0.4.4): the address of one IMAP account
 *     (`archive_forward_addresses`, not revoked). A plain copy to it belongs to exactly
 *     that account (Postfix BCC maps, mailcow, Sieve `redirect :copy`).
 *
 * Unknown recipients are rejected at RCPT TO, before any message body is ever accepted.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@restow/db";
import { tenants } from "@restow/db";
import { eq, sql } from "drizzle-orm";

const LOCAL_PART_PREFIX = "journal+";
const ACCOUNT_LOCAL_PART_PREFIX = "archive+";

/** The local part of an IMAP account's archive address: `archive+<token>`. */
export function archiveLocalPart(token: string): string {
  return `${ACCOUNT_LOCAL_PART_PREFIX}${token}`;
}

/** Which archive an address delivers to, once resolved. */
export type ArchiveRecipient =
  /** The tenant's journal address. */
  | { readonly kind: "tenant"; readonly tenantId: string }
  /** One IMAP account's archive address. */
  | { readonly kind: "account"; readonly tenantId: string; readonly protectedObjectId: string };

/** The kind and token of an archive address's local part, or null for any other address. */
export function parseArchiveAddress(
  address: string,
): { readonly kind: "tenant" | "account"; readonly token: string } | null {
  const at = address.lastIndexOf("@");
  const local = (at >= 0 ? address.slice(0, at) : address).toLowerCase();
  for (const [prefix, kind] of [
    [LOCAL_PART_PREFIX, "tenant"],
    [ACCOUNT_LOCAL_PART_PREFIX, "account"],
  ] as const) {
    if (local.startsWith(prefix)) {
      const token = local.slice(prefix.length).trim();
      return token.length > 0 ? { kind, token } : null;
    }
  }
  return null;
}

/**
 * Resolve a recipient address to its archive with one query on the installation pool
 * (before any tenant is known): a tenant's journal address, or an IMAP account's active
 * archive address. Null for anything else.
 */
export async function resolveArchiveRecipient(
  providerDb: Database,
  address: string,
): Promise<ArchiveRecipient | null> {
  const parsed = parseArchiveAddress(address);
  if (!parsed) {
    return null;
  }
  if (parsed.kind === "tenant") {
    const tenantId = await tenantIdForJournalAddress(providerDb, address);
    return tenantId ? { kind: "tenant", tenantId } : null;
  }
  const result = await providerDb.execute<{ tenant_id: string; protected_object_id: string }>(sql`
    select fa.tenant_id, fa.protected_object_id
      from archive_forward_addresses fa
      join protected_objects po on po.id = fa.protected_object_id
     where fa.token = ${parsed.token} and fa.revoked_at is null and po.kind = 'imap'
     limit 1
  `);
  const row = result.rows[0];
  return row
    ? { kind: "account", tenantId: row.tenant_id, protectedObjectId: row.protected_object_id }
    : null;
}

/** The local part of a tenant's journal address: `journal+<token>`. */
export function journalLocalPart(token: string): string {
  return `${LOCAL_PART_PREFIX}${token}`;
}

/** Extract the journal token from a recipient address's local part, or null if it is not a journal address. */
export function parseJournalToken(address: string): string | null {
  const at = address.indexOf("@");
  const local = (at >= 0 ? address.slice(0, at) : address).toLowerCase();
  if (!local.startsWith(LOCAL_PART_PREFIX)) {
    return null;
  }
  const token = local.slice(LOCAL_PART_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Resolve a recipient address to its tenant, on the installation pool: this
 * runs before any tenant is known, exactly the lookup docs/ARCHITECTURE.md
 * reserves the installation role for.
 */
export async function tenantIdForJournalAddress(
  providerDb: Database,
  address: string,
): Promise<string | null> {
  const token = parseJournalToken(address);
  if (!token) {
    return null;
  }
  const [row] = await providerDb
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.journalToken, token))
    .limit(1);
  return row?.id ?? null;
}

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** Lowercase base32 (RFC 4648 alphabet, no padding) of `bytes`. */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/**
 * A random journal token for a tenant's journal address: 160 random bits as 32
 * lowercase letters and digits. Lowercase only, because mail systems fold the
 * case of a local part and {@link parseJournalToken} lowercases it: a token
 * with capitals would never be found again. Opaque and unguessable.
 */
export function generateJournalToken(): string {
  return base32(randomBytes(20));
}
