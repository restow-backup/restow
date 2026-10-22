/**
 * The Postgres side of an archive append (@restow/core archive/append.ts
 * `captureArchiveItem`): the tenant's chain lock, the chain tip, the items that may be
 * the same mail, and the rows an append writes (the item, further captures, mailbox
 * assignments). Shaped to core's `ArchiveAppendStore` interface without importing core
 * (this package depends on nothing of Restow); the worker and the API check the match at
 * compile time where they hand it over.
 *
 * Every query runs in a transaction pinned to the tenant (Row Level Security,
 * sql/rls.sql) on the pool it is given, normally the application pool. The chain lock is
 * the transaction-scoped advisory lock `archive-chain:<tenant>` that the journal receiver
 * and the import took before 0.4.4 as well, so all writers serialize on the same key.
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { archiveItemCaptures, archiveItems } from "./schema/archive.js";

/** Runs statements: a database or an open transaction. */
export type ArchiveExecutor = Pick<NodePgDatabase<Record<string, unknown>>, "execute">;

/** What the store needs of a database: transactions whose handle can insert. */
export interface ArchiveTransactional {
  // biome-ignore lint/suspicious/noExplicitAny: any drizzle node-postgres database (any schema)
  transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The advisory lock key of a tenant's archive chain (every writer takes this one). */
export function archiveChainLockKey(tenantId: string): string {
  return `archive-chain:${tenantId}`;
}

// --- shapes of @restow/core archive (structural, see the module docstring) ---

type Source = "journal" | "graph_sync" | "imap_sync" | "file_import" | "smtp_forward";

interface CoreEnvelope {
  readonly sender: string | null;
  readonly recipients: readonly { readonly address: string; readonly type: "to" | "cc" | "bcc" }[];
}

interface CoreRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly receivedAt: Date;
  readonly itemHash: string;
  readonly prevChainHash: string | null;
  readonly chainHash: string;
  readonly size: number;
  readonly chunks: readonly string[];
  readonly envelope: CoreEnvelope | null;
  readonly flags: readonly string[];
  readonly source: Source;
  readonly retentionUntil: Date | null;
  readonly createdAt: Date;
}

export interface ArchiveAppendItemRow {
  readonly record: CoreRecord;
  readonly storagePath: string;
  readonly protectedObjectId: string | null;
  readonly messageId: string | null;
  readonly subject: string | null;
  readonly bodyText: string | null;
  readonly hasAttachment: boolean;
  readonly sentAt: Date | null;
  readonly bodyHash: string;
  readonly externalRef: string | null;
  readonly supersedesItemId: string | null;
}

export interface ArchiveAppendCaptureRow {
  readonly tenantId: string;
  readonly archiveItemId: string;
  readonly source: Source;
  readonly protectedObjectId: string | null;
  readonly itemHash: string;
  readonly externalRef: string | null;
  readonly receivedAt: Date;
  readonly flags: readonly string[];
}

export interface ArchiveAppendCandidate {
  readonly id: string;
  readonly source: Source;
  readonly itemHash: string;
  readonly bodyHash: string | null;
  readonly messageKey: string | null;
}

export interface ArchiveAppendQuery {
  readonly itemHash: string;
  readonly messageKey: string | null;
}

export interface ArchiveAppendAssignment {
  readonly objectIds?: readonly string[];
  readonly addresses?: readonly string[];
}

/** The envelope as `archive_items.envelope` stores it (from, to, cc, bcc, recipients). */
export function archiveEnvelopeRow(envelope: CoreEnvelope | null) {
  if (!envelope) {
    return null;
  }
  const to: string[] = [];
  const cc: string[] = [];
  const bcc: string[] = [];
  const recipients: string[] = [];
  for (const recipient of envelope.recipients) {
    recipients.push(recipient.address);
    (recipient.type === "to" ? to : recipient.type === "cc" ? cc : bcc).push(recipient.address);
  }
  return { from: envelope.sender ?? undefined, to, cc, bcc, recipients };
}

/** Most candidates looked at per capture: a Message-ID shared by more mails is spam. */
const MAX_CANDIDATES = 50;

