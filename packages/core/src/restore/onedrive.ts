/**
 * OneDrive restore: files and folders of a drive snapshot back into a drive
 * through Graph (docs/MICROSOFT.md, OneDrive backup and restore).
 *
 * Folders are recreated along each file's path (and for selected empty
 * folders). Files up to 4 MiB go up in one PUT, larger ones through an upload
 * session in 320 KiB-aligned fragments, both straight from the chunk reader
 * without touching the disk. The original timestamps are put back through
 * `fileSystemInfo`. A OneDrive restore never replaces a file (docs/ARCHITECTURE.md,
 * Restore): the API refuses "replace" for a OneDrive, and the engine runs a job that
 * still carries it as "rename" ({@link oneDriveRestoreMode}). The session below also
 * serves the SharePoint engine, where "replace" is an explicit choice, so the mode maps
 * onto Graph's conflict behaviour there:
 *
 *   rename   an existing file keeps its place, the restored copy is renamed;
 *            a file already there with the same content (the unchanged
 *            original, or the copy an earlier attempt of a retried job
 *            uploaded) is not uploaded once more. An Office file SharePoint
 *            rewrote on download is recognised in its place by the size and
 *            hash the library reported at backup time, and what an earlier
 *            attempt uploaded by the job's own record (./progress.ts), since
 *            no hash of the backup matches what SharePoint stores
 *   replace  the existing file is overwritten (the library keeps it as a version);
 *            only a SharePoint site's restore reaches this
 *   skip     an existing file with that name is left alone
 *
 * A selected historical version is written back under its file's name, so
 * "replace" (a SharePoint library) makes it the current version again and
 * "rename" puts it next to the current one.
 *
 * Every upload is verified: the bytes sent must match the snapshot's size and
 * SHA-256, the size OneDrive reports must match, and the QuickXorHash OneDrive
 * computes must equal the one of the bytes sent and, when the backup recorded
 * one, the one the file had at backup time. Sent bytes that differ from the
 * snapshot fail the item with code "integrity" (the upload is in OneDrive by
 * then, and the failure names it); a disagreement only on OneDrive's side
 * leaves the item restored but unverified.
 */
import type { DriveItem } from "@microsoft/microsoft-graph-types";
import { type ChunkReader, RestoreIntegrityError } from "../engine/chunkstore.js";
import type {
  JobContext,
  Logger,
  RestoreEngine,
  RestoreMode,
  RestoreRequest,
} from "../engine/types.js";
import type { GraphClient } from "../graph/client.js";
import {
  type ConflictBehavior,
  type DriveDeltaItem,
  ensureDriveFolderPath,
  getChildByName,
  getUserDrive,
  isFileItem,
  uploadFile,
} from "../graph/resources/drive.js";
import type { ManifestObject } from "../manifest.js";
import {
  chunkReaderFor,
  mailboxRestoreMode,
  type RestoreGraphClientFactory,
  throwIfAborted,
} from "./common.js";
import {
  baseName,
  fileTimestampsOf,
  objectTypeOf,
  pathSegments,
  recordedQuickXorHashOf,
  rewrittenOnDownload,
  sourceStoredOf,
  versionFactsOf,
} from "./conventions.js";
import { ObjectRangeSource } from "./object-range.js";
import { RESTORED_BY_EARLIER_ATTEMPT, RestoreProgress } from "./progress.js";
import { UploadDigest } from "./quickxorhash.js";
import { isAbortError, RestoreLedger, type RestoreReport } from "./results.js";
import { planRestore, type RestorePlan, resolveRestoreSource } from "./selection.js";

export interface OneDriveRestoreEngineOptions {
  readonly graph: RestoreGraphClientFactory;
  /** Upload-session fragment size in bytes (default 10 MiB; clamped to 5–60 MiB). */
  readonly fragmentSize?: number;
  /** First wait after a failed fragment before the session is asked what it holds (tests: 0). */
  readonly fragmentRetryDelayMs?: number;
}

/** Where a drive restore writes: a drive plus an optional folder below its root. */
export interface DriveTarget {
  /** A drive id (`b!…`), or a user id / user principal name whose OneDrive is meant. */
  readonly drive: string;
  /** Folder segments below the root that every restored path is prefixed with. */
  readonly basePath: readonly string[];
}

/**
 * Parse a target reference: `<drive id>`, `<user>`, or either followed by
 * `:/<folder path>`, e.g. `anna@example.org:/Restored from Ben`.
 */
