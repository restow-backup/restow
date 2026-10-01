/**
 * The archive journal SMTP receiver (docs/IMAP.md, journal receiver section;
 * docs/ARCHITECTURE.md: runs inside the `api` role, not a separate Docker
 * role or CMD). Listens on `JOURNAL_SMTP_PORT`, STARTTLS with an
 * operator-supplied certificate, and accepts mail only for known per-tenant
 * journal addresses (RCPT TO, see ./recipient.ts) — everything else is
 * rejected before a message body is ever read. No relay: outbound sending is
 * never possible through this listener (there is no `onMailFrom` sender
 * allowlist beyond "connection accepted"; nothing here ever originates mail).
 *
 * TLS (./tls.ts decides which mode applies before a server is built): with a
 * certificate, plain-text sessions are refused at MAIL FROM with 530 until the
 * client has issued STARTTLS, because Exchange Online's connector always uses
 * TLS. Without one (the explicit development opt-out only), STARTTLS is not
 * offered at all. smtp-server's built-in test certificate is never used: its
 * private key is public, so "encrypted" sessions with it would protect
 * nothing while looking as if they did.
 *
 * Reply contract: 250 only after {@link receiveJournalReport} has durably
 * committed the item (storage write, chunk index, database row); any
 * failure there is answered 451 so Exchange Online retries the delivery
 * (docs/IMAP.md). A message this server itself refuses to accept (unknown
 * recipient, oversized) is rejected earlier, at RCPT TO or in `onData`,
 * before {@link receiveJournalReport} is ever called. A report that arrives
 * while every parser process is busy and the queue is full is answered 451
 * as well ("busy"); one that cannot be parsed within the parser's limits is
 * archived as received and logged with its flags and size, never with its
 * content (./receiver.ts).
 *
 * Not implemented yet: SPF verification of the sending Exchange Online tenant
 * and per-sender-IP rate limiting beyond the coarse in-memory limiter below.
 * Both are noted in docs/IMAP.md as hardening for a production journal
 * receiver and are left for a later release rather than shipped half-built.
 */
import { archive } from "@restow/core";
import type { Database } from "@restow/db";
import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from "smtp-server";
import type { Config } from "../../../../apps/api/src/config.js";
import type { JournalReceiverDeps } from "./receiver.js";
import { receiveJournalReport } from "./receiver.js";
import { tenantIdForJournalAddress } from "./recipient.js";

/**
 * How the server handles TLS; required, so a server can never be built without
 * a decision (and so never falls back to smtp-server's built-in certificate).
 */
export type JournalServerTls =
  /** STARTTLS with this certificate and key, and required before MAIL FROM. */
  | { readonly mode: "tls"; readonly key: Buffer; readonly cert: Buffer }
  /** No STARTTLS at all; plain text only (local development and the smoke). */
  | { readonly mode: "insecure" };

export interface JournalServerOptions {
  readonly config: Pick<Config["journal"], "hostname" | "maxSizeBytes">;
  readonly tls: JournalServerTls;
  readonly providerDb: Database;
  readonly receiverDeps: JournalReceiverDeps;
  readonly logger?: {
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
  };
  /** Simple per-remote-IP token bucket; overridable in tests. */
  readonly rateLimiter?: RateLimiter;
  /** Resolve a recipient address to a tenant id; overridable in tests (default: ./recipient.js). */
  readonly resolveTenant?: (providerDb: Database, address: string) => Promise<string | null>;
  /** Process one report to a committed archive item; overridable in tests (default: ./receiver.js). */
  readonly receive?: (
    tenantId: string,
    raw: Buffer,
    deps: JournalReceiverDeps,
  ) => Promise<archive.ArchiveItemRecord>;
}

export interface RateLimiter {
  /** True when `key` may proceed right now. */
  allow(key: string): boolean;
}

const MAX_DELIVERIES_PER_MINUTE = 60;

/** Flags of a report that was archived as received because its parse ran over a limit. */
const PARSE_LIMIT_FLAGS: ReadonlySet<string> = new Set([
  "report-parse-timeout",
  "report-parse-memory-limit",
]);

/** A coarse in-memory sliding-window limiter, per remote IP. */
export function createInMemoryRateLimiter(
  limit = MAX_DELIVERIES_PER_MINUTE,
  windowMs = 60_000,
  now: () => number = Date.now,
): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    allow(key: string): boolean {
      const cutoff = now() - windowMs;
      const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now());
      hits.set(key, recent);
      return true;
    },
  };
}

class RejectedRecipient extends Error {
  readonly responseCode = 550;
}

class TemporaryFailure extends Error {
  readonly responseCode = 451;
}

