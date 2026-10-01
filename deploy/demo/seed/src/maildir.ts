/**
 * Writes generated messages straight into Dovecot's Maildir storage (no IMAP
 * connection needed): the generator and Dovecot share the mail volume
 * (deploy/demo/docker-compose.yml), and Maildir is deliberately just files on
 * disk, so Dovecot picks up what lands in `new/`/`cur/` on the next `SELECT`.
 *
 * Layout (Maildir++, what Dovecot expects): the mailbox root is INBOX
 * (`cur/`, `new/`, `tmp/` directly inside it); a subfolder is a sibling
 * directory named `.<Folder>` with its own `cur/`, `new/`, `tmp/`.
 */
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export interface MaildirTarget {
  /** Root of one mailbox, e.g. "/var/mail/vhosts/example.org/info". */
  root: string;
  /** Folder name ("Sent", "Archive"); omit for INBOX itself. */
  folder?: string;
}

function folderDir(target: MaildirTarget): string {
  return target.folder ? join(target.root, `.${target.folder}`) : target.root;
}

/** Create `cur/`, `new/` and `tmp/` for a mailbox or one of its folders. */
export function ensureMaildir(target: MaildirTarget): void {
  const dir = folderDir(target);
  for (const sub of ["cur", "new", "tmp"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
}

let sequence = 0;

/** A Maildir-unique base name: `<seconds>.<unique>.<hostname>` (RFC-ish, good enough locally). */
function maildirBaseName(date: Date, unique: string): string {
  sequence += 1;
  const seconds = Math.floor(date.getTime() / 1000);
  return `${seconds}.${unique}${process.pid}_${sequence}.${hostname()}`;
}

export interface WriteMessageOptions {
  /** Delivery time: the Maildir filename's timestamp and the file's mtime. Defaults to now. */
  date?: Date;
  /** A generator-chosen unique fragment (kept short; the sequence counter already dedupes). */
  unique?: string;
  /**
   * `true` (the default) delivers straight to `cur/` with the Seen flag, as a
   * demo mailbox that already has history should look; `false` delivers to
   * `new/` with no flags, for the handful of messages the generator leaves
   * looking unread.
   */
  seen?: boolean;
}

/** Write one RFC 5322 message (mime.ts) into a mailbox or folder; returns the file path. */
export function writeMaildirMessage(
  target: MaildirTarget,
  eml: string,
  options: WriteMessageOptions = {},
): string {
  ensureMaildir(target);
  const dir = folderDir(target);
  const date = options.date ?? new Date();
  const seen = options.seen ?? true;
  const base = maildirBaseName(date, options.unique ?? "restowdemo");
  const fileName = seen ? `${base}:2,S` : base;
  const path = join(dir, seen ? "cur" : "new", fileName);
  writeFileSync(path, eml, "utf8");
  // Dovecot reports a Maildir message's file mtime as its IMAP INTERNALDATE,
  // which Restow shows and sorts by. Without this every seeded mail would
  // look as if it arrived the moment the seed ran.
  utimesSync(path, date, date);
  return path;
}