export function parseDriveTargetRef(ref: string): DriveTarget {
  const separator = ref.indexOf(":/");
  if (separator === -1) {
    return { drive: ref.trim(), basePath: [] };
  }
  return {
    drive: ref.slice(0, separator).trim(),
    basePath: pathSegments(ref.slice(separator + 2)),
  };
}

export function driveTargetOf(request: RestoreRequest): DriveTarget {
  if (request.target.type === "download") {
    throw new Error("download restores are produced by the download engine");
  }
  if (request.target.type === "other") {
    const target = parseDriveTargetRef(request.target.ref ?? "");
    if (target.drive.length === 0) {
      throw new Error("a restore into another OneDrive needs the target drive or user");
    }
    return target;
  }
  return { drive: request.protectedObject.externalId, basePath: [] };
}

/**
 * A drive id as given (OneDrive for Business ids start with `b!`), otherwise
 * the OneDrive of the user named by id or user principal name.
 */
export async function resolveTargetDriveId(client: GraphClient, drive: string): Promise<string> {
  if (drive.startsWith("b!")) {
    return drive;
  }
  const info = await getUserDrive(client, drive);
  if (!info) {
    throw new Error(`${drive} has no OneDrive to restore into`);
  }
  return info.id;
}

function conflictBehaviorFor(mode: RestoreMode): ConflictBehavior {
  return mode === "skip" ? "fail" : mode;
}

/**
 * How many renamed copies of one name a rename-mode restore inspects. Far
 * beyond what retries produce; it only bounds the lookups in a folder full of
 * numbered copies.
 */
const MAX_RENAMED_COPIES = 100;

/**
 * The name OneDrive gives the `copy`-th renamed copy of a file under
 * `@microsoft.graph.conflictBehavior=rename`: the number goes before the
 * extension (`report 2.docx`, `README 2`). Copy 0 is the name itself.
 */
