/**
 * Archive ingest of an import (docs/IMPORT.md, docs/ARCHIVE.md).
 *
 * When the administrator chose "also archive", every message an import stored
 * becomes an archive item: byte-exact original in the chunk store (the chunks
 * are the ones the snapshot already holds, so nothing is written twice), a
 * sealed item record, a link in the tenant's hash chain and the retention date
 * of the tenant's archive policy. Search finds the messages by subject, body
 * text and addresses; the message's own date is kept in `sent_at`.
 *
 * Retention counts from the capture, which is the import, not from the mail's
 * date: an old letter imported today is kept for the full period from today.
 * The archive states plainly that immutability starts at capture.
 *
 * Idempotent: a message whose hash is already archived for this mailbox is
 * counted as `alreadyArchived` and not written again, so a retried job and a
 * second import of the same mail never duplicate archive items.
 *
 * Every message goes in through the shared archive append (@restow/core
 * archive/append.ts, `PgArchiveAppendStore`): the upload outside the tenant's
 * chain lock, the chain link and the row under it, with the duplicate policy
 * `keep` (every imported message is an item of its own, as before 0.4.4).
 */
import {
  archive,
  ChunkReader,
  JobAbortedError,
  type Logger,
  loadManifest,
  type ManifestObject,
  mailfiles,
  type ProtectedObjectRef,
} from "@restow/core";
import {
  type ArchiveEnvelope,
  archiveEnvelopeRow,
  archiveItems,
  PgArchiveAppendStore,
  retentionPolicies,
} from "@restow/db";
import { and, eq, sql } from "drizzle-orm";
import type { WorkerJobContext } from "./framework.js";
import { withTenantTx } from "./framework.js";

/** The archive policy applied until a tenant sets its own (mirrors apps/api features/archive). */
export const DEFAULT_ARCHIVE_RETENTION: archive.RetentionPolicy = {
  mode: "end_of_year",
  years: 8,
};

export interface ArchiveImportOptions {
  readonly ctx: WorkerJobContext;
  readonly protectedObject: ProtectedObjectRef;
  readonly snapshotId: string;
  readonly logger: Logger;
  /** Called about once a second with how many messages were handled. */
  readonly onProgress?: (done: number, total: number) => void;
}

export function toDbEnvelope(envelope: archive.JournalEnvelope): ArchiveEnvelope {
  return archiveEnvelopeRow(envelope) as ArchiveEnvelope;
}

/** The retention of the tenant's archive (its archive policy, else the default). */
export async function archiveRetentionPolicyFor(
  db: WorkerJobContext["db"],
  tenantId: string,
): Promise<archive.RetentionPolicy> {
  const [row] = await withTenantTx(db, tenantId, (tx) =>
    tx
      .select({ years: retentionPolicies.years, mode: retentionPolicies.mode })
      .from(retentionPolicies)
      .where(
        and(
          eq(retentionPolicies.tenantId, tenantId),
          sql`${retentionPolicies.appliesTo}->>'target' = 'archive'`,
        ),
      )
      .limit(1),
  );
  return row
    ? { mode: row.mode, years: (row.years as archive.RetentionYears | null) ?? null }
    : DEFAULT_ARCHIVE_RETENTION;
}

/** Hashes of the messages already archived for this mailbox by an import. */
async function alreadyArchivedHashes(
  ctx: WorkerJobContext,
  protectedObjectId: string,
): Promise<Set<string>> {
  const rows = await withTenantTx(ctx.db, ctx.tenantId, (tx) =>
    tx
      .select({ itemHash: archiveItems.itemHash })
      .from(archiveItems)
      .where(
        and(
          eq(archiveItems.tenantId, ctx.tenantId),
          eq(archiveItems.protectedObjectId, protectedObjectId),
          eq(archiveItems.capturedVia, "file_import"),
        ),
      ),
  );
  return new Set(rows.map((row) => row.itemHash));
}

