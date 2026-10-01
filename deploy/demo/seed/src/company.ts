/**
 * The fictional companies and mailboxes the demo shows (deploy/demo/README.md).
 * `example.org` is the domain IANA reserves for documentation, so it can
 * never collide with a real company; the names are made up and carry no
 * meaning outside this demo. No real person, company or personal data.
 */

export const DEMO_DOMAIN = "example.org";

/** One demo tenant (a fictional company) and the mailboxes it owns. */
export interface DemoTenant {
  /** Sent to `POST /api/v1/tenants`. */
  name: string;
  slug: string;
  mailboxes: readonly DemoMailbox[];
}

/** One Dovecot mailbox: the IMAP login and what the seed calls it as a source/account. */
export interface DemoMailbox {
  /** IMAP login and email address, e.g. "info@example.org". */
  login: string;
  displayName: string;
  /** Which folders the generator fills, beyond INBOX (always present). */
  folders: readonly string[];
}

const STANDARD_FOLDERS = ["Sent", "Archive"] as const;

/**
 * Two tenants share the three Dovecot mailboxes of one fictional company:
 * "Example Trading Ltd" gets the busier info@ and accounting@ mailboxes,
 * "Birchwood Consulting Ltd" gets sales@ alone. This shows the Service Provider
 * edition's multi-tenant view without a second Dovecot domain. Everything
 * is in English: the demo is for visitors from anywhere, and German
 * administrators read English too.
 */
export const DEMO_TENANTS: readonly DemoTenant[] = [
  {
    name: "Example Trading Ltd",
    slug: "example-trading",
    mailboxes: [
      {
        login: `info@${DEMO_DOMAIN}`,
        displayName: "Info",
        folders: STANDARD_FOLDERS,
      },
      {
        login: `accounting@${DEMO_DOMAIN}`,
        displayName: "Accounting",
        folders: STANDARD_FOLDERS,
      },
    ],
  },
  {
    name: "Birchwood Consulting Ltd",
    slug: "birchwood-consulting",
    mailboxes: [
      {
        login: `sales@${DEMO_DOMAIN}`,
        displayName: "Sales",
        folders: STANDARD_FOLDERS,
      },
    ],
  },
];

/** Every mailbox across every tenant, flattened for the mail generator. */
export function allMailboxes(tenants: readonly DemoTenant[] = DEMO_TENANTS): DemoMailbox[] {
  return tenants.flatMap((tenant) => tenant.mailboxes);
}

/**
 * The demo mailboxes Dovecot was not told to create: Dovecot provisions its
 * accounts from RESTOW_DEMO_MAILBOXES (comma or space separated), the seed
 * writes and backs up the ones above. A host whose .env still lists other
 * logins would otherwise fail deep inside the seed with an IMAP login error.
 */
export function mailboxesMissingFrom(
  configured: string,
  tenants: readonly DemoTenant[] = DEMO_TENANTS,
): string[] {
  const listed = new Set(
    configured
      .split(/[\s,]+/)
      .map((login) => login.trim().toLowerCase())
      .filter((login) => login.length > 0),
  );
  return allMailboxes(tenants)
    .map((mailbox) => mailbox.login)
    .filter((login) => !listed.has(login.toLowerCase()));
}
