/**
 * A tenant's journal setup (docs/ARCHIVE.md, journal setup section): the
 * address its Exchange Online journal rule delivers to, the
 * state of the receiver behind it and what has arrived so far. Business and
 * Service Provider (`archive.journalReceiver`).
 *
 * The address is `journal+<token>@<journal host>`. The token lives in
 * `tenants.journal_token` and is what the SMTP receiver resolves at RCPT TO
 * (./recipient.ts), so rotating it stops the old address at the next delivery.
 * The journal host is configuration (`JOURNAL_HOSTNAME`): without it there is
 * no address to hand out, and the page says so instead of inventing one.
 *
 * Creating the token (first view) and rotating it are audited. The token
 * itself never goes into the audit log, only a short fingerprint of it.
 */
import { createHash } from "node:crypto";
import { archiveItems, tenants } from "@restow/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Config } from "../../../../apps/api/src/config.js";
import type { ArchiveActor } from "../../../../apps/api/src/features/archive/service.js";
import { audit } from "../../../../apps/api/src/lib/audit.js";
import {
  type DbExecutor,
  type Transaction,
  withTenantTx,
} from "../../../../apps/api/src/lib/tenant-context.js";
import { ProblemError } from "../../../../apps/api/src/problem.js";
import { type JournalReceiverState, journalReceiverState } from "./receiver-state.js";
import { generateJournalToken, journalLocalPart } from "./recipient.js";

/** Exchange Online delivers journal reports to port 25 of the receiving host, and to no other. */
export const EXCHANGE_SMTP_PORT = 25;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const JOURNAL_AUDIT_ACTIONS = {
  created: "archive.journal.address_created",
  rotated: "archive.journal.address_rotated",
} as const;

/** Why reports cannot arrive right now (the receiver is not listening). */
export type ReceiverReason =
  /** `JOURNAL_SMTP_PORT` is not set. */
  | "port_not_configured"
  /** The license includes the receiver now, but the api started without it. */
  | "restart_required"
  /** The listener could not be created or bound; the api log names the cause. */
  | "listen_failed"
  /** No TLS certificate and key are configured, so the listener was not started (Exchange Online requires TLS). */
  | "tls_not_configured"
  /** The configured certificate or key cannot be used; the api log names the file. */
  | "tls_invalid"
  /** The certificate is expired. */
  | "tls_expired"
  /** No listener has been started in this api process. */
  | "not_started";

/**
 * Where the setup stands, from the point of view of reports arriving:
 * `receiving` (a report within the last 24 hours), `stale` (reports have come,
 * but none for more than 24 hours), `no_reports` (listening, nothing yet),
 * `receiver_down` (the receiver is configured, but nothing can arrive; see
 * `receiver.reason`) and `not_configured` (`JOURNAL_SMTP_PORT` is not set: this
 * installation does not use journaling, which is a normal state and no fault).
 */
export type JournalStatus =
  | "receiving"
  | "stale"
  | "no_reports"
  | "receiver_down"
  | "not_configured";

/** Why there is no full address to show. */
export type HostnameIssue = "missing" | "invalid";

export interface JournalSetupDto {
  /** The complete address for the journal rule; null while no valid journal host is configured. */
  address: string | null;
  /** `journal+<token>`: the part of the address before the `@`. */
  localPart: string;
  /** The journal host (`JOURNAL_HOSTNAME`); null when missing or invalid. */
  hostname: string | null;
  hostnameIssue: HostnameIssue | null;
  status: JournalStatus;
  receiver: {
    listening: boolean;
    reason: ReceiverReason | null;
  };
  /** When the newest journal report was archived; null when none has arrived. */
  lastReportAt: string | null;
  counts: { last24Hours: number; last7Days: number };
  /** What the operator's network and Exchange Online need, from the configuration. */
  requirements: {
    /** The host name to publish in DNS (A/AAAA, or MX to a host that has one). */
    dnsName: string | null;
    /** The port the receiver listens on inside this installation; null when not configured. */
    smtpPort: number | null;
    /** Exchange Online always delivers to this port. */
    exchangePort: number;
    /** The configured port differs from the one Exchange Online uses: forward 25 to it. */
    portMismatch: boolean;
    /**
     * The receiver serves a configured STARTTLS certificate (the connector
     * requires TLS): paths set and the certificate usable and not expired.
     */
    tlsConfigured: boolean;
    /** Largest accepted journal report. */
    maxMessageMegabytes: number;
  };
  /** The operator documentation page of this setup, when the docs location is the public one. */
  docsUrl: string | null;
}

