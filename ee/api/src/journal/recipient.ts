/**
 * Journal recipient addressing (docs/IMAP.md, journal receiver section): each
 * tenant's Exchange Online journal rule delivers to
 * `journal+<journalToken>@<journal host>`, a random opaque token
 * (`tenants.journal_token`), never the tenant id itself. Unknown recipients
 * are rejected at RCPT TO, before any message body is ever accepted.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@restow/db";
import { tenants } from "@restow/db";
import { eq } from "drizzle-orm";

const LOCAL_PART_PREFIX = "journal+";

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
