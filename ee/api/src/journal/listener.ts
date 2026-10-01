import type { Config } from "../../../../apps/api/src/config.js";
import type { JournalReceiverState } from "./receiver-state.js";
import { type JournalServerOptions, createJournalServer } from "./server.js";
import {
  type JournalCertificateWatcher,
  type JournalLogger,
  type JournalTlsPlan,
  type ReadFile,
  planJournalTls,
  watchJournalCertificate,
} from "./tls.js";

export interface JournalListenerOptions {
  readonly config: Pick<
    Config["journal"],
    "port" | "hostname" | "maxSizeBytes" | "tlsCertPath" | "tlsKeyPath" | "allowInsecure"
  >;
  /** NODE_ENV=production, which is what the release image runs with; only changes what is logged. */
  readonly production: boolean;
  /** Everything the server needs besides the configuration, the TLS mode and the logger. */
  readonly server: Omit<JournalServerOptions, "config" | "tls" | "logger">;
  readonly setState: (state: JournalReceiverState) => void;
  readonly logger: JournalLogger & { warn(msg: string, fields?: Record<string, unknown>): void };
  readonly now?: () => Date;
  readonly read?: ReadFile;
  /** How often the certificate files are checked for a renewal; see ./tls.ts. */
  readonly certificateCheckIntervalMs?: number;
}

/** The receiver state for a plan that does not start a listener. */
function refusedState(plan: Extract<JournalTlsPlan, { start: false }>): JournalReceiverState {
  return plan.reason === "tls_not_configured"
    ? { phase: "tls_not_configured" }
    : { phase: plan.reason, message: plan.message };
}

/**
 * Start the journal listener once the port is configured and the edition
 * includes the receiver (./service.ts checks both). TLS is decided first
 * (./tls.ts): without a usable certificate, and without the explicit insecure
 * opt-out, the port is not opened at all. The state the setup page shows is
 * recorded here for every outcome.
 *
 * Resolves once the port is bound (a failure to bind is recorded as `failed`),
 * with a handle that stops the listener; null when none was started.
 */
export async function startJournalListener(
  options: JournalListenerOptions,
): Promise<{ close(): void } | null> {
  const { config, logger, setState } = options;
  const port = config.port;
  if (port === undefined) {
    throw new Error("startJournalListener needs JOURNAL_SMTP_PORT");
  }
  const plan = planJournalTls({
    tlsCertPath: config.tlsCertPath,
    tlsKeyPath: config.tlsKeyPath,
    allowInsecure: config.allowInsecure,
    now: (options.now ?? (() => new Date()))(),
    read: options.read,
  });
  if (!plan.start) {
    setState(refusedState(plan));
    logger.error(`${plan.message}; the listener is not started`, {
      hint: "Provide a certificate and key, or set JOURNAL_ALLOW_INSECURE=true for local development only.",
    });
    return null;
  }
  if (plan.mode === "insecure") {
    logger.warn(
      options.production
        ? "JOURNAL_ALLOW_INSECURE=true in a production environment: the receiver offers no STARTTLS and accepts mail in plain text. Exchange Online requires TLS and will not deliver. Never run a real installation like this."
        : "JOURNAL_ALLOW_INSECURE=true: the receiver offers no STARTTLS and accepts mail in plain text. For local development only.",
    );
  }

  let server: ReturnType<typeof createJournalServer>;
  try {
    server = createJournalServer({
      ...options.server,
      config,
      logger,
      tls:
        plan.mode === "tls"
          ? { mode: "tls", key: plan.material.key, cert: plan.material.cert }
          : { mode: "insecure" },
    });
  } catch (error) {
    setState({ phase: "failed", message: error instanceof Error ? error.message : String(error) });
    throw error;
  }

  const bound = await new Promise<boolean>((resolve) => {
    server.on("error", (error) => {
      logger.error(`server error: ${error.message}`);
      // smtp-server re-emits errors of single connections (a client that drops
      // in the middle of the TLS handshake, a scanner) as server errors and
      // marks them with the remote address; they say nothing about the listener.
      if ((error as { remoteAddress?: string }).remoteAddress === undefined) {
        setState({ phase: "failed", message: error.message });
        resolve(false);
      }
    });
    server.listen(port, () => {
      setState({ phase: "listening", port });
      logger.info(
        plan.mode === "tls"
          ? `Restow archive journal receiver listening on port ${port} (TLS required, certificate valid until ${plan.material.notAfter.toISOString()})`
          : `Restow archive journal receiver listening on port ${port} (no TLS)`,
      );
      resolve(true);
    });
  });

  let watcher: JournalCertificateWatcher | undefined;
  if (bound && plan.mode === "tls" && config.tlsCertPath && config.tlsKeyPath) {
    watcher = watchJournalCertificate({
      paths: { certPath: config.tlsCertPath, keyPath: config.tlsKeyPath },
      initial: plan.material,
      apply: (material) => server.updateSecureContext({ key: material.key, cert: material.cert }),
      onStatus: (status) =>
        setState(
          status.ok
            ? { phase: "listening", port }
            : { phase: status.reason, message: status.message },
        ),
      intervalMs: options.certificateCheckIntervalMs,
      now: options.now,
      read: options.read,
      logger,
    });
  }
  return {
    close: () => {
      watcher?.stop();
      server.close();
      setState({ phase: "stopped" });
    },
  };
}
