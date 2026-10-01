/**
 * Restore engines: Exchange (mail, calendar, contacts), OneDrive, IMAP and
 * the streaming ZIP download, plus the manifest conventions they read and the
 * per-item report they share. Restore is the product; every
 * engine reports what it restored, skipped, failed and could not verify.
 *
 * Exports are listed by name: the helpers behind them stay internal, so
 * `@restow/core` can re-export this module next to the backup engines
 * without name clashes.
 */
export { createRestoreEngines } from "./dispatcher.js";
export type { RestoreEngines, RestoreEnginesOptions } from "./dispatcher.js";

export { ExchangeRestoreEngine, eventTransactionId, targetMailboxOf } from "./exchange.js";
export type { ExchangeRestoreEngineOptions } from "./exchange.js";

export {
  OneDriveRestoreEngine,
  driveTargetOf,
  parseDriveTargetRef,
  resolveTargetDriveId,
} from "./onedrive.js";
export type { DriveTarget, OneDriveRestoreEngineOptions } from "./onedrive.js";

export { ImapRestoreEngine, ImapRestoreError } from "./imap.js";
export type { ImapRestoreEngineOptions, ImapRestoreSession, ImapSessionFactory } from "./imap.js";
export { ImapFlowRestoreSession, createImapFlowSessionFactory } from "./imap-flow.js";
export type {
  ImapFlowClient,
  ImapFlowSessionFactoryOptions,
  ImapRestoreAccountResolver,
} from "./imap-flow.js";

export {
  ARCHIVE_MANIFEST_COLUMNS,
  ARCHIVE_MANIFEST_NAME,
  DownloadRestoreEngine,
  archiveEntryName,
  archiveFileName,
  createRestoreArchive,
} from "./download.js";
export type {
  ArchiveEntry,
  ArchiveEntryStatus,
  ArchiveSummary,
  CreateRestoreArchiveOptions,
  DownloadRestoreEngineOptions,
} from "./download.js";

export { defaultRestoreFolderName, restoreRequestOptions } from "./common.js";
export type { RestoreGraphClientFactory, RestoreRequestOptions } from "./common.js";

export {
  RestoreSourceError,
  planRestore,
  resolveRestoreSource,
  selectObjects,
} from "./selection.js";
export type { RestorePlan, ResolvedSource } from "./selection.js";

export type {
  RestoreItemCode,
  RestoreItemResult,
  RestoreItemStatus,
  RestoreReport,
} from "./results.js";

export { QuickXorHash, quickXorHash } from "./quickxorhash.js";
