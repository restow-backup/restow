/**
 * What the journal receiver of this process is doing, for the tenant's journal
 * setup page (./setup.ts). The listener is started once by the background
 * service (./service.ts), which records here what happened, so the setup page
 * can tell an administrator why reports cannot arrive instead of only showing
 * an address that leads nowhere.
 *
 * Process-local on purpose: the listener belongs to the api role that serves
 * the page, so this state and the listener share one process.
 */

export type JournalReceiverState =
  /** The service has not run yet (still starting, or not registered in this process). */
  | { phase: "unstarted" }
  | { phase: "listening"; port: number }
  /** `JOURNAL_SMTP_PORT` is not set: a fresh install never opens a mail port. */
  | { phase: "port_not_configured" }
  /** The edition had no `archive.journalReceiver` when the api started. */
  | { phase: "edition_not_licensed" }
  /** The listener could not be created or bound (port taken, no permission). */
  | { phase: "failed"; message: string }
  /**
   * No TLS certificate and key are configured and the insecure opt-out is off,
   * so no listener was started: the receiver never serves STARTTLS with a
   * certificate it made up or one that ships with a library.
   */
  | { phase: "tls_not_configured" }
  /** The configured certificate or key cannot be used (unreadable, not PEM, mismatched, not yet valid). */
  | { phase: "tls_invalid"; message: string }
  /** The certificate is expired: not started, or expired while running and not yet replaced. */
  | { phase: "tls_expired"; message: string }
  | { phase: "stopped" };

let state: JournalReceiverState = { phase: "unstarted" };

export function journalReceiverState(): JournalReceiverState {
  return state;
}

export function setJournalReceiverState(next: JournalReceiverState): void {
  state = next;
}

/** Test support: back to the state of a process whose service never ran. */
export function resetJournalReceiverStateForTesting(): void {
  state = { phase: "unstarted" };
}
