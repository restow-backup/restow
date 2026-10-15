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

export type { RestoreGraphClientFactory, RestoreRequestOptions } from "./common.js";
export { defaultRestoreFolderName, restoreRequestOptions } from "./common.js";
export type { RestoreEngines, RestoreEnginesOptions } from "./dispatcher.js";
export { createRestoreEngines } from "./dispatcher.js";
export type {
  ArchiveEntry,
  ArchiveEntryStatus,
  ArchiveSummary,
  CreateRestoreArchiveOptions,
  DownloadRestoreEngineOptions,
} from "./download.js";
export {
  ARCHIVE_MANIFEST_COLUMNS,
  ARCHIVE_MANIFEST_NAME,
  archiveEntryName,
  archiveFileName,
  createRestoreArchive,
  DownloadRestoreEngine,
} from "./download.js";
export type { ExchangeRestoreEngineOptions } from "./exchange.js";
export { ExchangeRestoreEngine, eventTransactionId, targetMailboxOf } from "./exchange.js";
export type { ImapRestoreEngineOptions, ImapRestoreSession, ImapSessionFactory } from "./imap.js";
export { ImapRestoreEngine, ImapRestoreError } from "./imap.js";
export type {
  ImapFlowClient,
  ImapFlowSessionFactoryOptions,
  ImapRestoreAccountResolver,
} from "./imap-flow.js";
export { createImapFlowSessionFactory, ImapFlowRestoreSession } from "./imap-flow.js";
export type { DriveTarget, OneDriveRestoreEngineOptions } from "./onedrive.js";
export {
  driveTargetOf,
  OneDriveRestoreEngine,
  parseDriveTargetRef,
  resolveTargetDriveId,
} from "./onedrive.js";
export { QuickXorHash, quickXorHash } from "./quickxorhash.js";
export type {
  RestoreItemCode,
  RestoreItemResult,
  RestoreItemStatus,
  RestoreReport,
} from "./results.js";
export type { ResolvedSource, RestorePlan } from "./selection.js";
export {
  planRestore,
  RestoreSourceError,
  resolveRestoreSource,
  selectObjects,
} from "./selection.js";
export type { SharePointRestoreEngineOptions } from "./sharepoint.js";
export { SharePointRestoreEngine, SiteRestoreTargetError } from "./sharepoint.js";
