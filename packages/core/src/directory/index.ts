/**
 * Directory: which mailboxes, OneDrives and IMAP accounts Restow protects.
 *
 * - rules.ts        protection rules (all / group / exclusion list) and overrides
 * - plan.ts         users/delta planning: row changes of one run (pure)
 * - sync.ts         the sync run against Graph, over a repository seam
 * - confirm.ts      backup-time check that a mailbox is inactive (disabled, unlicensed)
 * - locks.ts        locked OneDrives and sites (HTTP 423): backup-time check and sync re-check
 * - inactive.ts     the confirmation state of an object Restow stopped backing up
 * - config.ts       rules, overrides and sync state inside `sources.config`
 * - groups.ts       group search for the rules editor
 * - group-mailboxes.ts  Microsoft 365 group mailboxes from groups/delta (pure planning)
 * - csv.ts          IMAP account list and CSV import
 * - credentials.ts  Entra app credentials from environment values
 */

export * from "./config.js";
export * from "./confirm.js";
export * from "./credentials.js";
export * from "./csv.js";
export * from "./group-mailboxes.js";
export * from "./groups.js";
export * from "./inactive.js";
export * from "./locks.js";
export * from "./plan.js";
export * from "./rules.js";
export * from "./sites.js";
export * from "./sync.js";