class TlsRequired extends Error {
  readonly responseCode = 530;
}

class TooManyRequests extends Error {
  readonly responseCode = 421;
}

class MessageTooLarge extends Error {
  readonly responseCode = 552;
}

async function readStream(stream: SMTPServerDataStream, maxSizeBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += (chunk as Buffer).length;
    if (total > maxSizeBytes) {
      throw new MessageTooLarge("message exceeds the configured journal size limit");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Build the (unstarted) SMTP server; call `.listen(port)` to start it. */
export function createJournalServer(options: JournalServerOptions): SMTPServer {
  const { config, providerDb, receiverDeps, logger } = options;
  const rateLimiter = options.rateLimiter ?? createInMemoryRateLimiter();
  const resolveTenant = options.resolveTenant ?? tenantIdForJournalAddress;
  const receive = options.receive ?? receiveJournalReport;
  const { tls } = options;
  if (tls.mode === "tls" && (tls.key.length === 0 || tls.cert.length === 0)) {
    throw new Error("the journal receiver needs a non-empty TLS certificate and key");
  }

  const resolvedTenants = new WeakMap<SMTPServerSession, string>();

  return new SMTPServer({
    banner: config.hostname ?? "restow-archive",
    secure: false, // STARTTLS on the plain port, never implicit TLS.
    authOptional: true,
    size: config.maxSizeBytes,
    ...(tls.mode === "tls"
      ? {
          key: tls.key,
          cert: tls.cert,
          // smtp-server defaults to TLS 1.0 for old clients; Exchange Online speaks 1.2 and newer.
          minVersion: "TLSv1.2" as const,
          disabledCommands: ["AUTH"],
        }
      : {
          // No certificate: do not offer STARTTLS, and answer the command as unknown.
          hideSTARTTLS: true,
          disabledCommands: ["AUTH", "STARTTLS"],
        }),

    onConnect(session, callback) {
      if (!rateLimiter.allow(session.remoteAddress)) {
        callback(new TooManyRequests("too many journal deliveries from this address"));
        return;
      }
      callback();
    },

    onMailFrom(_address, session, callback) {
      // Exchange Online's connector always uses TLS: a session that has not
      // upgraded with STARTTLS yet is refused here, before a recipient or a
      // body is ever looked at.
      if (tls.mode === "tls" && !session.secure) {
        callback(new TlsRequired("Must issue a STARTTLS command first"));
        return;
      }
      // No sender allowlist beyond the recipient check: this listener never
      // relays, so accepting any MAIL FROM here cannot be used to send mail
      // through Restow. SPF verification of the Exchange Online tenant is a
      // documented limitation (see the module docstring).
      callback();
    },

    async onRcptTo(address, session, callback) {
      try {
        const tenantId = await resolveTenant(providerDb, address.address);
        if (!tenantId) {
          callback(new RejectedRecipient(`unknown journal address: ${address.address}`));
          return;
        }
        resolvedTenants.set(session, tenantId);
        callback();
      } catch (error) {
        logger?.error("journal RCPT TO lookup failed", { errorMessage: String(error) });
        callback(new TemporaryFailure("could not verify the journal address"));
      }
    },

    async onData(stream, session, callback) {
      const tenantId = resolvedTenants.get(session);
      if (!tenantId) {
        callback(new RejectedRecipient("no accepted journal recipient for this message"));
        return;
      }
      try {
        const raw = await readStream(stream, config.maxSizeBytes);
        const record = await receive(tenantId, raw, receiverDeps);
        logger?.info("journal report archived", {
          tenantId,
          itemId: record.id,
          flags: record.flags,
        });
        if (record.flags.some((flag) => PARSE_LIMIT_FLAGS.has(flag))) {
          // The reason and the size, never a header or a line of the report.
          logger?.warn(
            "journal report could not be parsed within the parser's time or memory limit; archived byte for byte without its details",
            { tenantId, itemId: record.id, flags: record.flags, bytes: raw.length },
          );
        }
        callback(null, "accepted");
      } catch (error) {
        if (error instanceof archive.JournalParserBusyError) {
          logger?.warn(
            "journal report not accepted: every parser process is busy; asked to retry",
            {
              tenantId,
            },
          );
          callback(new TemporaryFailure("journal receiver busy, try again later"));
          return;
        }
        // Anything here (storage, database, an unexpected parser failure)
        // means the item is NOT durably committed: reply so Exchange
        // retries, never 250 (see the module docstring's durability contract).
        logger?.error("journal report could not be archived; will retry", {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        callback(
          error instanceof MessageTooLarge ? error : new TemporaryFailure("archive write failed"),
        );
      }
    },
  });
}
