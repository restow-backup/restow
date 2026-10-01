/**
 * The `export` queue handler: mail from a backup snapshot, an imported mailbox
 * or the archive as an EML ZIP, an MBOX or an MSG ZIP (docs/IMPORT.md).
 *
 * The API records an export as a `mail_exports` row (origin, format, selection,
 * actor) plus a `jobs` row and enqueues `{ exportId, protectedObjectId? }`. The
 * handler resolves the messages (snapshots exactly like a download restore,
 * archive items from the tenant's archive table), hands them to the core
 * writers (packages/core/src/mailfiles/export/) and writes the produced stream
 * as sealed segments into the tenant's storage
 * (tenants/<tid>/exports/<id>/). Nothing is buffered whole: one message is in
 * flight at a time, and a segment is a few MiB. The finished file expires
 * EXPORT_TTL_HOURS (default 24) after completion; the cleanup task deletes it.
 *
 * Only mail is exported. Calendar items, contacts and messages without an
 * original file are counted in the report, never hidden.
 *
 * The export files of a tenant may take EXPORT_MAX_TENANT_BYTES together. A run starts with what
 * is left of that, stops writing when its file would go beyond it (the partial file is deleted)
 * and, as the last step under a lock, checks the total again before it records the file, so
 * two exports that finish together cannot both slip in. The run then fails without a retry with
 * the failure `export.quota_exceeded`.
 *
 * Environment:
 *   EXPORT_TTL_HOURS            how long a finished export can be downloaded (default 24)
 *   EXPORT_MAX_TENANT_BYTES     bytes all export files of a tenant may take (default 50 GiB)
 */
import {
  ChunkReader,
  JobAbortedError,
  type ProtectedObjectRef,
  type RestoreSelection,
  buildCause,
  mailfiles,
} from "@restow/core";
import {
  type MailExport,
  archiveItems,
  mailExports,
  protectedObjects,
  safeErrorMessage,
} from "@restow/db";
import { type SQL, and, asc, eq, inArray, sql } from "drizzle-orm";
import type { TenantTxRunner } from "../progress.js";
import { PhaseRecorder, RESULT_KEY, mergeJobPayload } from "./backup.js";
import {
  InvalidPayloadError,
  type JobHandler,
  type JobOutcome,
  type WorkerJobContext,
  isUuid,
  tenantRunner,
} from "./framework.js";
import { parseStoredSelection } from "./restore.js";

type Env = Record<string, string | undefined>;

export const DEFAULT_EXPORT_TTL_HOURS = 24;
export const DEFAULT_EXPORT_MAX_TENANT_BYTES = 50 * 1024 * 1024 * 1024;
const MAX_REPORT_ITEMS = 500;
const ARCHIVE_PAGE = 500;

// ---------------------------------------------------------------------------
// Archive selection
// ---------------------------------------------------------------------------

/** The archive search filter an export may carry (mirrors apps/api features/archive/schemas.ts). */
export interface ArchiveExportFilter {
  q?: string;
  mailbox?: string;
  from?: string;
  dateFrom?: string;
  dateTo?: string;
  hasAttachment?: boolean;
}

export interface ArchiveExportSelection {
  itemIds?: string[];
  filter?: ArchiveExportFilter;
}

export interface ArchiveRow {
  id: string;
  subject: string | null;
  itemHash: string;
  sizeBytes: number | null;
  chunks: string[] | null;
  receivedAt: Date;
  sentAt: Date | null;
  messageId: string;
  envelope: { from?: string; to?: string[] } | null;
  protectedObjectId: string | null;
}

/** The archive rows an export covers, in a stable order, page by page. */
export interface ExportStore {
  loadExport(exportId: string): Promise<MailExport | null>;
  countArchive(selection: ArchiveExportSelection): Promise<number>;
  archivePage(
    selection: ArchiveExportSelection,
    afterKey: string | null,
    limit: number,
  ): Promise<{ rows: ArchiveRow[]; lastKey: string | null }>;
  mailboxNames(ids: readonly string[]): Promise<Map<string, string>>;
  /** Bytes the tenant's other export files (finished, not purged) take. */
  usedBytes(excludeExportId: string): Promise<number>;
  /**
   * Record the finished file, unless the tenant's export files, this one included, would then
   * take more than the limit: that is decided and recorded under one lock.
   */
  persistResult(
    exportId: string,
    result: {
      fileName: string;
      contentType: string;
      fileSize: number;
      segmentSize: number;
      sha256: string;
      report: Record<string, unknown>;
      expiresAt: Date;
    },
  ): Promise<{ accepted: true } | { accepted: false; usedBytes: number }>;
  persistJobResult(jobId: string, summary: Record<string, unknown>): Promise<void>;
  persistRuntimeState(jobId: string, state: unknown): Promise<void>;
}