export interface JournalSetupEnvironment {
  journal: Pick<
    Config["journal"],
    "port" | "hostname" | "tlsCertPath" | "tlsKeyPath" | "maxSizeBytes"
  >;
  docsTroubleshootingUrl: string;
  /** What this process's listener is doing; the live state by default. */
  receiverState?: () => JournalReceiverState;
  now?: () => Date;
}

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The configured journal host as a bare lowercase host name, or the reason it
 * cannot be used: empty or unset, or something that is not a host name (an
 * address, a URL with a scheme or path, spaces).
 */
export function normalizeJournalHostname(
  value: string | undefined,
): { hostname: string; issue: null } | { hostname: null; issue: HostnameIssue } {
  const trimmed = (value ?? "").trim().toLowerCase().replace(/\.$/u, "");
  if (trimmed.length === 0) {
    return { hostname: null, issue: "missing" };
  }
  const labels = trimmed.split(".");
  if (trimmed.length > 253 || !labels.every((label) => HOST_LABEL.test(label))) {
    return { hostname: null, issue: "invalid" };
  }
  return { hostname: trimmed, issue: null };
}

/** The complete journal address of a token on a host. */
export function journalAddress(token: string, hostname: string): string {
  return `${journalLocalPart(token)}@${hostname}`;
}

/** Why the receiver is not listening, or null when it is. */
export function receiverReason(
  state: JournalReceiverState,
  port: number | undefined,
): ReceiverReason | null {
  if (!port) {
    return "port_not_configured";
  }
  switch (state.phase) {
    case "listening":
      return null;
    case "edition_not_licensed":
      return "restart_required";
    case "failed":
      return "listen_failed";
    case "tls_not_configured":
    case "tls_invalid":
    case "tls_expired":
      return state.phase;
    default:
      return "not_started";
  }
}

/**
 * The status shown for a receiver state and the newest report. A receiver that
 * was never configured is `not_configured`, not `receiver_down`: only a
 * receiver somebody set up can be down.
 */
export function journalStatus(input: {
  reason: ReceiverReason | null;
  lastReportAt: Date | null;
  now: Date;
}): JournalStatus {
  if (input.reason === "port_not_configured") {
    return "not_configured";
  }
  if (input.reason !== null) {
    return "receiver_down";
  }
  if (input.lastReportAt === null) {
    return "no_reports";
  }
  return input.now.getTime() - input.lastReportAt.getTime() <= DAY_MS ? "receiving" : "stale";
}

/**
 * The page of operator documentation for this setup. The docs location is one
 * setting (`RESTOW_DOCS_TROUBLESHOOTING_URL`); the journal page sits next to
 * its troubleshooting page. An installation that pointed the setting at its
 * own runbook gets no link rather than a wrong one.
 */
export function journalDocsUrl(troubleshootingUrl: string): string | null {
  try {
    const url = new URL(troubleshootingUrl);
    if (!url.pathname.endsWith("/troubleshooting/")) {
      return null;
    }
    url.pathname = url.pathname.replace(/troubleshooting\/$/u, "exchange-journaling/");
    return url.toString();
  } catch {
    return null;
  }
}

/** A short, non-reversible mark of a token for the audit log (never the token itself). */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

async function readToken(tx: Transaction, tenantId: string, lock = false): Promise<string | null> {
  const query = tx
    .select({ journalToken: tenants.journalToken })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  if (!row) {
    throw new ProblemError(404, "Tenant not found");
  }
  return row.journalToken;
}

