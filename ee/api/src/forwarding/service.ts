/**
 * Forwarded copies into the archive (docs/IMAP.md "Weiterleitung", 0.4.4; Business and
 * Service Provider, `archive.journalReceiver`): the archive address of each IMAP account and
 * what has arrived through it.
 *
 * An account's address is `archive+<token>@<journal host>` (`archive_forward_addresses`):
 * the provider forwards a copy of every mail of the account to it (Postfix
 * `sender_bcc_maps`/`recipient_bcc_maps`, mailcow BCC maps, Sieve `redirect :copy`), and the
 * receiver assigns the copy to exactly that account (../journal/receiver.ts). It is issued
 * when an administrator asks for it (never by reading the page), idempotently, and rotated
 * on request: the old address stops at the next delivery. Like the journal address it is a
 * credential: the audit log gets a short fingerprint, never the token.
 *
 * Domain-wide routing (Google Workspace "Add more recipients", a hoster's `always_bcc`) goes
 * to the tenant's journal address instead; those copies are assigned by their headers. Its
 * activity is reported here as well, but the address is issued by the journal setup only.
 */
import { archiveForwardAddresses, captureKindSql, protectedObjects, tenants } from "@restow/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { ArchiveActor } from "../../../../apps/api/src/features/archive/service.js";
import { audit } from "../../../../apps/api/src/lib/audit.js";
import {
  type DbExecutor,
  isUuid,
  type Transaction,
  withTenantTx,
} from "../../../../apps/api/src/lib/tenant-context.js";
import { ProblemError } from "../../../../apps/api/src/problem.js";
import { type JournalReceiverState, journalReceiverState } from "../journal/receiver-state.js";
import { archiveLocalPart, generateJournalToken, journalLocalPart } from "../journal/recipient.js";
import {
  type HostnameIssue,
  type JournalSetupEnvironment,
  journalDocsUrl,
  normalizeJournalHostname,
  type ReceiverReason,
  receiverReason,
  tokenFingerprint,
} from "../journal/setup.js";

