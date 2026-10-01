import { realpath } from "node:fs/promises";
import { join } from "node:path";
/**
 * The `import` queue handler: mail files into an imported mailbox
 * (docs/IMPORT.md).
 *
 * The API records an import as a `mail_imports` row (the requested files, the
 * archive option) plus a `jobs` row and enqueues `{ importId,
 * protectedObjectId }`. This handler turns the request into an input list for
 * the core engine (packages/core/src/mailfiles/import-engine.ts):
 *
 *   uploads       staged as sealed segments in the tenant's storage
 *                 (`SegmentStore`), read back with random access; no plaintext
 *                 copy of the file ever touches a disk
 *   server folder files and whole directory trees below IMPORT_DIR, read
 *                 through `ImportFolder` (no path escapes the folder, nothing
 *                 is ever written or deleted there)
 *
 * The engine writes one snapshot of the imported mailbox and returns a report
 * of everything it did and could not do. The handler stores the report on the
 * `mail_imports` row (also when nothing could be read, so the page can list the
 * unreadable items), optionally ingests the new messages into the archive, and
 * deletes the staged uploads. A retry after a crash resumes from the engine's
 * checkpoint and keeps the staged files; a run that can never succeed (nothing
 * readable) fails without retry. Importing the same files again is not a failure:
 * when every message is a duplicate and nothing was unreadable, the run succeeds
 * without a snapshot and the report says all of them were already imported.
 *
 * Environment:
 *   IMPORT_DIR                  the server-side import folder (default /var/lib/restow/import)
 *   IMPORT_MAX_MESSAGE_BYTES    largest single message that is read (default 256 MiB)
 *   IMPORT_PARSE_WORKERS        parser processes of this worker (MSG, message metadata), 1 to 8 (default 2)
 */
import { type Logger, loadManifest, mailfiles } from "@restow/core";
import {
  type ImportUpload,
  type MailImport,
  type MailImportRequestFile,
  importUploads,
  mailImports,
  safeErrorMessage,
  snapshots,
  tenants,
} from "@restow/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
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
import { archiveImportedMessages } from "./import-archive.js";

type Env = Record<string, string | undefined>;

export const DEFAULT_IMPORT_DIR = "/var/lib/restow/import";
/** `jobs.payload` key of the live counters (the API reads the same name). */
export const IMPORT_LIVE_KEY = "importLive";

// ---------------------------------------------------------------------------
// Persistence seam
// ---------------------------------------------------------------------------

export interface ImportStore {
  loadImport(importId: string): Promise<MailImport | null>;
  loadUploads(uploadIds: readonly string[]): Promise<ImportUpload[]>;
  /** The tenant's slug: its import folder is `<IMPORT_DIR>/<slug>/`. */
  tenantSlug(): Promise<string>;
  persistReport(importId: string, report: mailfiles.ImportReport): Promise<void>;
  /** The snapshot this job already committed (a retry after the commit must not import again). */
  committedSnapshot(jobId: string): Promise<{ id: string; sequence: number } | null>;
  persistLive(jobId: string, stats: mailfiles.ImportLiveStats): Promise<void>;
  persistResult(jobId: string, summary: Record<string, unknown>): Promise<void>;
  persistRuntimeState(jobId: string, state: unknown): Promise<void>;
}

