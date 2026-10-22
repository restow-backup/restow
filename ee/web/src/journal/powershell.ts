/**
 * The Exchange Online PowerShell commands that set up journaling into this installation
 * (docs/ARCHIVE.md "Exchange-Online-Journaling einrichten"): a partner connector to the
 * journal host with TLS, the mailbox for undeliverable journal reports, and the journal rule
 * for all mail. Pure, so the exact text is pinned by a snapshot.
 *
 * Every value is a single-quoted PowerShell string. In such a string PowerShell reads no
 * variable and no escape sequence; a quote is written twice. PowerShell also takes the
 * typographic single quotes (U+2018, U+2019, U+201A, U+201B) as quotes, so they are doubled
 * as well: a value can never end its string early and run as code.
 */

/** A value as a single-quoted PowerShell string. */
export function psQuote(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, (quote) => quote + quote)}'`;
}

export interface JournalPowerShellInput {
  /** The tenant's journal address (`journal+<token>@<host>`). */
  address: string;
  /** The journal host the connector delivers to (`JOURNAL_HOSTNAME`). */
  journalHost: string;
  /** A real mailbox that receives journal reports Exchange could not deliver. */
  ndrAddress: string;
  /** The product name, for the names of the connector and the rule. */
  appName: string;
}

/** The commands, one per line, in the order they are run. */
export function journalPowerShellLines(input: JournalPowerShellInput): string[] {
  const host = psQuote(input.journalHost);
  return [
    "Connect-ExchangeOnline",
    [
      "New-OutboundConnector",
      `-Name ${psQuote(`${input.appName} Journal`)}`,
      "-ConnectorType Partner",
      `-RecipientDomains ${host}`,
      `-SmartHosts ${host}`,
      "-UseMXRecord $false",
      "-TlsSettings DomainValidation",
      `-TlsDomain ${host}`,
    ].join(" "),
    `Set-TransportConfig -JournalingReportNdrTo ${psQuote(input.ndrAddress)}`,
    [
      "New-JournalRule",
      `-Name ${psQuote(input.appName)}`,
      `-JournalEmailAddress ${psQuote(input.address)}`,
      "-Scope Global",
      "-Enabled $true",
    ].join(" "),
  ];
}

export function journalPowerShell(input: JournalPowerShellInput): string {
  return journalPowerShellLines(input).join("\n");
}

/** Why an address for undeliverable journal reports cannot be used; null when it can. */
export type NdrProblem = "empty" | "invalid" | "journal_address" | "journal_host";

const ADDRESS = /^[^\s@'"<>()\\,;:]+@[^\s@'"<>()\\,;:]+\.[^\s@'"<>()\\,;:]+$/;

/**
 * Exchange needs a real mailbox for undeliverable journal reports: a valid address, not the
 * journal address itself and not at the journal host (a report it cannot deliver there would
 * go nowhere either).
 */
export function ndrProblem(
  value: string,
  journal: { address: string | null; hostname: string | null },
): NdrProblem | null {
  const address = value.trim();
  if (address === "") {
    return "empty";
  }
  if (!ADDRESS.test(address)) {
    return "invalid";
  }
  const lower = address.toLowerCase();
  if (journal.address && lower === journal.address.toLowerCase()) {
    return "journal_address";
  }
  if (journal.hostname && lower.endsWith(`@${journal.hostname.toLowerCase()}`)) {
    return "journal_host";
  }
  return null;
}

/** How long the page waits for the first report after "wait", and how often it asks. */
export const FIRST_REPORT_POLL_MS = 5_000;
export const FIRST_REPORT_WAIT_MS = 30 * 60_000;

/** Whether a report arrived since the wait began (`lastReportAt` at or after it). */
export function reportArrivedSince(lastReportAt: string | null, since: number): boolean {
  if (!lastReportAt) {
    return false;
  }
  const at = Date.parse(lastReportAt);
  return Number.isFinite(at) && at >= since;
}
