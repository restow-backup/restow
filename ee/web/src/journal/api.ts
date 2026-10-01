import { apiFetch } from "@/lib/api";

/**
 * Typed client for /api/v1/archive/journal (ee/api/src/journal/routes.ts).
 * The routes answer 404 without the `archive.journalReceiver` capability, so
 * the section only calls them for an edition that includes it.
 */

/**
 * `not_configured`: the installation does not use journaling (`JOURNAL_SMTP_PORT`
 * is unset), a normal state; `receiver_down`: configured, but nothing can arrive.
 */
export type JournalStatus =
  | "receiving"
  | "stale"
  | "no_reports"
  | "receiver_down"
  | "not_configured";

export type ReceiverReason =
  | "port_not_configured"
  | "restart_required"
  | "listen_failed"
  | "tls_not_configured"
  | "tls_invalid"
  | "tls_expired"
  | "not_started";

export type HostnameIssue = "missing" | "invalid";

export interface JournalSetup {
  /** The complete address for the journal rule; null while no valid journal host is configured. */
  address: string | null;
  /** `journal+<token>`, the part before the `@`. */
  localPart: string;
  hostname: string | null;
  hostnameIssue: HostnameIssue | null;
  status: JournalStatus;
  receiver: { listening: boolean; reason: ReceiverReason | null };
  lastReportAt: string | null;
  counts: { last24Hours: number; last7Days: number };
  requirements: {
    dnsName: string | null;
    smtpPort: number | null;
    exchangePort: number;
    portMismatch: boolean;
    /** The receiver serves a configured, usable, unexpired certificate. */
    tlsConfigured: boolean;
    maxMessageMegabytes: number;
  };
  docsUrl: string | null;
}

const JOURNAL = "/archive/journal";

export function fetchJournalSetup(): Promise<JournalSetup> {
  return apiFetch<JournalSetup>(JOURNAL);
}

export function rotateJournalAddress(): Promise<JournalSetup> {
  return apiFetch<JournalSetup>(`${JOURNAL}/rotate`, { method: "POST" });
}

export const journalKeys = {
  setup: (tenantId: string | null) => ["tenant", tenantId, "archive", "journal"] as const,
};
