/**
 * Exchange Online backup engine (protected object kind `mailbox`): mail as
 * MIME with separate metadata, calendar events and contacts as Graph JSON,
 * incremental through per-folder delta links, resumable through the job
 * cursor. See engine.ts for the run, paths.ts for the object layout, run.ts
 * for the metadata vocabulary shared with restore/conventions.ts, and
 * state.ts for what persists between runs.
 */

export { eventMetadata, type StoredEvent } from "./calendar.js";
export { contactMetadata } from "./contacts.js";
export {
  createExchangeBackupEngine,
  DEFAULT_EXCHANGE_CHECKPOINT_BYTES,
  DEFAULT_EXCHANGE_CHECKPOINT_ITEMS,
  ExchangeBackupEngine,
  type ExchangeBackupEngineOptions,
  type ExchangeBackupResult,
  type ExchangeGraphClientFactory,
} from "./engine.js";
export {
  contentFingerprint,
  DEFAULT_SKIPPED_FOLDERS,
  MAIL_EXTRA_SELECT,
  type MailDeltaEntry,
  type MessageProtection,
  mailMetadata,
  type PlannedFolder,
  planMailFolders,
} from "./mail.js";
export {
  attachmentObjectPath,
  attachmentsFolderPath,
  CALENDAR_ROOT,
  CONTACTS_ROOT,
  contactObjectPath,
  displayFolderPath,
  eventObjectPath,
  MAIL_ROOT,
  mailJsonObjectPath,
  mailObjectPath,
} from "./paths.js";
export {
  EXCHANGE_PHASES,
  type ExchangeObjectType,
  type ExchangeReportedPhase,
  isMailboxAccessError,
  MailboxAccessError,
  MESSAGE_FORMAT as EXCHANGE_MESSAGE_FORMAT,
  META as EXCHANGE_META,
  OBJECT_TYPES as EXCHANGE_OBJECT_TYPES,
  type RunCounters as ExchangeRunCounters,
} from "./run.js";
export {
  EXCHANGE_STATE_VERSION,
  type ExchangeCursor,
  type ExchangeState,
  parseCursor as parseExchangeCursor,
  readState as readExchangeState,
} from "./state.js";