/**
 * The tenant's token; issues the first one when there is none. Two first views
 * at the same time end with one token: the loser of the conditional update
 * reads the winner's.
 */
async function ensureToken(tx: Transaction, tenantId: string, actor: ArchiveActor) {
  const existing = await readToken(tx, tenantId);
  if (existing !== null) {
    return existing;
  }
  const token = generateJournalToken();
  const [issued] = await tx
    .update(tenants)
    .set({ journalToken: token })
    .where(and(eq(tenants.id, tenantId), sql`${tenants.journalToken} is null`))
    .returning({ journalToken: tenants.journalToken });
  if (!issued) {
    const winner = await readToken(tx, tenantId);
    if (winner === null) {
      throw new Error("journal token could not be issued");
    }
    return winner;
  }
  await auditAddress(tx, tenantId, actor, JOURNAL_AUDIT_ACTIONS.created, token);
  return token;
}

async function auditAddress(
  tx: Transaction,
  tenantId: string,
  actor: ArchiveActor,
  action: string,
  token: string,
) {
  await audit(tx, {
    tenantId,
    actor: actor.label,
    actorUserId: actor.userId,
    action,
    target: tenantId,
    targetType: "tenant",
    ip: actor.ip,
    details: { fingerprint: tokenFingerprint(token) },
  });
}

/** What the archive holds from the journal: the newest report and the recent counts. */
async function journalActivity(tx: Transaction, tenantId: string, now: Date) {
  const [newest] = await tx
    .select({ receivedAt: archiveItems.receivedAt })
    .from(archiveItems)
    .where(and(eq(archiveItems.tenantId, tenantId), eq(archiveItems.capturedVia, "journal")))
    .orderBy(desc(archiveItems.receivedAt))
    .limit(1);
  const since24 = new Date(now.getTime() - DAY_MS);
  const since7 = new Date(now.getTime() - 7 * DAY_MS);
  const [counts] = await tx
    .select({
      last24Hours: sql<number>`count(*) filter (where ${archiveItems.receivedAt} >= ${since24})::int`,
      last7Days: sql<number>`count(*)::int`,
    })
    .from(archiveItems)
    .where(
      and(
        eq(archiveItems.tenantId, tenantId),
        eq(archiveItems.capturedVia, "journal"),
        gte(archiveItems.receivedAt, since7),
      ),
    );
  return {
    lastReportAt: newest?.receivedAt ?? null,
    last24Hours: counts?.last24Hours ?? 0,
    last7Days: counts?.last7Days ?? 0,
  };
}

/** What the operator's network and Exchange Online need, from the configuration. */
function receiverRequirements(
  env: JournalSetupEnvironment,
  hostname: string | null,
  reason: ReceiverReason | null,
): JournalSetupDto["requirements"] {
  const port = env.journal.port ?? null;
  return {
    dnsName: hostname,
    smtpPort: port,
    exchangePort: EXCHANGE_SMTP_PORT,
    portMismatch: port !== null && port !== EXCHANGE_SMTP_PORT,
    tlsConfigured:
      Boolean(env.journal.tlsCertPath && env.journal.tlsKeyPath) &&
      reason !== "tls_invalid" &&
      reason !== "tls_expired",
    maxMessageMegabytes: Math.floor(env.journal.maxSizeBytes / (1024 * 1024)),
  };
}

async function describeSetup(
  tx: Transaction,
  tenantId: string,
  token: string,
  env: JournalSetupEnvironment,
): Promise<JournalSetupDto> {
  const now = (env.now ?? (() => new Date()))();
  const { hostname, issue } = normalizeJournalHostname(env.journal.hostname);
  const reason = receiverReason((env.receiverState ?? journalReceiverState)(), env.journal.port);
  const activity = await journalActivity(tx, tenantId, now);
  return {
    address: hostname === null ? null : journalAddress(token, hostname),
    localPart: journalLocalPart(token),
    hostname,
    hostnameIssue: issue,
    status: journalStatus({ reason, lastReportAt: activity.lastReportAt, now }),
    receiver: { listening: reason === null, reason },
    lastReportAt: activity.lastReportAt?.toISOString() ?? null,
    counts: { last24Hours: activity.last24Hours, last7Days: activity.last7Days },
    requirements: receiverRequirements(env, hostname, reason),
    docsUrl: journalDocsUrl(env.docsTroubleshootingUrl),
  };
}