/** This run's messages, in manifest order. */
export function messagesOfImport(
  objects: readonly ManifestObject[],
  jobId: string,
): ManifestObject[] {
  return objects.filter(
    (object) => object.type === "message" && object.metadata?.[mailfiles.IMPORT_JOB_META] === jobId,
  );
}

export async function archiveImportedMessages(
  options: ArchiveImportOptions,
): Promise<mailfiles.ImportArchiveReport> {
  const { ctx, protectedObject, logger } = options;
  const record = await ctx.snapshots.get(options.snapshotId);
  if (!record?.manifestPath) {
    throw new Error(`snapshot ${options.snapshotId} has no committed manifest`);
  }
  const manifest = await loadManifest(ctx.storage, record.manifestPath, ctx.keys);
  const messages = messagesOfImport(manifest.objects, ctx.jobId);
  const known = await alreadyArchivedHashes(ctx, protectedObject.id);
  const policy = await archiveRetentionPolicyFor(ctx.db, ctx.tenantId);
  const reader = new ChunkReader({
    storage: ctx.storage,
    keys: ctx.keys,
    index: ctx.chunkIndex,
    logger,
    signal: ctx.signal,
  });

  let ingested = 0;
  let alreadyArchived = 0;
  let failed = 0;
  let lastReport = 0;
  logger.info("archiving imported messages", { messages: messages.length });

  for (const [position, object] of messages.entries()) {
    if (ctx.signal.aborted) {
      throw new JobAbortedError();
    }
    if (object.sha256 !== undefined && known.has(object.sha256)) {
      alreadyArchived++;
    } else {
      try {
        const raw = await reader.readObjectToBuffer(object);
        await ingestOne(ctx, protectedObject, object, raw, policy);
        if (object.sha256 !== undefined) {
          known.add(object.sha256);
        }
        ingested++;
      } catch (error) {
        if (ctx.signal.aborted || error instanceof JobAbortedError) {
          throw new JobAbortedError();
        }
        failed++;
        const ref = object.metadata?.[mailfiles.IMPORT_REF_META] ?? object.path;
        const reason = `could not be archived: ${error instanceof Error ? error.message : String(error)}`;
        ctx.progress.fail(`archive:${ref}`, reason);
        logger.warn("an imported message could not be archived", { path: object.path });
      }
    }
    const now = Date.now();
    if (options.onProgress && now - lastReport >= 1000) {
      lastReport = now;
      options.onProgress(position + 1, messages.length);
    }
  }
  options.onProgress?.(messages.length, messages.length);
  logger.info("archive ingest finished", { ingested, alreadyArchived, failed });
  return { requested: true, ingested, alreadyArchived, failed };
}

async function ingestOne(
  ctx: WorkerJobContext,
  protectedObject: ProtectedObjectRef,
  object: ManifestObject,
  raw: Buffer,
  policy: archive.RetentionPolicy,
): Promise<void> {
  const fields = await mailfiles.extractArchiveFields(raw, { signal: ctx.signal });
  // One chain per tenant: the store takes the same lock the journal receiver takes.
  const store: archive.ArchiveAppendStore = new PgArchiveAppendStore(ctx.db, ctx.tenantId);
  await archive.captureArchiveItem({
    tenantId: ctx.tenantId,
    storage: ctx.storage,
    keys: ctx.keys,
    index: ctx.chunkIndex,
    store,
    original: raw,
    source: "file_import",
    receivedAt: ctx.now(),
    envelope: fields.envelope,
    flags: [],
    messageId: fields.messageId,
    metadata: {
      subject: fields.subject,
      bodyText: fields.bodyText,
      hasAttachment: fields.hasAttachment,
      sentAt: fields.sentAt ?? (object.mtime > 0 ? new Date(object.mtime) : null),
    },
    retentionPolicy: policy,
    protectedObjectId: protectedObject.id,
    duplicates: "keep",
    now: ctx.now,
    logger: ctx.logger,
  });
}
