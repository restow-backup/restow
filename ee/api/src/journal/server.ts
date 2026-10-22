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
 * Recipients (./recipient.ts): the tenant's journal address and, since 0.4.4, the archive
 * addresses of single IMAP accounts. One transaction delivers into one tenant's archive: a
 * recipient of a second tenant is answered 452 (the sender delivers it in a transaction of
 * its own), so a message is never committed for one tenant and retried for another.
 *
 * Limits (in memory, per api process): connections per remote IP per minute
 * (`JOURNAL_RATE_PER_IP`, default 600, answered 421) and deliveries per recipient address
 * per minute (`JOURNAL_RATE_PER_ADDRESS`, default 300, answered 451 at RCPT TO), both high
 * enough for a hoster forwarding the mail of many accounts.
 *
 * Not implemented: SPF verification of the sender (Exchange Online, or the forwarding
 * provider); documented in docs/IMAP.md. The address token is the credential.
 */
import { archive } from "@restow/core";
import type { Database } from "@restow/db";
import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from "smtp-server";
import type { Config } from "../../../../apps/api/src/config.js";
import type { ArchiveDelivery, ArchiveReceipt, JournalReceiverDeps } from "./receiver.js";
import { receiveArchiveMail } from "./receiver.js";
import { type ArchiveRecipient, resolveArchiveRecipient } from "./recipient.js";

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
  readonly config: Pick<Config["journal"], "hostname" | "maxSizeBytes"> &
    Partial<Pick<Config["journal"], "ratePerIp" | "ratePerAddress">>;
  readonly tls: JournalServerTls;
  readonly providerDb: Database;
  readonly receiverDeps: JournalReceiverDeps;
  readonly logger?: {
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
  };
  /** Connections per remote IP (default `config.ratePerIp` per minute); overridable in tests. */
  readonly rateLimiter?: RateLimiter;
  /** Deliveries per recipient address (default `config.ratePerAddress` per minute). */
  readonly addressRateLimiter?: RateLimiter;
  /** Resolve a recipient address to its archive; overridable in tests (default: ./recipient.js). */
  readonly resolveRecipient?: (
    providerDb: Database,
    address: string,
  ) => Promise<ArchiveRecipient | null>;
  /** Process one message to a committed archive entry; overridable in tests (default: ./receiver.js). */
  readonly receive?: (
    delivery: ArchiveDelivery,
    raw: Buffer,
    deps: JournalReceiverDeps,
  ) => Promise<ArchiveReceipt>;
}

export interface RateLimiter {
  /** True when `key` may proceed right now. */
  allow(key: string): boolean;
}

/** Connections per remote IP per minute (`JOURNAL_RATE_PER_IP`). */
export const DEFAULT_RATE_PER_IP = 600;
/** Deliveries per recipient address per minute (`JOURNAL_RATE_PER_ADDRESS`). */
export const DEFAULT_RATE_PER_ADDRESS = 300;

/** Flags of a report that was archived as received because its parse ran over a limit. */
const PARSE_LIMIT_FLAGS: ReadonlySet<string> = new Set([
  "report-parse-timeout",
  "report-parse-memory-limit",
]);

/** A coarse in-memory sliding-window limiter, per remote IP. */
export function createInMemoryRateLimiter(
  limit = DEFAULT_RATE_PER_IP,
  windowMs = 60_000,
  now: () => number = Date.now,
): RateLimiter {
  const hits = new Map<string, number[]>();
  let lastSweep = now();
  return {
    allow(key: string): boolean {
      const cutoff = now() - windowMs;
      if (now() - lastSweep > windowMs) {
        // Forget keys that were quiet for a whole window (many senders, many addresses).
        lastSweep = now();
        for (const [entry, times] of hits) {
          if ((times[times.length - 1] ?? 0) <= cutoff) {
            hits.delete(entry);
          }
        }
      }
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

class TooManyRecipientTenants extends Error {
  readonly responseCode = 452;
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
  const rateLimiter =
    options.rateLimiter ?? createInMemoryRateLimiter(config.ratePerIp ?? DEFAULT_RATE_PER_IP);
  const addressRateLimiter =
    options.addressRateLimiter ??
    createInMemoryRateLimiter(config.ratePerAddress ?? DEFAULT_RATE_PER_ADDRESS);
  const resolveRecipient = options.resolveRecipient ?? resolveArchiveRecipient;
  const receive = options.receive ?? receiveArchiveMail;
  const { tls } = options;
  if (tls.mode === "tls" && (tls.key.length === 0 || tls.cert.length === 0)) {
    throw new Error("the journal receiver needs a non-empty TLS certificate and key");
  }

  /** The current transaction's tenant and accepted recipients, per session. */
  const transactions = new WeakMap<
    SMTPServerSession,
    { tenantId: string; recipients: ArchiveRecipient[]; rcptTo: string[] }
  >();

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
      // A new transaction: the recipients of an earlier one on this connection do not count.
      transactions.delete(session);
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
        const recipient = await resolveRecipient(providerDb, address.address);
        if (!recipient) {
          callback(new RejectedRecipient(`unknown archive address: ${address.address}`));
          return;
        }
        const current = transactions.get(session);
        if (current && current.tenantId !== recipient.tenantId) {
          // One transaction, one archive: the sender retries this recipient on its own.
          callback(
            new TooManyRecipientTenants(
              "4.5.3 one archive per transaction; deliver this recipient separately",
            ),
          );
          return;
        }
        if (!addressRateLimiter.allow(address.address.toLowerCase())) {
          callback(new TemporaryFailure("4.7.1 too many deliveries to this address, try later"));
          return;
        }
        if (current) {
          current.recipients.push(recipient);
          current.rcptTo.push(address.address);
        } else {
          transactions.set(session, {
            tenantId: recipient.tenantId,
            recipients: [recipient],
            rcptTo: [address.address],
          });
        }
        callback();
      } catch (error) {
        logger?.error("journal RCPT TO lookup failed", { errorMessage: String(error) });
        callback(new TemporaryFailure("could not verify the journal address"));
      }
    },

    async onData(stream, session, callback) {
      const transaction = transactions.get(session);
      transactions.delete(session);
      if (!transaction) {
        callback(new RejectedRecipient("no accepted journal recipient for this message"));
        return;
      }
      const { tenantId } = transaction;
      try {
        const raw = await readStream(stream, config.maxSizeBytes);
        const mailFrom = session.envelope.mailFrom;
        const record = await receive(
          {
            tenantId,
            recipients: transaction.recipients,
            mailFrom: mailFrom ? mailFrom.address || null : null,
            rcptTo: transaction.rcptTo,
          },
          raw,
          receiverDeps,
        );
        logger?.info(
          record.kind === "journal_report" ? "journal report archived" : "forwarded copy archived",
          {
            tenantId,
            itemId: record.itemId,
            outcome: record.outcome,
            flags: record.flags,
          },
        );
        if (record.flags.some((flag) => PARSE_LIMIT_FLAGS.has(flag))) {
          // The reason and the size, never a header or a line of the report.
          logger?.warn(
            "a message could not be parsed within the parser's time or memory limit; archived byte for byte without its details",
            { tenantId, itemId: record.itemId, flags: record.flags, bytes: raw.length },
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