/** The tenant's journal setup; issues the address on the first call (audited). */
export async function getJournalSetup(
  db: DbExecutor,
  tenantId: string,
  actor: ArchiveActor,
  env: JournalSetupEnvironment,
): Promise<JournalSetupDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const token = await ensureToken(tx, tenantId, actor);
    return describeSetup(tx, tenantId, token, env);
  });
}

/**
 * Issue a new address: the previous one stops working at once, because the
 * receiver resolves the token of every recipient at RCPT TO. Reports Exchange
 * Online still holds for retry go to the old address and are refused; the
 * journal rule must be changed to the new address (the page says so).
 */
export async function rotateJournalAddress(
  db: DbExecutor,
  tenantId: string,
  actor: ArchiveActor,
  env: JournalSetupEnvironment,
): Promise<JournalSetupDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const previous = await readToken(tx, tenantId, true);
    const token = generateJournalToken();
    await tx.update(tenants).set({ journalToken: token }).where(eq(tenants.id, tenantId));
    await auditAddress(
      tx,
      tenantId,
      actor,
      previous === null ? JOURNAL_AUDIT_ACTIONS.created : JOURNAL_AUDIT_ACTIONS.rotated,
      token,
    );
    return describeSetup(tx, tenantId, token, env);
  });
}

/**
 * The receiver as the installation page shows it: the listener of this api
 * process and the configuration behind it, for every tenant at once. It holds
 * no tenant's address and no per-tenant counts.
 *
 * `listening`: reports can arrive. `down`: the receiver is configured, but
 * nothing can arrive (see `receiver.reason`; `restart_required` when a license
 * key that adds the receiver was installed after the api started).
 * `not_configured`: `JOURNAL_SMTP_PORT` is not set, a normal state.
 */
export type JournalReceiverStatus = "listening" | "down" | "not_configured";

export interface JournalReceiverDto {
  state: JournalReceiverStatus;
  receiver: { listening: boolean; reason: ReceiverReason | null };
  /** The journal host (`JOURNAL_HOSTNAME`); null when missing or invalid. */
  hostname: string | null;
  hostnameIssue: HostnameIssue | null;
  requirements: JournalSetupDto["requirements"];
  /** The newest journal report of any tenant; null when none has arrived. */
  lastReportAt: string | null;
  /** Journal reports of all tenants archived in the last 24 hours. */
  last24Hours: number;
  docsUrl: string | null;
}

/** The receiver's state and configuration, with the activity across all tenants. */
export async function getJournalReceiver(
  providerDb: DbExecutor,
  env: JournalSetupEnvironment,
): Promise<JournalReceiverDto> {
  const now = (env.now ?? (() => new Date()))();
  const { hostname, issue } = normalizeJournalHostname(env.journal.hostname);
  const reason = receiverReason((env.receiverState ?? journalReceiverState)(), env.journal.port);
  const since = new Date(now.getTime() - DAY_MS);
  const [activity] = await providerDb
    .select({
      newest: sql<Date | null>`max(${archiveItems.receivedAt})`.mapWith(archiveItems.receivedAt),
      last24Hours:
        sql<number>`count(*) filter (where ${archiveItems.receivedAt} >= ${since})`.mapWith(Number),
    })
    .from(archiveItems)
    .where(eq(archiveItems.capturedVia, "journal"));
  return {
    state:
      reason === null ? "listening" : reason === "port_not_configured" ? "not_configured" : "down",
    receiver: { listening: reason === null, reason },
    hostname,
    hostnameIssue: issue,
    requirements: receiverRequirements(env, hostname, reason),
    lastReportAt: activity?.newest ? activity.newest.toISOString() : null,
    last24Hours: activity?.last24Hours ?? 0,
    docsUrl: journalDocsUrl(env.docsTroubleshootingUrl),
  };
}
