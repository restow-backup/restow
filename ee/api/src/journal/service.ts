import { config } from "../../../../apps/api/src/config.js";
import { db, providerDb } from "../../../../apps/api/src/db.js";
import type { BackgroundService } from "../../../../apps/api/src/extensions.js";
import { archiveRetentionPolicyFor } from "../../../../apps/api/src/features/archive/retention-policy.js";
import { configureParserPool } from "../../../../apps/api/src/lib/parser-pool.js";
import { keyProvider } from "../../../../apps/api/src/lib/secrets.js";
import { hasCapability } from "../license/gate.js";
import { startJournalListener } from "./listener.js";
import { setJournalReceiverState } from "./receiver-state.js";

/**
 * The archive journal SMTP receiver (docs/ARCHITECTURE.md: part of the `api`
 * role, not a separate command), started next to the HTTP server through the
 * core's background service extension point (apps/api/src/extensions.ts).
 *
 * It starts only when JOURNAL_SMTP_PORT is set, so a fresh install never opens
 * an unconfigured mail port, only when the installation's edition includes
 * `archive.journalReceiver` (Business and Service Provider), and only with a
 * usable TLS certificate (./tls.ts; the explicit JOURNAL_ALLOW_INSECURE opt-out
 * starts it without STARTTLS, for local development and the smoke). The edition
 * is read once at start: a long-lived listener cannot be toggled mid-process, so
 * installing a license key that adds this capability needs an api restart to
 * take effect (documented in ee/README.md). The certificate files are re-read
 * while it runs, so a renewal needs no restart.
 *
 * What happened is recorded in ./receiver-state.ts, which the tenant's journal
 * setup page reads to explain why reports cannot arrive.
 *
 * Reports are parsed in the API's parser processes (apps/api/src/lib/parser-pool.ts,
 * shared with the mail preview), whose limits are applied before the port opens.
 */
export const journalReceiverService: BackgroundService = {
  name: "archive-journal-receiver",
  async start() {
    const port = config.journal.port;
    if (!port) {
      setJournalReceiverState({ phase: "port_not_configured" });
      return null;
    }
    if (!(await hasCapability(db, "archive.journalReceiver"))) {
      setJournalReceiverState({ phase: "edition_not_licensed" });
      console.log(
        "[journal] JOURNAL_SMTP_PORT is set, but the installation's edition does not include the archive journal receiver (Business/Service Provider); not starting the listener.",
      );
      return null;
    }
    configureParserPool();
    return startJournalListener({
      config: config.journal,
      production: config.nodeEnv === "production",
      server: {
        providerDb,
        receiverDeps: {
          db,
          keyProvider: keyProvider(),
          retentionPolicyFor: (tenantId) => archiveRetentionPolicyFor(db, tenantId),
        },
      },
      setState: setJournalReceiverState,
      logger: {
        info: (msg, fields) => console.log(`[journal] ${msg}`, fields ?? {}),
        warn: (msg, fields) => console.warn(`[journal] ${msg}`, fields ?? {}),
        error: (msg, fields) => console.error(`[journal] ${msg}`, fields ?? {}),
      },
    });
  },
};
