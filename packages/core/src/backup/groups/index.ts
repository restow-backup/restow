/**
 * Microsoft 365 group mailbox backup engine (protected object kind `group`):
 * the group calendar through the Exchange calendar phase and the group
 * conversations as RFC 5322 messages, in one snapshot per group. The layout
 * is a mailbox snapshot's, so restore, the explorer and the restore check
 * read it unchanged.
 */
export {
  type BuiltPost,
  buildPostMessage,
  CONVERSATIONS_FOLDER,
  CONVERSATIONS_PATH,
  type GroupAddress,
  POST_META,
  postMessageId,
  rfc5322Date,
} from "./conversations.js";
export {
  createGroupMailboxBackupEngine,
  type GroupGraphClientFactory,
  GroupMailboxBackupEngine,
  type GroupMailboxBackupEngineOptions,
  GroupUnavailableError,
} from "./engine.js";