export function pgImportStore(run: TenantTxRunner, tenantId: string): ImportStore {
  return {
    async loadImport(importId) {
      const [row] = await run((tx) =>
        tx
          .select()
          .from(mailImports)
          .where(and(eq(mailImports.tenantId, tenantId), eq(mailImports.id, importId)))
          .limit(1),
      );
      return row ?? null;
    },
    async tenantSlug() {
      const [row] = await run((tx) =>
        tx.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId)).limit(1),
      );
      if (!row) {
        throw new InvalidPayloadError("the tenant of this import does not exist");
      }
      return row.slug;
    },
    async loadUploads(uploadIds) {
      if (uploadIds.length === 0) {
        return [];
      }
      return run((tx) =>
        tx
          .select()
          .from(importUploads)
          .where(
            and(eq(importUploads.tenantId, tenantId), inArray(importUploads.id, [...uploadIds])),
          ),
      );
    },
    async committedSnapshot(jobId) {
      const [row] = await run((tx) =>
        tx
          .select({ id: snapshots.id, sequence: snapshots.sequence })
          .from(snapshots)
          .where(
            and(
              eq(snapshots.tenantId, tenantId),
              eq(snapshots.jobId, jobId),
              isNotNull(snapshots.manifestPath),
            ),
          )
          .limit(1),
      );
      return row ?? null;
    },
    async persistReport(importId, report) {
      await run((tx) =>
        tx
          .update(mailImports)
          .set({ report: report as unknown as Record<string, unknown> })
          .where(and(eq(mailImports.tenantId, tenantId), eq(mailImports.id, importId))),
      );
    },
    persistLive: (jobId, stats) =>
      mergeJobPayload(run, tenantId, jobId, { [IMPORT_LIVE_KEY]: stats }),
    persistResult: (jobId, summary) =>
      mergeJobPayload(run, tenantId, jobId, { [RESULT_KEY]: summary }),
    persistRuntimeState: (jobId, state) =>
      mergeJobPayload(run, tenantId, jobId, { runtime: state }),
  };
}

// ---------------------------------------------------------------------------
// Input list
// ---------------------------------------------------------------------------

/** A file name as a single path segment (an upload's name is display text, not a path). */
export function baseNameOf(path: string): string {
  const cleaned = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return cleaned[cleaned.length - 1] ?? "file";
}

/**
 * A stored server-folder path (`<slug>/...`, relative to IMPORT_DIR) as a path inside the
 * tenant's own folder. The API validated the path already; this is the second check, so a
 * record that names another tenant's folder, `.` or `..` is refused before anything is read.
 */
export function tenantRelativePath(stored: string, tenantSlug: string): string {
  const prefix = `${tenantSlug}/`;
  const normalized = stored === tenantSlug ? prefix : stored;
  if (!normalized.startsWith(prefix)) {
    throw new InvalidPayloadError(
      `the server folder path "${stored}" is not below this tenant's import folder`,
    );
  }
  const relative = normalized.slice(prefix.length);
  const parts = relative.split("/").filter((part) => part.length > 0);
  if (parts.some((part) => part === "." || part === "..") || relative.includes("\\")) {
    throw new InvalidPayloadError(
      `the server folder path "${stored}" is not below this tenant's import folder`,
    );
  }
  return parts.join("/");
}

/**
 * The tenant's own import folder, `<IMPORT_DIR>/<slug>/`, or null when it is missing or is
 * itself a link to somewhere else (a sibling tenant's folder, say). Everything a tenant reads
 * is resolved against this directory, so neither `..` nor a link inside it reaches another
 * tenant's files.
 */
export async function openTenantImportFolder(
  importDir: string,
  tenantSlug: string,
): Promise<mailfiles.ImportFolder | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tenantSlug) || tenantSlug.includes("..")) {
    return null;
  }
  const path = join(importDir, tenantSlug);
  try {
    const [realRoot, realTenant] = await Promise.all([realpath(importDir), realpath(path)]);
    if (realTenant !== join(realRoot, tenantSlug)) {
      return null;
    }
  } catch {
    return null;
  }
  const folder = new mailfiles.ImportFolder(path);
  return (await folder.isAvailable()) ? folder : null;
}

export interface BuildInputOptions {
  readonly files: readonly MailImportRequestFile[];
  readonly uploads: ReadonlyMap<string, ImportUpload>;
  readonly tenantId: string;
  readonly segments: mailfiles.SegmentStore;
  /** The tenant's own folder (see {@link openTenantImportFolder}); null when unavailable. */
  readonly folder: mailfiles.ImportFolder | null;
  /**
   * The tenant's slug: a server-folder path must lie below `<slug>/` in the import folder, so
   * one tenant's import can never read a file another tenant's administrator dropped there.
   */
  readonly tenantSlug: string;
}

