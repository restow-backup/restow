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
  /**
   * Behave like Gmail: the `[Gmail]` mailboxes exist, every message is in
   * `[Gmail]/All Mail`, and a COPY adds a label (the message appears in the
   * destination too) instead of making a second message.
   */
  readonly gmail?: boolean;
  /** PERMANENTFLAGS of every mailbox; undefined: the server does not say. */
  readonly permanentFlags?: readonly string[];
}

/** The mailboxes of a new Gmail account, as its LIST names them. */
export const GMAIL_MAILBOXES: Readonly<Record<string, string | undefined>> = {
  "[Gmail]/All Mail": "\\All",
  "[Gmail]/Sent Mail": "\\Sent",
  "[Gmail]/Drafts": "\\Drafts",
  "[Gmail]/Trash": "\\Trash",
  "[Gmail]/Spam": "\\Junk",
  "[Gmail]/Important": "\\Important",
  "[Gmail]/Starred": "\\Flagged",
};

const GMAIL_ALL_MAIL = "[Gmail]/All Mail";

export class FakeImapAccount implements ImapRestoreSession {
  readonly delimiter: string;
  readonly commands: string[] = [];
  private readonly boxes = new Map<string, FakeMailbox>();
  private nextUid = 1;
  closed = false;
  /**
   * When set, the server stores (and returns) different bytes than it was
   * given, as a server that re-renders what it stores (Exchange over IMAP)
   * does; {@link rerenderHeaders} is such a function.
   */
  mangle: ((content: Buffer) => Buffer) | null = null;
  /** When set, APPEND to this mailbox is refused. */
  refuseAppendTo: string | null = null;
  /** When set, the connection drops after this many APPENDs: later commands all fail. */
  dropAfterAppends: number | null = null;
  /** When set, the connection drops at the first COPY (the worker is gone before the labels). */
  dropAtCopy = false;
  connectionLost = false;

  constructor(private readonly options: FakeImapOptions = {}) {
    this.delimiter = options.delimiter ?? "/";
    this.boxes.set("INBOX", { path: "INBOX", specialUse: "\\Inbox", messages: [] });
    const initial = options.gmail
      ? { ...GMAIL_MAILBOXES, ...options.mailboxes }
      : options.mailboxes;
    for (const [path, specialUse] of Object.entries(initial ?? {})) {
      this.boxes.set(path, { path, specialUse, messages: [] });
    }
  }

  get isGmail(): boolean {
    return this.options.gmail === true;
  }

  /** Every distinct message of the account (on Gmail: once, whatever its labels). */
  distinctMessages(): StoredMessage[] {
    const seen = new Map<number, StoredMessage>();
    for (const box of this.boxes.values()) {
      for (const message of box.messages) {
        seen.set(message.uid, message);
      }
    }
    return [...seen.values()];
  }

  async permanentFlags(mailbox: string): Promise<readonly string[] | undefined> {
    this.commands.push(`SELECT ${mailbox}`);
    this.box(mailbox);
    return this.options.permanentFlags;
  }

  async copy(mailbox: string, uid: number, destination: string): Promise<void> {
    this.commands.push(`COPY ${mailbox} ${uid} ${destination}`);
    if (this.dropAtCopy) {
      this.connectionLost = true;
    }
    this.assertConnected();
    const message = this.box(mailbox).messages.find((candidate) => candidate.uid === uid);
    if (!message) {
      throw new Error(`NO no message ${uid} in ${mailbox}`);
    }
    const target = this.box(destination);
    if (this.options.gmail) {
      // Gmail: the same message gets the destination's label.
      if (!target.messages.includes(message) && destination !== GMAIL_ALL_MAIL) {
        target.messages.push(message);
      }
      return;
    }
    target.messages.push({ ...message, uid: this.nextUid++ });
  }

  /** Mailbox paths, sorted. */
  mailboxNames(): string[] {
    return [...this.boxes.keys()].sort();
  }

  messages(path: string): readonly StoredMessage[] {
    return this.boxes.get(path)?.messages ?? [];
  }

  /** Put a message into a mailbox directly (the target's existing state). */
  seed(path: string, content: string, internalDate?: Date): StoredMessage {
    const box = this.box(path);
    const message = {
      uid: this.nextUid++,
      content: Buffer.from(content),
      flags: [],
      internalDate,
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
    this.assertConnected();
    return this.box(mailbox)
      .messages.filter((message) => headerMessageId(message.content) === messageId)
      .map((message) => message.uid);
  }

  async findSimilar(
    mailbox: string,
    message: { readonly internalDate: Date | undefined; readonly size: number },
  ): Promise<number[]> {
    // SEARCH SINCE <day before> BEFORE <two days after> LARGER size-1 SMALLER size+1
    // (the server judges the day in its own time zone, ./imap-flow.ts).
    this.commands.push(`SEARCH ${mailbox} similar ${message.size}`);
    this.assertConnected();
    const at = message.internalDate?.getTime();
    const day = 24 * 60 * 60 * 1000;
    return this.box(mailbox)
      .messages.filter((stored) => {
        const time = stored.internalDate?.getTime();
        return (
          stored.content.length === message.size &&
          (at === undefined || (time !== undefined && Math.abs(time - at) <= 2 * day))
        );
      })
      .map((stored) => stored.uid);
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
    this.assertConnected();
    if (this.dropAfterAppends !== null && this.dropAfterAppends-- <= 0) {
      this.connectionLost = true;
      this.assertConnected();
    }
    if (mailbox === this.refuseAppendTo) {
      throw new Error("NO [OVERQUOTA] mailbox is full");
    }
    const uid = this.nextUid++;
    const stored = this.mangle ? this.mangle(content) : content;
    const kept =
      this.options.permanentFlags?.includes("\\*") === false
        ? flags.filter(
            (flag) => flag.startsWith("\\") || this.options.permanentFlags?.includes(flag),
          )
        : flags;
    const message = { uid, content: stored, flags: [...kept], internalDate };
    this.box(mailbox).messages.push(message);
    const use = this.box(mailbox).specialUse?.toLowerCase();
    if (this.options.gmail && mailbox !== GMAIL_ALL_MAIL && use !== "\\trash" && use !== "\\junk") {
      // Gmail: a message appended to a label is in All Mail as well, once.
      this.box(GMAIL_ALL_MAIL).messages.push(message);
    }
    return { uid: this.options.noUidPlus ? undefined : uid };
  }

  async fetchSha256(mailbox: string, uid: number): Promise<string | null> {
    const message = this.box(mailbox).messages.find((candidate) => candidate.uid === uid);
    return message ? createHash("sha256").update(message.content).digest("hex") : null;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private assertConnected(): void {
    if (this.connectionLost) {
      throw new Error("Connection not available");
    }
  }
}

/** Re-render a message as Exchange over IMAP does: new header order and a server header, same Message-ID. */
export function rerenderHeaders(content: Buffer): Buffer {
  const text = content.toString("utf8");
  const split = text.indexOf("\r\n\r\n");
  const head = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? "" : text.slice(split);
  const lines = head.split("\r\n").reverse();
  return Buffer.from(
    [`X-MS-Exchange-Organization-Network-Message-Id: ${lines.length}`, ...lines].join("\r\n") +
      body,
  );
}

function headerMessageId(content: Buffer): string | undefined {
  const headers = content.toString("utf8").split("\r\n\r\n", 1)[0] ?? "";
  return /^message-id:\s*(\S+)/im.exec(headers)?.[1];
}