export const FORWARD_AUDIT_ACTIONS = {
  created: "archive.forward.address_created",
  rotated: "archive.forward.address_rotated",
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

/** What has arrived through an address within the last 7 days. */
export interface ForwardActivityDto {
  /** The newest forwarded copy within the last 7 days (an item or a capture row); null when none. */
  lastCopyAt: string | null;
  /** Forwarded copies in the last 24 hours (items and capture rows). */
  last24Hours: number;
  /** Forwarded copies in the last 7 days (items and capture rows). */
  last7Days: number;
}

/**
 * `receiving`: a copy within 24 hours; `stale`: copies within 7 days, none within 24 hours;
 * `no_copies`: an address, but nothing within 7 days; `no_address`: none issued yet.
 */
export type ForwardStatus = "receiving" | "stale" | "no_copies" | "no_address";

/** One IMAP account and its archive address. */
export interface ForwardingAccountDto {
  objectId: string;
  /** The account's login (`protected_objects.external_id`). */
  login: string;
  displayName: string | null;
  sourceId: string;
  sourceName: string;
  captureKind: "imap" | "google" | "imap_microsoft";
  /**
   * A mail job with archive on covers the account and chose the forwarded copy for its
   * kind (`archiveCapture.imap.forward`, or `.google.forward`).
   */
  forwardWanted: boolean;
  /** `archive+<token>@<journal host>`; null without an address or without a valid journal host. */
  address: string | null;
  /** `archive+<token>`; null while no address is issued. */
  localPart: string | null;
  /** When the current address was issued. */
  addressCreatedAt: string | null;
  status: ForwardStatus;
  activity: ForwardActivityDto;
}

/** `GET /api/v1/archive/forwarding`. */
export interface ForwardingDto {
  /** The journal host (`JOURNAL_HOSTNAME`); null when missing or invalid (see `hostnameIssue`). */
  hostname: string | null;
  hostnameIssue: HostnameIssue | null;
  /** Whether the receiver listens in this api process, and why not. */
  receiver: { listening: boolean; reason: ReceiverReason | null };
  /**
   * The tenant's journal address for domain-wide routing (Google Workspace, `always_bcc`);
   * null while the journal setup has not issued one (this route never issues it).
   */
  tenantAddress: string | null;
  /** Plain copies that arrived at the tenant's journal address (source `smtp_forward`). */
  tenantActivity: ForwardActivityDto;
  /** IMAP accounts of the tenant, by login; `nextCursor` continues the list. */
  accounts: ForwardingAccountDto[];
  nextCursor: string | null;
  docsUrl: string | null;
}

export interface ForwardingQuery {
  /** Only accounts whose job chose the forwarded copy. */
  readonly wanted?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ForwardingEnvironment extends JournalSetupEnvironment {
  readonly receiverState?: () => JournalReceiverState;
}

function encodeCursor(login: string, id: string): string {
  return Buffer.from(JSON.stringify([login, id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): { login: string; id: string } | null {
  if (!cursor) {
    return null;
  }
  try {
    const [login, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown[];
    if (typeof login === "string" && typeof id === "string" && isUuid(id)) {
      return { login, id };
    }
  } catch {
    // Falls through to the error below.
  }
  throw new ProblemError(400, "Invalid cursor");
}

function statusOf(address: string | null, activity: ForwardActivityDto, now: Date): ForwardStatus {
  if (address === null) {
    return "no_address";
  }
  if (activity.lastCopyAt === null) {
    return "no_copies";
  }
  return now.getTime() - new Date(activity.lastCopyAt).getTime() <= DAY_MS ? "receiving" : "stale";
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

type AccountRow = {
  object_id: string;
  login: string;
  display_name: string | null;
  source_id: string;
  source_name: string;
  capture_kind: "imap" | "google" | "imap_microsoft";
  forward_wanted: boolean;
  token: string | null;
  address_created_at: Date | string | null;
};

/** The accounts of a page, one statement: kind, whether a job wants forwarding, the address. */
async function accountRows(
  tx: Transaction,
  tenantId: string,
  options: {
    objectId?: string;
    after?: { login: string; id: string } | null;
    limit: number;
    wanted?: boolean;
  },
): Promise<AccountRow[]> {
  const kind = captureKindSql("po", "s");
  const result = await tx.execute<AccountRow>(sql`
    with accounts as (
      select po.id as object_id, po.external_id as login, po.display_name, po.source_id,
             s.name as source_name, ${kind} as capture_kind
        from protected_objects po
        join sources s on s.id = po.source_id
       where po.tenant_id = ${tenantId}::uuid and po.kind = 'imap' and s.kind = 'imap'
         ${options.objectId ? sql`and po.id = ${options.objectId}::uuid` : sql``}
         ${
           options.after
             ? sql`and (po.external_id, po.id) > (${options.after.login}, ${options.after.id}::uuid)`
             : sql``
         }
    ),
    wanted as (
      select a.*,
             exists (
               select 1 from backup_jobs j
                where j.tenant_id = ${tenantId}::uuid and j.kind = 'mail' and j.archive
                  and coalesce((j.archive_capture->(case when a.capture_kind = 'google' then 'google' else 'imap' end)->>'forward')::boolean, false)
                  and (
                    exists (select 1 from backup_job_members m
                             where m.job_id = j.id and m.protected_object_id = a.object_id)
                    or (j.scope_mode = 'all' and not exists (
                          select 1 from backup_job_members m2
                           where m2.protected_object_id = a.object_id and m2.job_id <> j.id))
                  )
             ) as forward_wanted
        from accounts a
    )
    select w.*, fa.token, fa.created_at as address_created_at
      from wanted w
      left join archive_forward_addresses fa
        on fa.protected_object_id = w.object_id and fa.revoked_at is null
     ${options.wanted === undefined ? sql`` : sql`where w.forward_wanted = ${options.wanted}`}
     order by w.login, w.object_id
     limit ${options.limit}
  `);
  return result.rows;
}

/**
 * Forwarded copies per account (or for the tenant address, `null`) within the last 7 days:
 * items and capture rows of source `smtp_forward`, on the (tenant, source, received)
 * indexes.
 */
async function forwardActivity(
  tx: Transaction,
  tenantId: string,
  objectIds: readonly string[],
  now: Date,
): Promise<{ accounts: Map<string, ForwardActivityDto>; tenant: ForwardActivityDto }> {
  const since7 = new Date(now.getTime() - 7 * DAY_MS);
  const since24 = new Date(now.getTime() - DAY_MS);
  const ids = sql`ARRAY[${sql.join(
    (objectIds.length > 0 ? objectIds : ["00000000-0000-0000-0000-000000000000"]).map(
      (id) => sql`${id}`,
    ),
    sql`, `,
  )}]::uuid[]`;
  const result = await tx.execute<{
    object_id: string | null;
    last_at: Date | string | null;
    day: number;
    week: number;
  }>(sql`
    with copies as (
      select protected_object_id, received_at from archive_items
       where tenant_id = ${tenantId}::uuid and captured_via = 'smtp_forward'
         and received_at >= ${since7}
         and (protected_object_id is null or protected_object_id = any(${ids}))
      union all
      select protected_object_id, received_at from archive_item_captures
       where tenant_id = ${tenantId}::uuid and captured_via = 'smtp_forward'
         and received_at >= ${since7}
         and (protected_object_id is null or protected_object_id = any(${ids}))
    )
    select protected_object_id as object_id, max(received_at) as last_at,
           (count(*) filter (where received_at >= ${since24}))::int as day,
           count(*)::int as week
      from copies
     group by protected_object_id
  `);
  const empty: ForwardActivityDto = { lastCopyAt: null, last24Hours: 0, last7Days: 0 };
  const accounts = new Map<string, ForwardActivityDto>();
  let tenant = empty;
  for (const row of result.rows) {
    const activity = {
      lastCopyAt: iso(row.last_at),
      last24Hours: Number(row.day),
      last7Days: Number(row.week),
    };
    if (row.object_id === null) {
      tenant = activity;
    } else {
      accounts.set(row.object_id, activity);
    }
  }
  return { accounts, tenant };
}

function accountDto(
  row: AccountRow,
  activity: ForwardActivityDto | undefined,
  hostname: string | null,
  now: Date,
): ForwardingAccountDto {
  const current = activity ?? { lastCopyAt: null, last24Hours: 0, last7Days: 0 };
  const localPart = row.token ? archiveLocalPart(row.token) : null;
  return {
    objectId: row.object_id,
    login: row.login,
    displayName: row.display_name,
    sourceId: row.source_id,
    sourceName: row.source_name,
    captureKind: row.capture_kind,
    forwardWanted: row.forward_wanted,
    address: localPart && hostname ? `${localPart}@${hostname}` : null,
    localPart,
    addressCreatedAt: iso(row.address_created_at),
    status: statusOf(localPart, current, now),
    activity: current,
  };
}

/** The tenant's forwarding page (never issues an address). */
export async function getForwarding(
  db: DbExecutor,
  tenantId: string,
  query: ForwardingQuery,
  env: ForwardingEnvironment,
): Promise<ForwardingDto> {
  const now = (env.now ?? (() => new Date()))();
  const limit = Math.min(MAX_PAGE, Math.max(1, query.limit ?? DEFAULT_PAGE));
  const after = decodeCursor(query.cursor);
  const { hostname, issue } = normalizeJournalHostname(env.journal.hostname);
  const reason = receiverReason((env.receiverState ?? journalReceiverState)(), env.journal.port);
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await accountRows(tx, tenantId, {
      after,
      limit: limit + 1,
      ...(query.wanted !== undefined ? { wanted: query.wanted } : {}),
    });
    const page = rows.slice(0, limit);
    const activity = await forwardActivity(
      tx,
      tenantId,
      page.map((row) => row.object_id),
      now,
    );
    const [tenant] = await tx
      .select({ journalToken: tenants.journalToken })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const last = page[page.length - 1];
    return {
      hostname,
      hostnameIssue: issue,
      receiver: { listening: reason === null, reason },
      tenantAddress:
        tenant?.journalToken && hostname
          ? `${journalLocalPart(tenant.journalToken)}@${hostname}`
          : null,
      tenantActivity: activity.tenant,
      accounts: page.map((row) =>
        accountDto(row, activity.accounts.get(row.object_id), hostname, now),
      ),
      nextCursor: rows.length > limit && last ? encodeCursor(last.login, last.object_id) : null,
      docsUrl: journalDocsUrl(env.docsTroubleshootingUrl),
    };
  });
}

async function oneAccount(
  tx: Transaction,
  tenantId: string,
  objectId: string,
  hostname: string | null,
  now: Date,
): Promise<ForwardingAccountDto> {
  const [row] = await accountRows(tx, tenantId, { objectId, limit: 1 });
  if (!row) {
    throw new ProblemError(404, "IMAP account not found");
  }
  const activity = await forwardActivity(tx, tenantId, [objectId], now);
  return accountDto(row, activity.accounts.get(objectId), hostname, now);
}

async function requireAccount(tx: Transaction, tenantId: string, objectId: string): Promise<void> {
  if (!isUuid(objectId)) {
    throw new ProblemError(404, "IMAP account not found");
  }
  const [object] = await tx
    .select({ id: protectedObjects.id })
    .from(protectedObjects)
    .where(
      and(
        eq(protectedObjects.tenantId, tenantId),
        eq(protectedObjects.id, objectId),
        eq(protectedObjects.kind, "imap"),
      ),
    )
    .limit(1)
    .for("update");
  if (!object) {
    throw new ProblemError(404, "IMAP account not found");
  }
}

async function auditAddress(
  tx: Transaction,
  tenantId: string,
  objectId: string,
  actor: ArchiveActor,
  action: string,
  token: string,
  previous: string | null = null,
): Promise<void> {
  await audit(tx, {
    tenantId,
    actor: actor.label,
    actorUserId: actor.userId,
    action,
    target: objectId,
    targetType: "protected_object",
    ip: actor.ip,
    details: {
      fingerprint: tokenFingerprint(token),
      ...(previous ? { previousFingerprint: tokenFingerprint(previous) } : {}),
    },
  });
}

async function issue(
  tx: Transaction,
  tenantId: string,
  objectId: string,
  actor: ArchiveActor,
): Promise<string> {
  const token = generateJournalToken();
  await tx.insert(archiveForwardAddresses).values({
    tenantId,
    protectedObjectId: objectId,
    token,
    createdBy: actor.userId,
  });
  return token;
}

/**
 * The account's archive address, issued on the first call (audited
 * `archive.forward.address_created`); later calls return the same one. The account row is
 * locked meanwhile, so two first calls at the same time end with one address.
 */
export async function ensureForwardAddress(
  db: DbExecutor,
  tenantId: string,
  objectId: string,
  actor: ArchiveActor,
  env: ForwardingEnvironment,
): Promise<ForwardingAccountDto> {
  const now = (env.now ?? (() => new Date()))();
  const { hostname } = normalizeJournalHostname(env.journal.hostname);
  return withTenantTx(db, tenantId, async (tx) => {
    await requireAccount(tx, tenantId, objectId);
    const [active] = await tx
      .select({ id: archiveForwardAddresses.id })
      .from(archiveForwardAddresses)
      .where(
        and(
          eq(archiveForwardAddresses.protectedObjectId, objectId),
          isNull(archiveForwardAddresses.revokedAt),
        ),
      )
      .limit(1);
    if (!active) {
      const token = await issue(tx, tenantId, objectId, actor);
      await auditAddress(tx, tenantId, objectId, actor, FORWARD_AUDIT_ACTIONS.created, token);
    }
    return oneAccount(tx, tenantId, objectId, hostname, now);
  });
}

/**
 * Issue a new archive address for the account and revoke the current one (audited
 * `archive.forward.address_rotated`, fingerprints of both): copies the provider still sends
 * to the old address are refused from now on, so the forwarding rule must get the new one.
 */
export async function rotateForwardAddress(
  db: DbExecutor,
  tenantId: string,
  objectId: string,
  actor: ArchiveActor,
  env: ForwardingEnvironment,
): Promise<ForwardingAccountDto> {
  const now = (env.now ?? (() => new Date()))();
  const { hostname } = normalizeJournalHostname(env.journal.hostname);
  return withTenantTx(db, tenantId, async (tx) => {
    await requireAccount(tx, tenantId, objectId);
    const [revoked] = await tx
      .update(archiveForwardAddresses)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(archiveForwardAddresses.protectedObjectId, objectId),
          isNull(archiveForwardAddresses.revokedAt),
        ),
      )
      .returning({ token: archiveForwardAddresses.token });
    const token = await issue(tx, tenantId, objectId, actor);
    await auditAddress(
      tx,
      tenantId,
      objectId,
      actor,
      revoked ? FORWARD_AUDIT_ACTIONS.rotated : FORWARD_AUDIT_ACTIONS.created,
      token,
      revoked?.token ?? null,
    );
    return oneAccount(tx, tenantId, objectId, hostname, now);
  });
}