function archiveConditions(tenantId: string, selection: ArchiveExportSelection): SQL[] {
  const conditions: SQL[] = [eq(archiveItems.tenantId, tenantId)];
  if (selection.itemIds && selection.itemIds.length > 0) {
    conditions.push(inArray(archiveItems.id, selection.itemIds));
    return conditions;
  }
  const filter = selection.filter ?? {};
  if (filter.mailbox) {
    conditions.push(eq(archiveItems.protectedObjectId, filter.mailbox));
  }
  const dateOf = sql`coalesce(${archiveItems.sentAt}, ${archiveItems.receivedAt})`;
  if (filter.dateFrom) {
    conditions.push(sql`${dateOf} >= ${new Date(filter.dateFrom)}`);
  }
  if (filter.dateTo) {
    conditions.push(sql`${dateOf} <= ${new Date(filter.dateTo)}`);
  }
  if (filter.hasAttachment !== undefined) {
    conditions.push(eq(archiveItems.hasAttachment, filter.hasAttachment));
  }
  if (filter.from) {
    conditions.push(sql`${archiveItems.envelope}->>'from' ILIKE ${`%${filter.from}%`}`);
  }
  if (filter.q && filter.q.length > 0) {
    // Same expression as the archive search and its GIN index.
    conditions.push(
      sql`to_tsvector('simple',
        coalesce(${archiveItems.subject}, '') || ' ' ||
        coalesce(${archiveItems.bodyText}, '') || ' ' ||
        coalesce(${archiveItems.envelope}::text, '')
      ) @@ plainto_tsquery('simple', ${filter.q})`,
    );
  }
  return conditions;
}

export function pgExportStore(
  run: TenantTxRunner,
  tenantId: string,
  maxTenantBytes: number = DEFAULT_EXPORT_MAX_TENANT_BYTES,
): ExportStore {
  const usedByOthers = async (
    tx: Parameters<Parameters<TenantTxRunner>[0]>[0],
    exportId: string,
  ) => {
    const result = await tx.execute<{ bytes: string }>(sql`
      SELECT coalesce(sum(file_size), 0)::text AS bytes
      FROM ${mailExports}
      WHERE tenant_id = ${tenantId} AND purged_at IS NULL AND file_size IS NOT NULL
        AND id <> ${exportId}
    `);
    return Number(result.rows[0]?.bytes ?? 0);
  };
  return {
    usedBytes: (excludeExportId) => run((tx) => usedByOthers(tx, excludeExportId)),
    async loadExport(exportId) {
      const [row] = await run((tx) =>
        tx
          .select()
          .from(mailExports)
          .where(and(eq(mailExports.tenantId, tenantId), eq(mailExports.id, exportId)))
          .limit(1),
      );
      return row ?? null;
    },
    async countArchive(selection) {
      const [row] = await run((tx) =>
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(archiveItems)
          .where(and(...archiveConditions(tenantId, selection))),
      );
      return row?.n ?? 0;
    },
    async archivePage(selection, afterKey, limit) {
      // Keyset paging over (date, id): stable while new items arrive.
      const dateOf = sql`coalesce(${archiveItems.sentAt}, ${archiveItems.receivedAt})`;
      const conditions = archiveConditions(tenantId, selection);
      if (afterKey !== null) {
        const [stamp, id] = afterKey.split("|");
        conditions.push(
          sql`(${dateOf}, ${archiveItems.id}::text) > (${new Date(stamp as string)}, ${id as string})`,
        );
      }
      const rows = await run((tx) =>
        tx
          .select({
            id: archiveItems.id,
            subject: archiveItems.subject,
            itemHash: archiveItems.itemHash,
            sizeBytes: archiveItems.sizeBytes,
            chunks: archiveItems.chunks,
            receivedAt: archiveItems.receivedAt,
            sentAt: archiveItems.sentAt,
            messageId: archiveItems.messageId,
            envelope: archiveItems.envelope,
            protectedObjectId: archiveItems.protectedObjectId,
          })
          .from(archiveItems)
          .where(and(...conditions))
          .orderBy(asc(dateOf), asc(sql`${archiveItems.id}::text`))
          .limit(limit),
      );
      const last = rows[rows.length - 1];
      return {
        rows,
        lastKey: last ? `${(last.sentAt ?? last.receivedAt).toISOString()}|${last.id}` : null,
      };
    },
    async mailboxNames(ids) {
      if (ids.length === 0) {
        return new Map();
      }
      const rows = await run((tx) =>
        tx
          .select({
            id: protectedObjects.id,
            displayName: protectedObjects.displayName,
            externalId: protectedObjects.externalId,
          })
          .from(protectedObjects)
          .where(
            and(eq(protectedObjects.tenantId, tenantId), inArray(protectedObjects.id, [...ids])),
          ),
      );
      return new Map(rows.map((row) => [row.id, row.displayName ?? row.externalId]));
    },
    async persistResult(exportId, result) {
      return run(async (tx) => {
        // The same lock for every export of the tenant: the check and the write are one step.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`export-quota:${tenantId}`}))`,
        );
        const used = await usedByOthers(tx, exportId);
        if (used + result.fileSize > maxTenantBytes) {
          return { accepted: false as const, usedBytes: used };
        }
        await tx
          .update(mailExports)
          .set({
            fileName: result.fileName,
            contentType: result.contentType,
            fileSize: result.fileSize,
            segmentSize: result.segmentSize,
            sha256: result.sha256,
            report: result.report,
            expiresAt: result.expiresAt,
          })
          .where(and(eq(mailExports.tenantId, tenantId), eq(mailExports.id, exportId)));
        return { accepted: true as const };
      });
    },
    persistJobResult: (jobId, summary) =>
      mergeJobPayload(run, tenantId, jobId, { [RESULT_KEY]: summary }),
    persistRuntimeState: (jobId, state) =>
      mergeJobPayload(run, tenantId, jobId, { runtime: state }),
  };
}