async function candidatesOn(
  tx: ArchiveExecutor,
  tenantId: string,
  query: ArchiveAppendQuery,
): Promise<ArchiveAppendCandidate[]> {
  // Two index scans (item hash, message key), oldest first.
  const result = await tx.execute<{
    id: string;
    captured_via: Source;
    item_hash: string;
    body_hash: string | null;
    message_key: string | null;
  }>(sql`
    select id, captured_via, item_hash, body_hash, lower(btrim(message_id, '<> ')) as message_key
      from archive_items
     where tenant_id = ${tenantId}::uuid
       and (item_hash = ${query.itemHash}
            ${query.messageKey !== null ? sql`or lower(btrim(message_id, '<> ')) = ${query.messageKey}` : sql``})
     order by created_at, id
     limit ${MAX_CANDIDATES}
  `);
  return result.rows.map((row) => ({
    id: row.id,
    source: row.captured_via,
    itemHash: row.item_hash,
    bodyHash: row.body_hash,
    messageKey: row.message_key === "" ? null : row.message_key,
  }));
}

/**
 * Assign the archive item `itemId` to the tenant's mailboxes the ids or addresses name,
 * never to the item's own mailbox (`archive_items.protected_object_id`). Addresses are
 * compared lowercase with a Microsoft 365 owner's primary address, UPN and every SMTP alias
 * (`users.mail_addresses`), and an IMAP account by its login. Runs inside the caller's
 * tenant-pinned transaction (Row Level Security keeps it to the tenant). Returns how many
 * assignments it added.
 */
