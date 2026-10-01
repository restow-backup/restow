import type { JournalSetup, JournalStatus } from "./api";

/**
 * View decisions of the journal section, kept out of the component so they are
 * testable without rendering: which tone a status has, and what the
 * checklist says for the installation's configuration.
 */

export type JournalTone = "info" | "warning" | "destructive" | "muted";

export const STATUS_TONE: Readonly<Record<JournalStatus, JournalTone>> = {
  // Reports arriving is running work (Lapis, with the live pulse), not a passed restore check.
  receiving: "info",
  stale: "warning",
  no_reports: "muted",
  receiver_down: "destructive",
  // Not using journaling is no fault: neither red nor amber.
  not_configured: "muted",
};

/**
 * `ok`: satisfied, `warn`: will not work as configured, `todo`: still to do, or
 * something Restow cannot check from here.
 */
export type ChecklistState = "ok" | "warn" | "todo";

export interface ChecklistItem {
  id: "dns" | "port" | "tls" | "size";
  state: ChecklistState;
  /** Key below `journal.checklist` in the `archive` namespace. */
  key: string;
  params: Record<string, string | number>;
}

/**
 * What Exchange Online needs from this installation, judged from its
 * configuration. Before journaling is set up at all, nothing is a warning: the
 * missing port and certificate are simply the first things to do.
 */
export function checklistItems(setup: JournalSetup): ChecklistItem[] {
  const { requirements } = setup;
  const notSetUp = isNotSetUp(setup.status);
  const port: ChecklistItem =
    requirements.smtpPort === null
      ? { id: "port", state: notSetUp ? "todo" : "warn", key: "portUnset", params: {} }
      : requirements.portMismatch
        ? {
            id: "port",
            state: "warn",
            key: "portForward",
            params: { port: requirements.smtpPort },
          }
        : { id: "port", state: "todo", key: "portOk", params: {} };
  return [
    requirements.dnsName === null
      ? { id: "dns", state: "todo", key: "dnsUnset", params: {} }
      : { id: "dns", state: "todo", key: "dns", params: { host: requirements.dnsName } },
    port,
    requirements.tlsConfigured
      ? { id: "tls", state: "ok", key: "tlsOk", params: {} }
      : notSetUp
        ? { id: "tls", state: "todo", key: "tlsNeeded", params: {} }
        : { id: "tls", state: "warn", key: "tlsMissing", params: {} },
    {
      id: "size",
      state: "ok",
      key: "size",
      params: { size: requirements.maxMessageMegabytes },
    },
  ];
}

/** The steps of the Exchange Online guide, in order; each has a title and a body below `journal.guide`. */
export const GUIDE_STEPS = [
  "connector",
  "routing",
  "validate",
  "undeliverable",
  "rule",
  "verify",
] as const;

/** Journaling is not used on this installation (`JOURNAL_SMTP_PORT` unset): not a failure. */
export function isNotSetUp(status: JournalStatus): boolean {
  return status === "not_configured";
}

/**
 * The guide starts open while a configured setup waits for reports or has
 * trouble, and folds away once reports arrive, or when journaling is not set
 * up at all (nobody asked for the guide yet).
 */
export function guideOpenByDefault(status: JournalStatus): boolean {
  return status !== "receiving" && !isNotSetUp(status);
}
