/**
 * Exchange Online backup engine (protected object kind `mailbox`): mail as
 * MIME with separate metadata, calendar events and contacts as Graph JSON,
 * incremental through per-folder delta links, resumable through the job
 * cursor. See engine.ts for the run, paths.ts for the object layout, run.ts
 * for the metadata vocabulary shared with restore/conventions.ts, and
 * state.ts for what persists between runs.
 */
export {
  DEFAULT_EXCHANGE_CHECKPOINT_BYTES,
  DEFAULT_EXCHANGE_CHECKPOINT_ITEMS,
  ExchangeBackupEngine,
  type ExchangeBackupEngineOptions,
  type ExchangeBackupResult,
  type ExchangeGraphClientFactory,
  createExchangeBackupEngine,
} from "./engine.js";
export {
  EXCHANGE_PHASES,
  type ExchangeObjectType,
  type ExchangeReportedPhase,
  MESSAGE_FORMAT as EXCHANGE_MESSAGE_FORMAT,
  META as EXCHANGE_META,
  MailboxAccessError,
  OBJECT_TYPES as EXCHANGE_OBJECT_TYPES,
  type RunCounters as ExchangeRunCounters,
  isMailboxAccessError,
} from "./run.js";
export {
  DEFAULT_SKIPPED_FOLDERS,
  MAIL_EXTRA_SELECT,
  type MailDeltaEntry,
  type MessageProtection,
  type PlannedFolder,
  contentFingerprint,
  mailMetadata,
  planMailFolders,
} from "./mail.js";
export { type StoredEvent, eventMetadata } from "./calendar.js";
export { contactMetadata } from "./contacts.js";
export {
  CALENDAR_ROOT,
  CONTACTS_ROOT,
  MAIL_ROOT,
  attachmentObjectPath,
  attachmentsFolderPath,
  contactObjectPath,
  displayFolderPath,
  eventObjectPath,
  mailJsonObjectPath,
  mailObjectPath,
} from "./paths.js";
export {
  EXCHANGE_STATE_VERSION,
  type ExchangeCursor,
  type ExchangeState,
  parseCursor as parseExchangeCursor,
  readState as readExchangeState,
} from "./state.js";