/** Archive rows as export messages: page by page, streaming from the chunk store. */
export async function* archiveExportMessages(
  store: ExportStore,
  reader: ChunkReader,
  selection: ArchiveExportSelection,
  signal: AbortSignal,
): AsyncGenerator<mailfiles.ExportMessage> {
  let afterKey: string | null = null;
  for (;;) {
    if (signal.aborted) {
      throw new JobAbortedError();
    }
    const page = await store.archivePage(selection, afterKey, ARCHIVE_PAGE);
    if (page.rows.length === 0) {
      return;
    }
    const names = await store.mailboxNames([
      ...new Set(
        page.rows.map((row) => row.protectedObjectId).filter((id): id is string => id !== null),
      ),
    ]);
    for (const row of page.rows) {
      const date = row.sentAt ?? row.receivedAt;
      const label = (row.protectedObjectId && names.get(row.protectedObjectId)) || "Archive";
      const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
      const object = {
        path: row.id,
        size: row.sizeBytes ?? 0,
        mtime: date.getTime(),
        id: row.id,
        type: "archive-item",
        sha256: row.itemHash,
        chunks: [...(row.chunks ?? [])],
      };
      yield {
        folder: [label, month],
        date,
        size: row.sizeBytes ?? 0,
        messageId: row.messageId,
        subject: row.subject,
        from: row.envelope?.from ?? null,
        to: row.envelope?.to?.join(", ") ?? null,
        sha256: row.itemHash,
        open: () => reader.objectStream(object),
      };
    }
    afterKey = page.lastKey;
    if (page.rows.length < ARCHIVE_PAGE) {
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Format choice
// ---------------------------------------------------------------------------

export interface ExportFileKind {
  readonly extension: string;
  readonly contentType: string;
}

/** The file an export produces; a single-folder MBOX export is a plain .mbox. */
export function fileKindOf(format: MailExport["format"], singleFolder: boolean): ExportFileKind {
  if (format === "mbox" && singleFolder) {
    return { extension: ".mbox", contentType: "application/mbox" };
  }
  return { extension: ".zip", contentType: "application/zip" };
}

/** A storage- and download-safe file name. */
export function exportFileName(requested: string | null, kind: ExportFileKind, now: Date): string {
  const stamp = now.toISOString().replace(/[-:.]/g, "").slice(0, 15).toLowerCase();
  const cleaned = (requested ?? "")
    .replace(/\.(zip|mbox|eml)$/i, "")
    .replace(/[^A-Za-z0-9._ -]+/g, "-")
    .replace(/^[-. ]+/, "")
    .replace(/[-. ]+$/, "")
    .slice(0, 100);
  return `${cleaned.length > 0 ? cleaned : `mail-export-${stamp}`}${kind.extension}`;
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const parsed = Number.parseInt(env[name]?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

export interface ExportHandlerOptions {
  readonly env?: Env;
  readonly store?: (ctx: WorkerJobContext) => ExportStore;
}

export function createExportHandler(options: ExportHandlerOptions = {}): JobHandler<"export"> {
  const env = options.env ?? process.env;
  const ttlHours = positiveInt(env, "EXPORT_TTL_HOURS", DEFAULT_EXPORT_TTL_HOURS);
  const maxTenantBytes = positiveInt(
    env,
    "EXPORT_MAX_TENANT_BYTES",
    DEFAULT_EXPORT_MAX_TENANT_BYTES,
  );

  /** The run ends without a retry: waiting or asking for less is the only way out. */
  const quotaExceeded = (usedBytes: number): InvalidPayloadError =>
    new InvalidPayloadError(
      `the export files of this organization take ${usedBytes} of the ${maxTenantBytes} bytes that may be used for exports, so this export does not fit`,
      buildCause("export.quota_exceeded", {}, { usedBytes, limitBytes: maxTenantBytes }),
    );

  return {
    queue: "export",

    async run(ctx, payload): Promise<JobOutcome> {
      if (!isUuid(payload.exportId)) {
        throw new InvalidPayloadError("export job payload has no exportId");
      }
      const store = options.store
        ? options.store(ctx)
        : pgExportStore(tenantRunner(ctx.db, ctx.tenantId), ctx.tenantId, maxTenantBytes);
      const row = await store.loadExport(payload.exportId);
      if (!row) {
        throw new InvalidPayloadError(`export ${payload.exportId} does not exist`);
      }
      const format = row.format;
      const available = mailfiles.EXPORT_FORMATS.find((entry) => entry.id === format);
      if (!available?.available) {
        throw new InvalidPayloadError(`the export format ${format} is not available`);
      }
      const logger = ctx.logger.child({ exportId: row.id, origin: row.origin, format });
      logger.info("export started");
      const recorder = new PhaseRecorder(
        ctx.progress,
        (state) => store.persistRuntimeState(ctx.jobId, state),
        logger,
        ctx.now,
      );
      const progress = { ...ctx, progress: recorder };
      const segments = new mailfiles.SegmentStore({ storage: ctx.storage.primary, keys: ctx.keys });
      const scope = { tenantId: ctx.tenantId, kind: "export" as const, id: row.id };
      // A retry starts the file over: leftovers of the failed attempt must not mix in.
      await segments.delete(scope);
      // What is left of the tenant's room for exports: nothing is written when there is none.
      const usedByOtherExports = await store.usedBytes(row.id);
      const room = maxTenantBytes - usedByOtherExports;
      if (room <= 0) {
        throw quotaExceeded(usedByOtherExports);
      }

      const execute = async (): Promise<JobOutcome> => {
        recorder.phase("collecting");
        let messages: AsyncIterable<mailfiles.ExportMessage> | Iterable<mailfiles.ExportMessage>;
        let extraFolders: readonly (readonly string[])[] = [];
        let counts: mailfiles.ExportCounts = {
          mail: 0,
          calendar: 0,
          contacts: 0,
          other: 0,
          folders: 0,
        };
        // One folder: a plain .mbox file. The archive spans mailboxes and months, so its MBOX
        // export is always the ZIP with one file per folder.
        let singleFolder = false;
        if (row.origin === "snapshot") {
          const protectedObject: ProtectedObjectRef | null = ctx.protectedObject;
          if (!protectedObject || !row.snapshotId) {
            throw new InvalidPayloadError("a snapshot export needs a snapshot and its object");
          }
          const selection: RestoreSelection = parseStoredSelection(row.selection);
          const source = await mailfiles.openSnapshotExport(progress, {
            snapshotId: row.snapshotId,
            protectedObject,
            selection,
          });
          messages = source.messages;
          extraFolders = source.folders;
          counts = source.counts;
          const folderKeys = new Set([
            ...source.messages.map((message) => message.folder.join("\u0000")),
            ...source.folders.map((folder) => folder.join("\u0000")),
          ]);
          singleFolder = folderKeys.size <= 1;
        } else {
          const selection = row.selection as ArchiveExportSelection;
          const reader = new ChunkReader({
            storage: ctx.storage,
            keys: ctx.keys,
            index: ctx.chunkIndex,
            logger,
            signal: ctx.signal,
          });
          messages = archiveExportMessages(store, reader, selection, ctx.signal);
          counts = {
            mail: await store.countArchive(selection),
            calendar: 0,
            contacts: 0,
            other: 0,
            folders: 0,
          };
        }
        ctx.progress.total(counts.mail);
        const kind = fileKindOf(format, singleFolder);

        recorder.phase("writing");
        const failures: { ref: string; reason: string }[] = [];
        let failedCount = 0;
        const writerOptions: mailfiles.ExportOptions = {
          signal: ctx.signal,
          extraFolders,
          now: ctx.now,
          onEntry: (entry) => {
            if (entry.status === "added") {
              ctx.progress.advance(1, entry.bytes);
              return;
            }
            failedCount++;
            const reason = entry.note ?? "the message could not be exported";
            if (failures.length < MAX_REPORT_ITEMS) {
              failures.push({ ref: entry.name, reason });
            }
            ctx.progress.fail(entry.name, reason);
          },
        };
        const { stream, completed } = writeFormat(format, singleFolder, messages, writerOptions);

        const upload = segments
          .writeStream(scope, stream, { signal: ctx.signal, maxBytes: room })
          .catch((error: unknown) => {
            stream.destroy();
            throw error;
          });
        const [written, built] = await Promise.allSettled([upload, completed]);
        const outOfRoom =
          written.status === "rejected" && written.reason instanceof mailfiles.SegmentLimitError;
        const failure = outOfRoom
          ? (written as PromiseRejectedResult).reason
          : built.status === "rejected"
            ? (built.reason as unknown)
            : written.status === "rejected"
              ? (written.reason as unknown)
              : null;
        if (failure !== null) {
          await segments.delete(scope).catch(() => undefined);
          if (outOfRoom) {
            logger.warn("export stopped: it does not fit the export storage limit", {
              limitBytes: maxTenantBytes,
              usedBytes: usedByOtherExports,
            });
            throw quotaExceeded(usedByOtherExports);
          }
          if (failure instanceof JobAbortedError || ctx.signal.aborted) {
            throw new JobAbortedError();
          }
          logger.error("export failed", { errorMessage: safeErrorMessage(failure) });
          throw failure instanceof Error ? failure : new Error(String(failure));
        }
        const file = (written as PromiseFulfilledResult<Awaited<typeof upload>>).value;
        const summary = (built as PromiseFulfilledResult<mailfiles.ExportSummary>).value;
        recorder.phase("finishing");

        const now = ctx.now();
        // The API keeps the requested name inside the stored selection (`options.fileName`).
        const requestedName = (row.selection as { options?: { fileName?: unknown } }).options
          ?.fileName;
        const fileName = exportFileName(
          typeof requestedName === "string" ? requestedName : row.fileName,
          kind,
          now,
        );
        const expiresAt = new Date(now.getTime() + ttlHours * 3_600_000);
        const report = {
          messages: summary.messages,
          folders: counts.folders,
          bytes: summary.bytes,
          failed: failedCount,
          skipped: {
            calendar: counts.calendar,
            contacts: counts.contacts,
            other: counts.other,
          },
          items: failures,
        };
        const recorded = await store.persistResult(row.id, {
          fileName,
          contentType: kind.contentType,
          fileSize: file.size,
          segmentSize: file.segmentSize,
          sha256: file.sha256,
          report,
          expiresAt,
        });
        if (!recorded.accepted) {
          // Another export finished first and took the room this one measured at its start.
          await segments.delete(scope).catch(() => undefined);
          throw quotaExceeded(recorded.usedBytes);
        }
        await store.persistJobResult(ctx.jobId, {
          fileName,
          fileSize: file.size,
          sha256: file.sha256,
          messages: summary.messages,
          failed: failedCount,
          expiresAt: expiresAt.toISOString(),
        });
        logger.info("export finished", { fileName, size: file.size, messages: summary.messages });
        return { summary: { messages: summary.messages, failed: failedCount, bytes: file.size } };
      };
      try {
        return await execute();
      } finally {
        // Whatever happened, the phase must not outlive the run.
        await recorder.finish().catch(() => undefined);
      }
    },
  };
}

function writeFormat(
  format: MailExport["format"],
  singleFolder: boolean,
  messages: AsyncIterable<mailfiles.ExportMessage> | Iterable<mailfiles.ExportMessage>,
  options: mailfiles.ExportOptions,
): mailfiles.ExportResult {
  switch (format) {
    case "eml_zip":
      return mailfiles.createEmlZip(messages, options);
    case "mbox":
      return singleFolder
        ? mailfiles.createMbox(messages, options)
        : mailfiles.createMboxZip(messages, options);
    default:
      throw new InvalidPayloadError(`the export format ${format} is not available`);
  }
}

/** The handler listed in ./index.ts. */
export const exportHandler: JobHandler<"export"> = createExportHandler();