export function renamedCopyName(name: string, copy: number): string {
  if (copy === 0) {
    return name;
  }
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} ${copy}${name.slice(dot)}` : `${name} ${copy}`;
}

/**
 * What a OneDrive restore queued with "replace" says on every item: it ran as "rename".
 * The `restore_mode` enum keeps "replace" for history (and for SharePoint sites), so a
 * job row may still carry it for a OneDrive, though the API refuses it there.
 */
export const ONEDRIVE_LEGACY_REPLACE_NOTE =
  'this restore was queued with the mode "replace", which OneDrive restores do not support; it ran as "rename" instead: a file that already existed kept its place and content, and the backed-up file was added next to it under a new name';

/**
 * The mode a OneDrive restore runs with: "replace" becomes "rename" (defence in depth
 * behind the API's refusal, so this engine never overwrites a file), the rest passes.
 */
export function oneDriveRestoreMode(mode: RestoreMode): {
  readonly mode: "rename" | "skip";
  readonly legacyReplace: boolean;
} {
  return mailboxRestoreMode(mode);
}

/** Put {@link ONEDRIVE_LEGACY_REPLACE_NOTE} in front of the reason of every item and failure. */
function withLegacyReplaceNote(report: RestoreReport): RestoreReport {
  const noted = (reason: string | undefined) =>
    reason ? `${ONEDRIVE_LEGACY_REPLACE_NOTE}; ${reason}` : ONEDRIVE_LEGACY_REPLACE_NOTE;
  return {
    ...report,
    failures: report.failures.map((failure) => ({ ...failure, reason: noted(failure.reason) })),
    items: report.items.map((item) => ({ ...item, reason: noted(item.reason) })),
  };
}

export class OneDriveRestoreEngine implements RestoreEngine {
  readonly kind = "onedrive" as const;

  constructor(private readonly options: OneDriveRestoreEngineOptions) {}

  async run(ctx: JobContext, request: RestoreRequest): Promise<RestoreReport> {
    const target = driveTargetOf(request);
    const logger = ctx.logger.child({
      component: "restore-onedrive",
      restoreJobId: request.restoreJobId,
      snapshotId: request.snapshotId,
    });
    const ledger = new RestoreLedger(ctx.progress);
    const { mode, legacyReplace } = oneDriveRestoreMode(request.mode);
    if (legacyReplace) {
      logger.warn(
        "restore job carries the mode 'replace', which OneDrive does not support; running it as 'rename'",
        {
          restoreJobId: request.restoreJobId,
        },
      );
    }

    ctx.progress.phase("resolve");
    const { manifest } = await resolveRestoreSource(ctx, request);
    const plan = planRestore(manifest, request.selection);
    ctx.progress.total(plan.objects.length);
    const client = await this.options.graph(ctx, request.protectedObject);
    const driveId = await resolveTargetDriveId(client, target.drive);
    logger.info("restore planned", {
      files: plan.files.length,
      versions: plan.versions.length,
      folders: plan.folders.length,
      target: request.target.type,
      mode,
    });

    const progress = await RestoreProgress.open(ctx.cursor, {
      restoreJobId: request.restoreJobId,
      retry: ctx.attempt > 0,
    });
    const session = new OneDriveRestoreSession({
      ctx,
      client,
      driveId,
      basePath: target.basePath,
      mode,
      fragmentSize: this.options.fragmentSize,
      fragmentRetryDelayMs: this.options.fragmentRetryDelayMs,
      reader: chunkReaderFor(ctx),
      ledger,
      logger,
      progress,
    });
    try {
      await restorePlan(ctx, plan, session, ledger);
    } finally {
      // What this attempt uploaded stays known to the next one, also when it failed.
      await progress.flush().catch((error: unknown) =>
        logger.warn("could not save the restore progress", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    ledger.settle(plan.objects);
    await ctx.progress.flush();
    const report = legacyReplace ? withLegacyReplaceNote(ledger.report()) : ledger.report();
    logger.info("restore finished", {
      restored: report.restored,
      skipped: report.skipped,
      failed: report.failures.length,
      unverified: report.unverified,
    });
    return report;
  }
}

async function restorePlan(
  ctx: JobContext,
  plan: RestorePlan,
  session: OneDriveRestoreSession,
  ledger: RestoreLedger,
): Promise<void> {
  if (plan.folders.length > 0) {
    ctx.progress.phase("folders");
    for (const folder of plan.folders) {
      await session.restoreFolder(folder);
    }
  }
  if (plan.files.length > 0 || plan.versions.length > 0) {
    ctx.progress.phase("files");
    for (const file of [...plan.files, ...plan.versions]) {
      await session.restoreFile(file);
    }
  }
  for (const object of plan.informational) {
    ledger.skipped(
      object,
      "not_restorable",
      objectTypeOf(object) === "shortcut"
        ? "shortcuts to items in other drives are recorded, not restored"
        : "OneNote notebooks and other packages are recorded without content and cannot be restored",
    );
  }
  for (const object of [
    ...plan.mail,
    ...plan.events,
    ...plan.contacts,
    ...plan.orphanAttachments,
  ]) {
    ledger.failed(
      object,
      new Error("a mailbox item cannot be restored into a OneDrive"),
      "wrong_target",
    );
  }
  for (const attachments of [
    ...plan.attachmentsByMessage.values(),
    ...plan.attachmentsByEvent.values(),
  ]) {
    for (const attachment of attachments) {
      ledger.failed(
        attachment,
        new Error("a mailbox item cannot be restored into a OneDrive"),
        "wrong_target",
      );
    }
  }
  for (const object of plan.unknown) {
    ledger.failed(
      object,
      new Error(`objects of type "${object.type ?? ""}" cannot be restored into a OneDrive`),
      "not_restorable",
    );
  }
}

interface SessionOptions {
  readonly ctx: JobContext;
  readonly client: GraphClient;
  readonly driveId: string;
  readonly basePath: readonly string[];
  readonly mode: RestoreMode;
  readonly fragmentSize: number | undefined;
  readonly fragmentRetryDelayMs?: number | undefined;
  readonly reader: ChunkReader;
  readonly ledger: RestoreLedger;
  readonly logger: Logger;
  /**
   * What earlier attempts of this restore job uploaded, by snapshot path and
   * target (./progress.ts): a retry recognises its own uploads by item id,
   * also where SharePoint rewrote the bytes and no hash can match.
   */
  readonly progress?: RestoreProgress;
  /**
   * The path an object of the snapshot is written to below `basePath`; the
   * snapshot path itself when absent (a OneDrive). A SharePoint library drops
   * its `Libraries/<library>` folder here, while the ledger keeps reporting
   * the snapshot path.
   */
  readonly targetPathOf?: (snapshotPath: string) => string;
}

export class OneDriveRestoreSession {
  private readonly folderCache = new Map<string, string>();

  constructor(private readonly o: SessionOptions) {}

  private targetPath(snapshotPath: string): string {
    return this.o.targetPathOf ? this.o.targetPathOf(snapshotPath) : snapshotPath;
  }

  private async ensureFolder(segments: readonly string[]): Promise<string> {
    return ensureDriveFolderPath(this.o.client, this.o.driveId, [...this.o.basePath, ...segments], {
      cache: this.folderCache,
    });
  }

  async restoreFolder(folder: ManifestObject): Promise<void> {
    throwIfAborted(this.o.ctx);
    try {
      const id = await this.ensureFolder(pathSegments(this.targetPath(folder.path)));
      const packageType = folder.metadata?.packageType;
      this.o.ledger.restored(folder, {
        targetRef: id,
        bytes: 0,
        verified: true,
        note: packageType
          ? `a ${packageType} package (such as a OneNote notebook) is restored as a folder with its files`
          : undefined,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      this.o.ledger.failed(folder, error);
    }
  }

  /** Restore a file, or a historical version under its file's name. */
  async restoreFile(object: ManifestObject): Promise<void> {
    const { ctx, client, driveId, reader, ledger } = this.o;
    throwIfAborted(ctx);
    const isVersion = objectTypeOf(object) === "version";
    try {
      const filePath = isVersion ? versionFactsOf(object).filePath : object.path;
      const segments = pathSegments(this.targetPath(filePath));
      const name = segments.pop();
      if (name === undefined) {
        throw new Error("the file has an empty path");
      }
      const parentId = await this.ensureFolder(segments);
      // Keyed by where the file goes: one snapshot path can go into two libraries.
      const recordKey = `${this.o.driveId}:${object.path}`;
      const recorded = this.o.progress?.get(recordKey);
      if (recorded?.state === "done") {
        ledger.restored(object, {
          targetRef: recorded.targetRef,
          bytes: object.size,
          verified: recorded.verified,
          note: RESTORED_BY_EARLIER_ATTEMPT,
        });
        return;
      }

      if (this.o.mode === "skip") {
        const existing = await getChildByName(client, driveId, parentId, name);
        if (existing) {
          ledger.skipped(
            object,
            "exists",
            "a file with this name already exists in the target folder",
            existing.id,
          );
          return;
        }
      }
      if (this.o.mode === "rename") {
        const identical = await this.identicalCopy(object, parentId, name);
        if (identical) {
          ledger.skipped(
            object,
            "exists",
            `the target folder already holds this file with identical content as "${identical.name ?? name}"`,
            identical.id,
          );
          return;
        }
      }

      const digest = new UploadDigest();
      // Seekable: a fragment the session lost is read again from its chunk.
      const source = new ObjectRangeSource(reader, object, digest);
      let item: DriveItem;
      try {
        item = await uploadFile(client, driveId, parentId, name, source.read, object.size, {
          conflictBehavior: conflictBehaviorFor(this.o.mode),
          fileSystemInfo: fileTimestampsOf(object),
          fragmentSize: this.o.fragmentSize,
          signal: ctx.signal,
          ...(this.o.fragmentRetryDelayMs !== undefined
            ? { retryDelayMs: this.o.fragmentRetryDelayMs }
            : {}),
        });
      } finally {
        await source.close();
      }

      const check = verifyUpload(object, item, digest);
      if (check.integrity.length > 0) {
        // The chunk reader proves every chunk, so this takes a manifest whose
        // size or hash disagrees with its own chunks. The last fragment of an
        // upload session can complete before the reader's final check runs.
        const written = item.name ?? name;
        const replaced =
          this.o.mode === "replace"
            ? "; OneDrive keeps the file it overwrote as an earlier version"
            : "";
        ledger.failed(
          object,
          new RestoreIntegrityError(
            `${check.integrity.join("; ")}: "${written}" in OneDrive does not hold the backed-up content${replaced}`,
          ),
          "integrity",
          item.id ?? undefined,
        );
        return;
      }
      const notes: string[] = [];
      if (item.name && item.name !== name) {
        notes.push(`restored as "${item.name}" next to the existing file`);
      }
      if (isVersion) {
        notes.push(`version ${versionFactsOf(object).versionId} of ${baseName(filePath)}`);
      }
      if (object.metadata?.stale === "true") {
        notes.push("the backup held the last good copy of this file, not its newest change");
      }
      const verified = check.problems.length === 0;
      await this.o.progress?.done(recordKey, verified, item.id ?? undefined);
      if (rewrittenOnDownload(object)) {
        // SharePoint may rewrite this upload too: nothing but the record tells
        // a retry that this item is the job's own, so it is saved at once.
        await this.o.progress?.flush();
      }
      ledger.restored(object, {
        targetRef: item.id ?? undefined,
        bytes: object.size,
        verified,
        note: [...check.problems, ...notes].join("; ") || undefined,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      ledger.failed(object, error);
    }
  }

  /**
   * A file below `parentId` that already holds exactly the bytes of `object`:
   * under its own name or one of the names OneDrive gives renamed copies
   * (`report 1.docx`, `report 2.docx`, ...), looked up in that order until a
   * name is free. A retried rename-mode restore recognises what an earlier
   * attempt uploaded this way, instead of adding one more numbered copy.
   */
  private async identicalCopy(
    object: ManifestObject,
    parentId: string,
    name: string,
  ): Promise<DriveDeltaItem | null> {
    const { client, driveId } = this.o;
    let backupHash: Promise<string> | undefined;
    // An Office file SharePoint rewrote on download: the unchanged original
    // still holds what the source stored at backup time (size and hash Graph
    // reported then), not the backup's bytes.
    const stored = objectTypeOf(object) === "file" ? sourceStoredOf(object) : undefined;
    for (let copy = 0; copy <= MAX_RENAMED_COPIES; copy++) {
      throwIfAborted(this.o.ctx);
      const candidate = await getChildByName(
        client,
        driveId,
        parentId,
        renamedCopyName(name, copy),
      );
      if (candidate === null) {
        return null;
      }
      if (
        stored !== undefined &&
        isFileItem(candidate) &&
        candidate.size === stored.size &&
        candidate.file?.hashes?.quickXorHash === stored.quickXorHash
      ) {
        return candidate;
      }
      if (!isFileItem(candidate) || candidate.size !== object.size) {
        continue;
      }
      const hashes = candidate.file?.hashes;
      const sha256 = hashes?.sha256Hash?.toLowerCase();
      if (sha256 && object.sha256 !== undefined) {
        if (sha256 === object.sha256) {
          return candidate;
        }
        continue;
      }
      const quickXor = hashes?.quickXorHash;
      if (quickXor) {
        backupHash ??= this.backupQuickXorHash(object);
        if (quickXor === (await backupHash)) {
          return candidate;
        }
      }
    }
    return null;
  }

  /**
   * The QuickXorHash of a backed-up object: the one OneDrive reported at
   * backup time for a current file, otherwise computed from the backup, which
   * is read and verified exactly like an upload reads it.
   */
  private async backupQuickXorHash(object: ManifestObject): Promise<string> {
    const recorded = objectTypeOf(object) === "file" ? recordedQuickXorHashOf(object) : undefined;
    if (recorded !== undefined) {
      return recorded;
    }
    const digest = new UploadDigest();
    for await (const chunk of this.o.reader.readObject(object)) {
      digest.update(chunk);
    }
    return digest.quickXorHash;
  }
}

/** What was sent, as {@link UploadDigest} measured it. */
export interface SentDigest {
  readonly bytes: number;
  readonly quickXorHash: string;
  readonly sha256Hex: string;
}

/**
 * Compare the manifest, the bytes that were sent and what OneDrive reports.
 * `problems` lists every disagreement; `integrity` the ones between the sent
 * bytes and the snapshot, which mean the upload is not the backed-up content.
 */
export function verifyUpload(
  object: ManifestObject,
  item: DriveItem,
  sent: SentDigest,
): { problems: string[]; integrity: string[] } {
  const integrity: string[] = [];
  if (sent.bytes !== object.size) {
    integrity.push(`sent ${sent.bytes} bytes, the snapshot recorded ${object.size}`);
  } else if (object.sha256 !== undefined && sent.sha256Hex !== object.sha256) {
    integrity.push("the SHA-256 of the sent bytes differs from the snapshot");
  }
  const problems: string[] = [...integrity];
  if (typeof item.size === "number" && item.size !== object.size) {
    problems.push(`OneDrive reports ${item.size} bytes, expected ${object.size}`);
  }
  const reported = item.file?.hashes?.quickXorHash ?? undefined;
  if (reported !== undefined && reported !== sent.quickXorHash) {
    problems.push("the QuickXorHash OneDrive reports differs from the sent bytes");
  }
  const recorded = recordedQuickXorHashOf(object);
  if (recorded !== undefined && objectTypeOf(object) === "file" && recorded !== sent.quickXorHash) {
    problems.push("the QuickXorHash differs from the one OneDrive reported at backup time");
  }
  const reportedSha256 = item.file?.hashes?.sha256Hash ?? undefined;
  if (reportedSha256 !== undefined && reportedSha256.toLowerCase() !== sent.sha256Hex) {
    problems.push("the SHA-256 OneDrive reports differs from the sent bytes");
  }
  return { problems, integrity };
}
