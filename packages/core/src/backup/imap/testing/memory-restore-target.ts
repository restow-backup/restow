/**
 * An in-memory APPEND target for backup/restore round-trip tests: what the
 * IMAP restore engine writes into, recorded per mailbox exactly as appended.
 */
import type { ImapRestoreSession } from "../../../restore/imap.js";

export interface AppendedMessage {
  readonly uid: number;
  readonly content: Buffer;
  readonly flags: readonly string[];
  readonly internalDate: Date | undefined;
}

export class MemoryRestoreTarget implements ImapRestoreSession {
  private readonly mailboxes = new Map<string, AppendedMessage[]>();
  private nextUid = 1;

  constructor(readonly delimiter: string) {}

  /** Messages appended to `path`, in append order. */
  mailbox(path: string): readonly AppendedMessage[] {
    return this.mailboxes.get(path) ?? [];
  }

  mailboxNames(): string[] {
    return [...this.mailboxes.keys()].sort();
  }

  async ensureMailbox(path: string): Promise<string> {
    if (!this.mailboxes.has(path)) {
      this.mailboxes.set(path, []);
    }
    return path;
  }

  async findByMessageId(mailbox: string, messageId: string): Promise<number[]> {
    return this.mailbox(mailbox)
      .filter((message) => headerMessageId(message.content) === messageId)
      .map((message) => message.uid);
  }

  async deleteMessages(mailbox: string, uids: readonly number[]): Promise<void> {
    const doomed = new Set(uids);
    this.mailboxes.set(
      mailbox,
      this.mailbox(mailbox).filter((message) => !doomed.has(message.uid)),
    );
  }

  async append(
    mailbox: string,
    content: Buffer,
    flags: readonly string[],
    internalDate: Date | undefined,
  ): Promise<{ uid: number | undefined }> {
    const uid = this.nextUid++;
    const messages = [...this.mailbox(mailbox), { uid, content, flags: [...flags], internalDate }];
    this.mailboxes.set(mailbox, messages);
    return { uid };
  }

  async close(): Promise<void> {}
}

function headerMessageId(content: Buffer): string | undefined {
  const headers = content.toString("utf8").split("\r\n\r\n", 1)[0];
  return /^message-id:\s*(\S+)/im.exec(headers)?.[1];
}
