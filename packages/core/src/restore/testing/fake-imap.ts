/**
 * An in-memory IMAP account for restore tests: mailboxes with SPECIAL-USE,
 * APPEND with UIDs (as with UIDPLUS), Message-ID search, deletion and
 * byte-exact fetch. Every command is recorded; nothing touches the network.
 */
import { createHash } from "node:crypto";
import type { ImapRestoreSession } from "../imap.js";

export interface StoredMessage {
  readonly uid: number;
  readonly content: Buffer;
  readonly flags: readonly string[];
  readonly internalDate: Date | undefined;
}

interface FakeMailbox {
  readonly path: string;
  readonly specialUse: string | undefined;
  messages: StoredMessage[];
}

export interface FakeImapOptions {
  readonly delimiter?: string;
  /** Mailboxes the account starts with, with their SPECIAL-USE. */
  readonly mailboxes?: Readonly<Record<string, string | undefined>>;
  /** Pretend the server lacks UIDPLUS: APPEND reports no UID. */
  readonly noUidPlus?: boolean;
}

export class FakeImapAccount implements ImapRestoreSession {
  readonly delimiter: string;
  readonly commands: string[] = [];
  private readonly boxes = new Map<string, FakeMailbox>();
  private nextUid = 1;
  closed = false;
  /** When set, the server stores (and returns) different bytes than it was given. */
  mangle: ((content: Buffer) => Buffer) | null = null;
  /** When set, APPEND to this mailbox is refused. */
  refuseAppendTo: string | null = null;

  constructor(private readonly options: FakeImapOptions = {}) {
    this.delimiter = options.delimiter ?? "/";
    this.boxes.set("INBOX", { path: "INBOX", specialUse: "\\Inbox", messages: [] });
    for (const [path, specialUse] of Object.entries(options.mailboxes ?? {})) {
      this.boxes.set(path, { path, specialUse, messages: [] });
    }
  }

  /** Mailbox paths, sorted. */
  mailboxNames(): string[] {
    return [...this.boxes.keys()].sort();
  }

  messages(path: string): readonly StoredMessage[] {
    return this.boxes.get(path)?.messages ?? [];
  }

  /** Put a message into a mailbox directly (the target's existing state). */
  seed(path: string, content: string): StoredMessage {
    const box = this.box(path);
    const message = {
      uid: this.nextUid++,
      content: Buffer.from(content),
      flags: [],
      internalDate: undefined,
    };
    box.messages.push(message);
    return message;
  }

  private box(path: string): FakeMailbox {
    const box = this.boxes.get(path);
    if (!box) {
      throw new Error(`NO [NONEXISTENT] mailbox ${path} does not exist`);
    }
    return box;
  }

  specialUseMailbox(use: string): string | undefined {
    return [...this.boxes.values()].find(
      (box) => box.specialUse?.toLowerCase() === use.toLowerCase(),
    )?.path;
  }

  async ensureMailbox(path: string): Promise<string> {
    this.commands.push(`ENSURE ${path}`);
    const components = path.split(this.delimiter);
    for (let depth = 1; depth <= components.length; depth++) {
      const prefix = components.slice(0, depth).join(this.delimiter);
      if (!this.boxes.has(prefix)) {
        this.commands.push(`CREATE ${prefix}`);
        this.boxes.set(prefix, { path: prefix, specialUse: undefined, messages: [] });
      }
    }
    return path;
  }

  async findByMessageId(mailbox: string, messageId: string): Promise<number[]> {
    this.commands.push(`SEARCH ${mailbox} ${messageId}`);
    return this.box(mailbox)
      .messages.filter((message) => headerMessageId(message.content) === messageId)
      .map((message) => message.uid);
  }

  async deleteMessages(mailbox: string, uids: readonly number[]): Promise<void> {
    this.commands.push(`DELETE ${mailbox} ${uids.join(",")}`);
    const doomed = new Set(uids);
    const box = this.box(mailbox);
    box.messages = box.messages.filter((message) => !doomed.has(message.uid));
  }

  async append(
    mailbox: string,
    content: Buffer,
    flags: readonly string[],
    internalDate: Date | undefined,
  ): Promise<{ uid: number | undefined }> {
    this.commands.push(`APPEND ${mailbox}`);
    if (mailbox === this.refuseAppendTo) {
      throw new Error("NO [OVERQUOTA] mailbox is full");
    }
    const uid = this.nextUid++;
    const stored = this.mangle ? this.mangle(content) : content;
    this.box(mailbox).messages.push({ uid, content: stored, flags: [...flags], internalDate });
    return { uid: this.options.noUidPlus ? undefined : uid };
  }

  async fetchSha256(mailbox: string, uid: number): Promise<string | null> {
    const message = this.box(mailbox).messages.find((candidate) => candidate.uid === uid);
    return message ? createHash("sha256").update(message.content).digest("hex") : null;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function headerMessageId(content: Buffer): string | undefined {
  const headers = content.toString("utf8").split("\r\n\r\n", 1)[0] ?? "";
  return /^message-id:\s*(\S+)/im.exec(headers)?.[1];
}