/**
 * The ordered input list of an import. Deterministic for a given request, so a
 * retry resumes against the same list (the engine compares a fingerprint).
 */
export async function buildImportInput(
  options: BuildInputOptions,
): Promise<mailfiles.ImportRunInput> {
  const groups: mailfiles.ImportGroup[] = [];
  const units: mailfiles.ImportUnit[] = [];
  const openers = new Map<
    string,
    () => mailfiles.MailInputFile | Promise<mailfiles.MailInputFile>
  >();

  for (const [index, requested] of options.files.entries()) {
    if (requested.origin === "upload") {
      const upload = requested.uploadId ? options.uploads.get(requested.uploadId) : undefined;
      if (!upload || upload.status !== "consumed") {
        throw new InvalidPayloadError(
          `the uploaded file "${requested.path}" is no longer available; upload it again`,
        );
      }
      const name = baseNameOf(upload.fileName);
      const key = `upload:${upload.id}`;
      const scope = { tenantId: options.tenantId, kind: "staging" as const, id: upload.id };
      const file = options.segments.file(
        scope,
        { size: upload.size, segmentSize: upload.segmentSize },
        name,
      );
      groups.push({ label: upload.fileName, size: upload.size, kind: "file" });
      units.push({ key, group: index, kind: "file", path: name, size: upload.size });
      openers.set(key, () => file);
      continue;
    }

    if (!options.folder) {
      throw new InvalidPayloadError(
        "the tenant's server import folder is not available on this worker (IMPORT_DIR/<tenant slug> is missing or is a link)",
      );
    }
    const folder = options.folder;
    const relativePath = tenantRelativePath(requested.path, options.tenantSlug);
    const shown = relativePath;
    if (requested.kind === "directory") {
      groups.push({
        label: relativePath === "" ? "/" : `${relativePath.replace(/\/+$/, "")}/`,
        size: 0,
        kind: "directory",
      });
      for await (const entry of folder.walk(relativePath)) {
        if (entry.kind === "dir") {
          const components = entry.path.split("/").filter(Boolean);
          if (components.length > 0) {
            units.push({
              key: `dir:${requested.path}/${entry.path}`,
              group: index,
              kind: "dir",
              path: components,
            });
          }
        } else {
          const relative = `${requested.path}/${entry.file.path}`;
          const key = `folder:${relative}`;
          units.push({
            key,
            group: index,
            kind: "file",
            path: entry.file.path,
            size: entry.file.size,
          });
          const opened = entry.file;
          openers.set(key, () => opened);
        }
      }
      continue;
    }
    if (relativePath === "") {
      throw new InvalidPayloadError("a server folder file needs a path below the import folder");
    }
    const opened = await folder.file(relativePath);
    const key = `folder:${requested.path}`;
    groups.push({ label: shown, size: opened.size, kind: "file" });
    // A single file is mapped like an upload: by its own name, not by where it lies in the folder.
    const name = baseNameOf(relativePath);
    units.push({ key, group: index, kind: "file", path: name, size: opened.size });
    openers.set(key, () => ({ ...opened, path: name }));
  }

  return {
    groups,
    units,
    open(unit) {
      const opener = openers.get(unit.key);
      if (!opener) {
        throw new Error(`no input for unit ${unit.key}`);
      }
      return opener();
    },
  };
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

export interface ImportHandlerOptions {
  readonly env?: Env;
  /** Defaults to Postgres. */
  readonly store?: (ctx: WorkerJobContext) => ImportStore;
  /** Test seams for the engine. */
  readonly engineOptions?: mailfiles.ImportEngineOptions;
  /** Archive ingest (tests replace it). */
  readonly archive?: typeof archiveImportedMessages;
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const parsed = Number.parseInt(env[name]?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createImportHandler(options: ImportHandlerOptions = {}): JobHandler<"import"> {
  const env = options.env ?? process.env;
  const importDir = env.IMPORT_DIR?.trim() || DEFAULT_IMPORT_DIR;
  // The parsers of hostile bytes run in child processes with a memory and time limit.
  mailfiles.configureIsolation({
    workers: positiveInt(env, "IMPORT_PARSE_WORKERS", mailfiles.defaultIsolationWorkers()),
  });

  return {
    queue: "import",

    async run(ctx, payload): Promise<JobOutcome> {
      if (!isUuid(payload.importId)) {
        throw new InvalidPayloadError("import job payload has no importId");
      }
      const protectedObject = ctx.protectedObject;
      if (!protectedObject) {
        throw new InvalidPayloadError("import job payload names no protected object");
      }
      const store = options.store
        ? options.store(ctx)
        : pgImportStore(tenantRunner(ctx.db, ctx.tenantId), ctx.tenantId);
      const row = await store.loadImport(payload.importId);
      if (!row) {
        throw new InvalidPayloadError(`import ${payload.importId} does not exist`);
      }
      const logger = ctx.logger.child({ importId: row.id, files: row.files.length });
      logger.info("import started");

      const segments = new mailfiles.SegmentStore({
        storage: ctx.storage.primary,
        keys: ctx.keys,
      });
      const uploadIds = row.files
        .filter((file) => file.origin === "upload" && file.uploadId)
        .map((file) => file.uploadId as string);
      const uploads = new Map((await store.loadUploads(uploadIds)).map((u) => [u.id, u]));
      const usesFolder = row.files.some((file) => file.origin === "folder");
      const tenantSlug = usesFolder ? await store.tenantSlug() : "";
      const folder = usesFolder ? await openTenantImportFolder(importDir, tenantSlug) : null;
      const input = await buildImportInput({
        files: row.files,
        uploads,
        tenantId: ctx.tenantId,
        segments,
        folder,
        tenantSlug,
      });

      const recorder = new PhaseRecorder(
        ctx.progress,
        (state) => store.persistRuntimeState(ctx.jobId, state),
        logger,
        ctx.now,
      );
      recorder.phase("starting");
      let lastStats: mailfiles.ImportLiveStats | null = null;
      const engine = new mailfiles.MailImportEngine({
        limits: {
          maxMessageBytes: positiveInt(
            env,
            "IMPORT_MAX_MESSAGE_BYTES",
            mailfiles.DEFAULT_MAIL_FILE_LIMITS.maxMessageBytes,
          ),
        },
        ...options.engineOptions,
        onStats: (stats) => {
          lastStats = stats;
          void store.persistLive(ctx.jobId, stats).catch((error: unknown) => {
            logger.warn("could not persist the live import counters", {
              errorMessage: safeErrorMessage(error),
            });
          });
        },
      });

      const execute = async (): Promise<JobOutcome> => {
        let snapshot: { id: string; sequence: number };
        let report: mailfiles.ImportReport;
        const committed = await store.committedSnapshot(ctx.jobId);
        if (committed) {
          // A previous attempt committed the snapshot and stopped later (report or archive step):
          // reading again would find only duplicates and fail the job for nothing.
          logger.info("the snapshot of this import is already committed; skipping the read", {
            snapshotId: committed.id,
          });
          snapshot = committed;
          report = row.report
            ? (row.report as unknown as mailfiles.ImportReport)
            : await reportFromSnapshot(ctx, committed.id);
        } else {
          let result: mailfiles.ImportRunResult;
          try {
            result = await engine.run({ ...ctx, progress: recorder }, protectedObject, input);
          } catch (error) {
            if (error instanceof mailfiles.ImportNothingError) {
              await store.persistReport(row.id, error.report);
              await deleteStaging(segments, ctx.tenantId, uploadIds, logger);
              const already = error.alreadyImported;
              if (already !== null) {
                // The same files imported again: every message is in the mailbox already. The
                // run did what was asked, so it succeeds, without a snapshot and with nothing
                // to archive; the report says how many messages were already there.
                await store.persistResult(ctx.jobId, {
                  snapshotId: null,
                  sequence: null,
                  messages: 0,
                  duplicates: error.report.totals.duplicates,
                  failed: 0,
                  skipped: error.report.totals.skipped,
                  alreadyImported: already,
                  completedAt: error.report.completedAt,
                });
                logger.info("import finished: every message was already imported", {
                  messages: already,
                });
                return { summary: { ...error.report.totals, alreadyImported: already } };
              }
              throw new InvalidPayloadError(error.message);
            }
            await recorder.flush().catch(() => undefined);
            throw error;
          }
          snapshot = { id: result.snapshotId, sequence: result.sequence };
          report = result.report;
          // Stored before the archive step so a retry finds the report and the snapshot.
          await store.persistReport(row.id, report);
        }

        if (row.options.archive) {
          recorder.phase("archive");
          const archived = await (options.archive ?? archiveImportedMessages)({
            ctx,
            protectedObject,
            snapshotId: snapshot.id,
            logger,
            onProgress: (done, total) => {
              void store
                .persistLive(ctx.jobId, {
                  ...(lastStats ?? {
                    messages: report.totals.messages,
                    duplicates: report.totals.duplicates,
                    skipped: report.totals.skipped,
                    failed: report.totals.failed,
                    unitsDone: 0,
                    unitsTotal: 0,
                  }),
                  archiveDone: done,
                  archiveTotal: total,
                } as mailfiles.ImportLiveStats)
                .catch(() => undefined);
            },
          });
          report = { ...report, archive: archived };
        }
        await store.persistReport(row.id, report);
        await store.persistResult(ctx.jobId, {
          snapshotId: snapshot.id,
          sequence: snapshot.sequence,
          messages: report.totals.messages,
          duplicates: report.totals.duplicates,
          failed: report.totals.failed,
          skipped: report.totals.skipped,
          completedAt: report.completedAt,
        });
        await deleteStaging(segments, ctx.tenantId, uploadIds, logger);
        logger.info("import finished", { ...report.totals, archive: report.archive });
        return { summary: { ...report.totals } };
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

/**
 * The report of an import whose snapshot was committed but whose report was never
 * stored (the worker stopped in between): counted from the snapshot's own messages.
 */
async function reportFromSnapshot(
  ctx: WorkerJobContext,
  snapshotId: string,
): Promise<mailfiles.ImportReport> {
  const record = await ctx.snapshots.get(snapshotId);
  const objects = record?.manifestPath
    ? (await loadManifest(ctx.storage, record.manifestPath, ctx.keys)).objects
    : [];
  const mine = objects.filter(
    (object) =>
      object.type === "message" && object.metadata?.[mailfiles.IMPORT_JOB_META] === ctx.jobId,
  );
  const now = ctx.now().toISOString();
  return {
    version: 1,
    startedAt: now,
    completedAt: now,
    snapshotId,
    totals: {
      files: 0,
      messages: mine.length,
      folders: 0,
      attachments: 0,
      duplicates: 0,
      skipped: 0,
      failed: 0,
      messageBytes: mine.reduce((sum, object) => sum + object.size, 0),
      sourceBytes: 0,
      synthesizedMessages: 0,
    },
    files: [],
    items: [],
    itemsOmitted: 0,
    archive: null,
    notes: ["report_recovered"],
  };
}

/** Delete the staged segments of the uploads an import consumed (best effort; the sweeper catches leftovers). */
async function deleteStaging(
  segments: mailfiles.SegmentStore,
  tenantId: string,
  uploadIds: readonly string[],
  logger: Logger,
): Promise<void> {
  for (const id of uploadIds) {
    try {
      await segments.delete({ tenantId, kind: "staging", id });
    } catch (error) {
      logger.warn("could not delete a staged upload; the cleanup task will retry", {
        uploadId: id,
        errorMessage: safeErrorMessage(error),
      });
    }
  }
}

/** The handler listed in ./index.ts. */
export const importHandler: JobHandler<"import"> = createImportHandler();