export async function assignArchiveItemMailboxes(
  tx: ArchiveExecutor,
  tenantId: string,
  itemId: string,
  addresses: readonly string[],
  objectIds: readonly string[] = [],
): Promise<number> {
  const ids = objectIds.filter((id) => UUID.test(id));
  if (addresses.length === 0 && ids.length === 0) {
    return 0;
  }
  const list = sql`ARRAY[${sql.join(
    (addresses.length > 0 ? addresses : [""]).map((address) => sql`${address}`),
    sql`, `,
  )}]::text[]`;
  const idList = sql`ARRAY[${sql.join(
    (ids.length > 0 ? ids : ["00000000-0000-0000-0000-000000000000"]).map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
  const result = await tx.execute(sql`
    insert into archive_item_mailboxes (tenant_id, archive_item_id, protected_object_id)
    select ${tenantId}::uuid, ${itemId}::uuid, po.id
      from protected_objects po
      left join users u on u.id = po.user_id
     where po.tenant_id = ${tenantId}::uuid
       and po.id is distinct from (
         select ai.protected_object_id from archive_items ai where ai.id = ${itemId}::uuid
       )
       and (
         po.id = any(${idList})
         or (po.kind = 'mailbox' and u.id is not null and (
            lower(u.email) = any(${list})
            or lower(u.upn) = any(${list})
            or u.mail_addresses && ${list}
         ))
         or (po.kind = 'imap' and lower(po.external_id) = any(${list}))
       )
    on conflict do nothing
  `);
  return result.rowCount ?? 0;
}

/** Which of a mailbox's mails a capture way has already captured, by where it found them. */
export async function capturedExternalRefs(
  tx: ArchiveExecutor,
  protectedObjectId: string,
  externalRefs: readonly string[],
): Promise<Set<string>> {
  if (externalRefs.length === 0) {
    return new Set();
  }
  const refs = sql`ARRAY[${sql.join(
    externalRefs.map((ref) => sql`${ref}`),
    sql`, `,
  )}]::text[]`;
  const result = await tx.execute<{ external_ref: string }>(sql`
    select external_ref from archive_items
     where protected_object_id = ${protectedObjectId}::uuid and external_ref = any(${refs})
    union
    select external_ref from archive_item_captures
     where protected_object_id = ${protectedObjectId}::uuid and external_ref = any(${refs})
  `);
  return new Set(result.rows.map((row) => row.external_ref));
}

/**
 * Which Message-IDs (as `messageKey` normalizes them) the archive already holds for a
 * mailbox: as its own item, assigned to it, or captured for it.
 */
export async function capturedMessageKeys(
  tx: ArchiveExecutor,
  tenantId: string,
  protectedObjectId: string,
  messageKeys: readonly string[],
): Promise<Set<string>> {
  if (messageKeys.length === 0) {
    return new Set();
  }
  const keys = sql`ARRAY[${sql.join(
    messageKeys.map((key) => sql`${key}`),
    sql`, `,
  )}]::text[]`;
  const result = await tx.execute<{ message_key: string }>(sql`
    select lower(btrim(ai.message_id, '<> ')) as message_key
      from archive_items ai
     where ai.tenant_id = ${tenantId}::uuid
       and lower(btrim(ai.message_id, '<> ')) = any(${keys})
       and (
         ai.protected_object_id = ${protectedObjectId}::uuid
         or exists (select 1 from archive_item_mailboxes aim
                     where aim.archive_item_id = ai.id
                       and aim.protected_object_id = ${protectedObjectId}::uuid)
         or exists (select 1 from archive_item_captures aic
                     where aic.archive_item_id = ai.id
                       and aic.protected_object_id = ${protectedObjectId}::uuid)
       )
  `);
  return new Set(result.rows.map((row) => row.message_key));
}

/** The session core's `captureArchiveItem` works in while the chain lock is held. */
class PgArchiveChainSession {
  constructor(
    // biome-ignore lint/suspicious/noExplicitAny: a drizzle transaction of any schema
    private readonly tx: any,
    private readonly tenantId: string,
  ) {}

  async tip(): Promise<{ chainHash: string; createdAt: Date } | null> {
    const result = await (this.tx as ArchiveExecutor).execute<{
      chain_hash: string;
      created_ms: string;
    }>(sql`
      select chain_hash, ceil(extract(epoch from created_at) * 1000)::bigint::text as created_ms
        from archive_items
       where tenant_id = ${this.tenantId}::uuid
       order by created_at desc, id desc
       limit 1
    `);
    const row = result.rows[0];
    return row ? { chainHash: row.chain_hash, createdAt: new Date(Number(row.created_ms)) } : null;
  }

  candidates(query: ArchiveAppendQuery): Promise<ArchiveAppendCandidate[]> {
    return candidatesOn(this.tx, this.tenantId, query);
  }

  async insertItem(item: ArchiveAppendItemRow): Promise<void> {
    const { record } = item;
    await this.tx.insert(archiveItems).values({
      id: record.id,
      tenantId: record.tenantId,
      protectedObjectId: item.protectedObjectId,
      messageId: item.messageId ?? record.id,
      itemHash: record.itemHash,
      prevChainHash: record.prevChainHash,
      chainHash: record.chainHash,
      receivedAt: record.receivedAt,
      capturedVia: record.source,
      retentionUntil: record.retentionUntil,
      storagePath: item.storagePath,
      // An item with a retention date; not proof that the target enforced Object Lock.
      objectLock: record.retentionUntil !== null,
      subject: item.subject,
      sizeBytes: record.size,
      envelope: archiveEnvelopeRow(record.envelope),
      chunks: [...record.chunks],
      flags: [...record.flags],
      bodyText: item.bodyText,
      hasAttachment: item.hasAttachment,
      sentAt: item.sentAt,
      bodyHash: item.bodyHash,
      externalRef: item.externalRef,
      supersedesItemId: item.supersedesItemId,
      createdAt: record.createdAt,
    });
  }

  async insertCapture(capture: ArchiveAppendCaptureRow): Promise<void> {
    await this.tx.insert(archiveItemCaptures).values({
      tenantId: capture.tenantId,
      archiveItemId: capture.archiveItemId,
      capturedVia: capture.source,
      protectedObjectId: capture.protectedObjectId,
      itemHash: capture.itemHash,
      externalRef: capture.externalRef,
      receivedAt: capture.receivedAt,
      flags: [...capture.flags],
    });
  }

  assignMailboxes(itemId: string, assignment: ArchiveAppendAssignment): Promise<number> {
    return assignArchiveItemMailboxes(
      this.tx,
      this.tenantId,
      itemId,
      (assignment.addresses ?? []).map((address) => address.trim().toLowerCase()),
      assignment.objectIds ?? [],
    );
  }
}

/** core's `ArchiveAppendStore` for one tenant, on Postgres (see the module docstring). */
export class PgArchiveAppendStore {
  constructor(
    private readonly db: ArchiveTransactional,
    readonly tenantId: string,
  ) {
    if (!UUID.test(tenantId)) {
      throw new TypeError("tenantId must be a UUID");
    }
  }

  candidates(query: ArchiveAppendQuery): Promise<ArchiveAppendCandidate[]> {
    return this.inTenant((tx) => candidatesOn(tx, this.tenantId, query));
  }

  withChainLock<T>(fn: (session: PgArchiveChainSession) => Promise<T>): Promise<T> {
    return this.inTenant(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${archiveChainLockKey(this.tenantId)}))`,
      );
      return fn(new PgArchiveChainSession(tx, this.tenantId));
    });
  }

  // biome-ignore lint/suspicious/noExplicitAny: a drizzle transaction of any schema
  private inTenant<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${this.tenantId}, true)`);
      return fn(tx);
    });
  }
}
