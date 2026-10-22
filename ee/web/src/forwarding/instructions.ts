/**
 * What a mail provider needs to send the archive a copy of every mail (docs/ARCHIVE.md
 * "Erfassungswege", forwarding): pure generators of the configuration for Postfix, mailcow
 * and Sieve from the accounts' archive addresses, and the steps for Google Workspace, which
 * routes to the tenant's address instead. The text is shown and copied as it is.
 */

export interface ForwardTarget {
  /** The account's address at the provider (its login). */
  login: string;
  /** The account's archive address. */
  address: string;
}

/** The map file Postfix reads for both directions: `<account> <archive address>`, one per line. */
export function postfixBccMap(targets: readonly ForwardTarget[]): string {
  const width = Math.max(0, ...targets.map((target) => target.login.length));
  return targets.map((target) => `${target.login.padEnd(width)}  ${target.address}`).join("\n");
}

export const POSTFIX_MAP_PATH = "/etc/postfix/archive_bcc";

/** The lines for main.cf: incoming mail by recipient, outgoing mail by sender. */
export function postfixMainCf(path: string = POSTFIX_MAP_PATH): string {
  return [`recipient_bcc_maps = hash:${path}`, `sender_bcc_maps = hash:${path}`].join("\n");
}

/** The commands that build the map and load the configuration. */
export function postfixReload(path: string = POSTFIX_MAP_PATH): string {
  return [`postmap ${path}`, "postfix reload"].join("\n");
}

/**
 * The entries of mailcow's BCC maps (E-Mail, Konfiguration, BCC): one sender map and one
 * recipient map per account, as "type, local address, BCC destination".
 */
export function mailcowBccEntries(targets: readonly ForwardTarget[]): string {
  return targets
    .flatMap((target) => [
      `sender     ${target.login}  ->  ${target.address}`,
      `recipient  ${target.login}  ->  ${target.address}`,
    ])
    .join("\n");
}

/** A Sieve address in quotes: backslash and quote escaped (RFC 5228, 2.4.2). */
export function sieveString(value: string): string {
  return `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}

/**
 * The Sieve rule of one account: a copy of every incoming mail to the archive, the mail
 * itself stays (`:copy`, RFC 3894). Outgoing mail needs a BCC rule at the provider; Sieve
 * runs on delivery only.
 */
export function sieveRedirect(address: string): string {
  return ['require ["copy"];', `redirect :copy ${sieveString(address)};`].join("\n");
}
