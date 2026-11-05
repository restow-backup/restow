/**
 * An in-process IMAP server double implementing {@link ImapConnector}.
 *
 * It models exactly what the engine observes: folders with UIDVALIDITY,
 * UIDNEXT, per-message flags, internal dates and byte-exact sources, plus the
 * failure modes the engine has to survive (auth rejection, refused folders,
 * dropped connections mid-FETCH, messages the server silently omits). Every
 * session call yields to the event loop once so that two workers interleave
 * the way they would over real sockets.
 */
import {
  type ImapAccountConfig,
  ImapAuthError,
  type ImapConnectOptions,
  type ImapConnector,
  type ImapCredential,
  type ImapEnvelopeMeta,
  type ImapFolderInfo,
  type ImapFolderStatus,
  type ImapListFlagsOptions,
  type ImapMessageFlags,
  type ImapMessageMeta,
  type ImapMessageProtection,
  type ImapMessageSource,
  type ImapSession,
  ImapSessionError,
} from "../types.js";

export interface FakeMessage {
  readonly uid: number;
  flags: string[];
  internalDate: Date;
  readonly source: Buffer;
  readonly messageId: string | null;
  /** Always present on the fake message; `faults.envelopeFailures` decides whether a FETCH returns it. */
  readonly envelope: ImapEnvelopeMeta;
  /**
   * Gmail: the one message behind this copy, shared by its copies in All Mail and in every
   * label folder (each copy has its own UID). Its labels are what X-GM-LABELS answers.
   */
  readonly gmail?: FakeGmailMessage;
}

/** One Gmail message (see {@link FakeImapServer.addGmailMessage}). */
export interface FakeGmailMessage {
  /** X-GM-MSGID: the same for every copy of the message. */
  readonly id: string;
  labels: string[];
  readonly source: Buffer;
  readonly copies: Map<string, number>;
}

export interface FakeFolderOptions {
  /** `null`: the server answers NIL (flat namespace); the session reports it as imapflow does, null. */
  readonly delimiter?: string | null;
  readonly specialUse?: string;
  readonly selectable?: boolean;
  readonly uidValidity?: number;
  /** EXAMINE answers without OK [UIDNEXT]: the session reports uidNext as imapflow does, undefined. */
  readonly noUidNext?: boolean;
  /** EXAMINE answers without OK [UIDVALIDITY]: refused as the connector refuses it. */
  readonly noUidValidity?: boolean;
}

/** Envelope fields a test cares about; anything left out defaults to "empty" (no attachments, no protection). */
export interface FakeEnvelopeOptions {
  readonly subject?: string;
  readonly from?: string | null;
  readonly to?: readonly string[];
  /** Full recipient total; defaults to `to.length` (set this explicitly to test the 20-entry cap). */
  readonly toCount?: number;
  readonly cc?: readonly string[];
  readonly ccCount?: number;
  readonly hasAttachments?: boolean;
  readonly sentDateTime?: Date | null;
  readonly protection?: ImapMessageProtection | null;
}

export interface FakeAddOptions {
  readonly flags?: readonly string[];
  readonly internalDate?: Date;
  readonly messageId?: string | null;
  readonly envelope?: FakeEnvelopeOptions;
  /** Internal: the Gmail message this copy belongs to. */
  readonly gmail?: FakeGmailMessage;
}

let messageCounter = 0;

export const GMAIL_ALL_MAIL = "[Gmail]/All Mail";

/** Gmail's system labels (X-GM-LABELS) and the SPECIAL-USE of the folder that shows them. */
const GMAIL_SYSTEM_LABELS: Record<string, string> = {
  "\\Inbox": "\\Inbox",
  "\\Sent": "\\Sent",
  "\\Draft": "\\Drafts",
  "\\Important": "\\Important",
  "\\Starred": "\\Flagged",
};

/** Who is told when mail arrives in a folder (IDLE sessions of the fake server). */
type ArrivalListener = (folder: FakeFolder) => void;

export class FakeFolder {
  readonly name: string;
  readonly parent: string[];
  readonly delimiter: string;
  /** The server's LIST answers NIL as the delimiter. */
  readonly nilDelimiter: boolean;
  readonly noUidNext: boolean;
  readonly noUidValidity: boolean;
  readonly specialUse: string | undefined;
  readonly selectable: boolean;
  uidValidity: number;
  uidNext = 1;
  readonly messages = new Map<number, FakeMessage>();
  /** Set by {@link FakeImapServer.addFolder}: IDLE sessions learn about new mail through it. */
  onArrival: ArrivalListener | null = null;

  constructor(
    readonly path: string,
    options: FakeFolderOptions = {},
  ) {
    this.nilDelimiter = options.delimiter === null;
    this.noUidNext = options.noUidNext === true;
    this.noUidValidity = options.noUidValidity === true;
    this.delimiter = options.delimiter ?? (this.nilDelimiter ? "" : "/");
    const parts = this.delimiter === "" ? [path] : path.split(this.delimiter);
    this.name = parts[parts.length - 1];
    this.parent = parts.slice(0, -1);
    this.specialUse =
      options.specialUse ?? (path.toUpperCase() === "INBOX" ? "\\Inbox" : undefined);
    this.selectable = options.selectable ?? true;
    this.uidValidity = options.uidValidity ?? 1000;
  }

  add(source: Buffer | string, options: FakeAddOptions = {}): FakeMessage {
    const uid = this.uidNext++;
    messageCounter++;
    const env = options.envelope ?? {};
    const envelope: ImapEnvelopeMeta = {
      subject: env.subject ?? "",
      from: env.from ?? null,
      to: env.to ?? [],
      toCount: env.toCount ?? env.to?.length ?? 0,
      cc: env.cc ?? [],
      ccCount: env.ccCount ?? env.cc?.length ?? 0,
      hasAttachments: env.hasAttachments ?? false,
      sentDateTime: env.sentDateTime ?? null,
      protection: env.protection ?? null,
    };
    const message: FakeMessage = {
      uid,
      flags: [...(options.flags ?? [])],
      internalDate:
        options.internalDate ?? new Date(Date.UTC(2026, 0, 1, 12, 0, messageCounter % 60)),
      source: Buffer.isBuffer(source) ? source : Buffer.from(source, "utf8"),
      messageId:
        options.messageId === undefined ? `<msg-${messageCounter}@fake.test>` : options.messageId,
      envelope,
      ...(options.gmail ? { gmail: options.gmail } : {}),
    };
    this.messages.set(uid, message);
    this.onArrival?.(this);
    return message;
  }

  delete(uid: number): void {
    this.messages.delete(uid);
  }

  setFlags(uid: number, flags: readonly string[]): void {
    const message = this.messages.get(uid);
    if (!message) {
      throw new Error(`no message ${uid} in ${this.path}`);
    }
    message.flags = [...flags];
  }

  /** What a mailbox rebuild does: a new UIDVALIDITY and every message renumbered from 1. */
  resetUidValidity(newValidity = this.uidValidity + 1): void {
    const ordered = [...this.messages.values()];
    this.messages.clear();
    this.uidValidity = newValidity;
    this.uidNext = 1;
    for (const message of ordered) {
      const uid = this.uidNext++;
      this.messages.set(uid, { ...message, uid });
    }
  }

  uids(): number[] {
    return [...this.messages.keys()].sort((a, b) => a - b);
  }
}

export interface FakeServerStats {
  connects: number;
  open: number;
  maxConcurrent: number;
  listFolders: number;
  opens: number;
  listFlags: number;
  /** Of `listFlags`, how many asked for X-GM-LABELS. */
  listFlagsWithLabels: number;
  metaFetches: number;
  /** STATUS commands (archive capture). */
  statusCalls: number;
  /** IDLE iterations started (archive capture). */
  idles: number;
  /** Every UID whose source was delivered, as "<folder>:<uid>". */
  sourcesDelivered: string[];
}

export interface FakeServerFaults {
  /** Reject every login. */
  rejectAuth: boolean;
  /** Fail the next N connects with a transport error. */
  connectFailures: number;
  /** Folders whose EXAMINE always fails. */
  openFailures: Set<string>;
  /** "<folder>:<uid>": the connection drops (once) when this UID is about to be delivered. */
  dropOnDeliver: Set<string>;
  /** "<folder>:<uid>": the server never returns this message. */
  omit: Set<string>;
  /** "<folder>:<uid>": ENVELOPE/BODYSTRUCTURE could not be read for this message this run. */
  envelopeFailures: Set<string>;
  /** The server does not announce IDLE. */
  noIdle: boolean;
  /** "<folder>:<uid>": metadata is listed, but the source is never delivered. */
  omitSource: Set<string>;
  /** "<folder>:<uid>": a FETCH of sources that includes this UID fails with a NO (the session stays usable). */
  refuseSource: Set<string>;
  /**
   * The RFC 5530 code a {@link refuseSource} NO carries, as imapflow reports it (the error's
   * cause), e.g. "OVERQUOTA" for a provider's download cap; null: a plain NO.
   */
  refuseSourceCode: string | null;
  /** Folders whose metadata FETCH fails with a NO (EXAMINE and STATUS still work). */
  refuseMeta: Set<string>;
  /**
   * "<folder>:<uid>": a message the server cannot read (Dovecot with a corrupt or missing mail
   * file, Gmail's "Failure"). Like those servers, any UID FETCH whose set contains it, metadata
   * or body, answers `NO Some messages could not be FETCHed (Unknown error)` for the whole
   * command; sets without it answer OK. FLAGS (from the index) still lists it.
   */
  unreadable: Set<string>;
}

export class FakeImapServer implements ImapConnector {
  readonly folders = new Map<string, FakeFolder>();
  readonly stats: FakeServerStats = {
    connects: 0,
    open: 0,
    maxConcurrent: 0,
    listFolders: 0,
    opens: 0,
    listFlags: 0,
    listFlagsWithLabels: 0,
    metaFetches: 0,
    statusCalls: 0,
    idles: 0,
    sourcesDelivered: [],
  };
  readonly faults: FakeServerFaults = {
    rejectAuth: false,
    connectFailures: 0,
    openFailures: new Set(),
    dropOnDeliver: new Set(),
    omit: new Set(),
    envelopeFailures: new Set(),
    noIdle: false,
    omitSource: new Set(),
    refuseSource: new Set(),
    refuseSourceCode: null,
    refuseMeta: new Set(),
    unreadable: new Set(),
  };
  private readonly arrivalListeners = new Set<ArrivalListener>();
  /**
   * Credentials seen by connect: the login, the credential kind, and (for
   * assertions on per-mailbox and master-user auth) the password / OAuth2
   * token and SASL authzid actually presented.
   */
  readonly logins: Array<{
    user: string;
    kind: ImapCredential["kind"];
    password?: string;
    accessToken?: string;
    authzid?: string;
  }> = [];
  /** Called after each delivered source; tests use it to cancel mid-run. */
  onDelivered: ((folder: string, uid: number) => void) | null = null;
  /** The server announces X-GM-EXT-1 (Gmail): FETCH answers X-GM-LABELS. */
  gmailExtensions = false;

  /**
   * A Gmail account as imap.gmail.com lists it: INBOX, the `[Gmail]` container with All Mail
   * (`\\All`), Sent Mail, Drafts, Starred, Important, Spam and Trash, plus the user labels
   * given, and X-GM-EXT-1. `allMailHidden`: the user unticked "Show in IMAP" for All Mail.
   */
  setupGmail(
    options: { readonly labels?: readonly string[]; readonly allMailHidden?: boolean } = {},
  ): void {
    this.gmailExtensions = true;
    this.addFolder("INBOX");
    this.addFolder("[Gmail]", { selectable: false });
    if (!options.allMailHidden) {
      this.addFolder(GMAIL_ALL_MAIL, { specialUse: "\\All", uidValidity: 11 });
    }
    this.addFolder("[Gmail]/Drafts", { specialUse: "\\Drafts", uidValidity: 12 });
    this.addFolder("[Gmail]/Important", { specialUse: "\\Important", uidValidity: 13 });
    this.addFolder("[Gmail]/Sent Mail", { specialUse: "\\Sent", uidValidity: 14 });
    this.addFolder("[Gmail]/Spam", { specialUse: "\\Junk", uidValidity: 15 });
    this.addFolder("[Gmail]/Starred", { specialUse: "\\Flagged", uidValidity: 16 });
    this.addFolder("[Gmail]/Trash", { specialUse: "\\Trash", uidValidity: 17 });
    for (const label of options.labels ?? []) {
      this.addFolder(label, { uidValidity: 20 });
    }
  }

  /**
   * One Gmail message: a copy in All Mail (when listed) and one in the folder of each label,
   * each with its own UID, as Gmail's IMAP server exposes it.
   */
  addGmailMessage(
    source: Buffer | string,
    labels: readonly string[],
    options: Omit<FakeAddOptions, "gmail"> = {},
  ): FakeGmailMessage {
    const gmail: FakeGmailMessage = {
      id: String(1_600_000_000_000 + ++messageCounter),
      labels: [...labels],
      source: Buffer.isBuffer(source) ? source : Buffer.from(source, "utf8"),
      copies: new Map(),
    };
    const messageId =
      options.messageId === undefined ? `<gmail-${++messageCounter}@fake.test>` : options.messageId;
    for (const path of this.gmailFoldersOf(gmail.labels)) {
      const copy = this.folder(path).add(gmail.source, { ...options, messageId, gmail });
      gmail.copies.set(path, copy.uid);
    }
    return gmail;
  }

  /** Relabel a Gmail message: copies appear in newly labelled folders and leave the others. */
  setGmailLabels(gmail: FakeGmailMessage, labels: readonly string[]): void {
    const [firstPath, firstUid] = [...gmail.copies.entries()][0] ?? [];
    const existing =
      firstPath === undefined ? undefined : this.folder(firstPath).messages.get(firstUid as number);
    gmail.labels = [...labels];
    const wanted = new Set(this.gmailFoldersOf(gmail.labels));
    for (const [path, uid] of [...gmail.copies]) {
      if (!wanted.has(path)) {
        this.folder(path).delete(uid);
        gmail.copies.delete(path);
      }
    }
    for (const path of wanted) {
      if (!gmail.copies.has(path)) {
        const copy = this.folder(path).add(gmail.source, {
          messageId: existing?.messageId ?? null,
          ...(existing ? { internalDate: existing.internalDate } : {}),
          gmail,
        });
        gmail.copies.set(path, copy.uid);
      }
    }
  }

  private gmailFoldersOf(labels: readonly string[]): string[] {
    const paths = this.folders.has(GMAIL_ALL_MAIL) ? [GMAIL_ALL_MAIL] : [];
    for (const label of labels) {
      const special = GMAIL_SYSTEM_LABELS[label];
      const folder = special
        ? [...this.folders.values()].find((candidate) => candidate.specialUse === special)
        : this.folders.get(label);
      if (folder && !paths.includes(folder.path)) {
        paths.push(folder.path);
      }
    }
    return paths;
  }

  addFolder(path: string, options?: FakeFolderOptions): FakeFolder {
    const folder = new FakeFolder(path, options);
    folder.onArrival = (arrived) => {
      for (const listener of this.arrivalListeners) {
        listener(arrived);
      }
    };
    this.folders.set(path, folder);
    return folder;
  }

  /** IDLE sessions subscribe here; returns the unsubscribe. */
  onArrival(listener: ArrivalListener): () => void {
    this.arrivalListeners.add(listener);
    return () => this.arrivalListeners.delete(listener);
  }

  /** Drop every open session, as a server restart would (IDLE sessions end with an error). */
  dropAll(): void {
    for (const listener of [...this.dropListeners]) {
      listener();
    }
  }

  /** Sessions register here to be dropped by {@link dropAll}. */
  readonly dropListeners = new Set<() => void>();

  folder(path: string): FakeFolder {
    const folder = this.folders.get(path);
    if (!folder) {
      throw new Error(`fake server has no folder ${path}`);
    }
    return folder;
  }

  async connect(
    account: ImapAccountConfig,
    credential: ImapCredential,
    _options: ImapConnectOptions,
  ): Promise<ImapSession> {
    await tick();
    this.stats.connects++;
    if (this.faults.connectFailures > 0) {
      this.faults.connectFailures--;
      throw new ImapSessionError("connect ECONNREFUSED", true);
    }
    if (this.faults.rejectAuth) {
      throw new ImapAuthError(
        "authentication failed",
        "[AUTHENTICATIONFAILED] Invalid credentials",
      );
    }
    this.logins.push({
      user: account.username,
      kind: credential.kind,
      ...(credential.kind === "oauth2"
        ? { accessToken: credential.accessToken }
        : { password: credential.password }),
      ...(account.authzid ? { authzid: account.authzid } : {}),
    });
    this.stats.open++;
    this.stats.maxConcurrent = Math.max(this.stats.maxConcurrent, this.stats.open);
    return new FakeSession(this);
  }

  sessionClosed(): void {
    this.stats.open--;
  }
}

class FakeSession implements ImapSession {
  usable = true;
  private current: FakeFolder | null = null;
  private readonly drop = () => {
    if (this.usable) {
      this.usable = false;
      this.server.sessionClosed();
    }
    this.server.dropListeners.delete(this.drop);
    this.wakeIdle?.();
  };
  private wakeIdle: (() => void) | null = null;

  constructor(private readonly server: FakeImapServer) {
    server.dropListeners.add(this.drop);
  }

  get idleSupported(): boolean {
    return !this.server.faults.noIdle;
  }

  async status(path: string): Promise<ImapFolderStatus> {
    await this.command();
    this.server.stats.statusCalls++;
    const folder = this.server.folders.get(path);
    if (!folder?.selectable || this.server.faults.openFailures.has(path)) {
      throw new ImapSessionError(`STATUS ${path}: NO Mailbox does not exist`, false);
    }
    return {
      path,
      uidValidity: String(folder.uidValidity),
      uidNext: folder.uidNext,
      exists: folder.messages.size,
    };
  }

  async uidsAbove(uid: number): Promise<number[]> {
    await this.command();
    return this.requireFolder()
      .uids()
      .filter((value) => value > uid);
  }

  async *idle(signal: AbortSignal): AsyncIterable<"exists"> {
    // Subscribed before the first await, so mail added right after `next()` is seen.
    const folder = this.current;
    let arrived = false;
    const wake = () => {
      const resolve = this.wakeIdle;
      this.wakeIdle = null;
      resolve?.();
    };
    const unsubscribe = this.server.onArrival((changed) => {
      if (changed === folder) {
        arrived = true;
        wake();
      }
    });
    try {
      await this.command();
    } catch (error) {
      unsubscribe();
      throw error;
    }
    if (this.server.faults.noIdle || !folder) {
      unsubscribe();
      throw new ImapSessionError(
        folder ? "IDLE: BAD Unknown command" : "no folder selected",
        false,
      );
    }
    this.server.stats.idles++;
    signal.addEventListener("abort", wake, { once: true });
    try {
      while (!signal.aborted) {
        if (!this.usable) {
          throw new ImapSessionError("connection closed during IDLE", true);
        }
        if (arrived) {
          arrived = false;
          yield "exists";
          continue;
        }
        await new Promise<void>((resolve) => {
          this.wakeIdle = resolve;
        });
      }
    } finally {
      unsubscribe();
      signal.removeEventListener("abort", wake);
    }
  }

  async listFolders(): Promise<ImapFolderInfo[]> {
    await this.command();
    this.server.stats.listFolders++;
    return [...this.server.folders.values()].map((folder) => ({
      path: folder.path,
      name: folder.name,
      parent: [...folder.parent],
      // As imapflow reports a NIL delimiter: null.
      delimiter: folder.nilDelimiter ? (null as unknown as string) : folder.delimiter,
      selectable: folder.selectable,
      ...(folder.specialUse ? { specialUse: folder.specialUse } : {}),
    }));
  }

  async openFolder(path: string): Promise<ImapFolderStatus> {
    await this.command();
    this.server.stats.opens++;
    if (this.server.faults.openFailures.has(path)) {
      throw new ImapSessionError(`EXAMINE ${path}: NO Mailbox does not exist`, false);
    }
    const folder = this.server.folders.get(path);
    if (!folder?.selectable) {
      throw new ImapSessionError(`EXAMINE ${path}: NO Mailbox does not exist`, false);
    }
    if (folder.noUidValidity) {
      // What ImapFlowSession.openFolder throws for an EXAMINE without OK [UIDVALIDITY].
      throw new ImapSessionError(
        `EXAMINE ${path}: the server sent no UIDVALIDITY, so its UIDs cannot be tracked`,
        false,
      );
    }
    this.current = folder;
    return {
      path,
      uidValidity: String(folder.uidValidity),
      // As imapflow reports an EXAMINE without OK [UIDNEXT]: undefined.
      uidNext: folder.noUidNext ? (undefined as unknown as number) : folder.uidNext,
      exists: folder.messages.size,
    };
  }

  get gmailExtensions(): boolean {
    return this.server.gmailExtensions;
  }

  async listFlags(options: ImapListFlagsOptions = {}): Promise<ImapMessageFlags[]> {
    await this.command();
    this.server.stats.listFlags++;
    // As imapflow: X-GM-LABELS is only asked for on a server that announced X-GM-EXT-1.
    const labels = options.labels === true && this.server.gmailExtensions;
    const gmailIds = options.gmailIds === true && this.server.gmailExtensions;
    if (labels) {
      this.server.stats.listFlagsWithLabels++;
    }
    const folder = this.requireFolder();
    return folder.uids().map((uid) => {
      const message = folder.messages.get(uid) as FakeMessage;
      return {
        uid,
        flags: [...message.flags],
        ...(labels ? { labels: [...(message.gmail?.labels ?? [])] } : {}),
        ...(gmailIds && message.gmail ? { gmailMessageId: message.gmail.id } : {}),
      };
    });
  }

  async fetchMeta(uids: readonly number[]): Promise<ImapMessageMeta[]> {
    await this.command();
    this.server.stats.metaFetches++;
    const folder = this.requireFolder();
    if (this.server.faults.refuseMeta.has(folder.path)) {
      throw new ImapSessionError(
        `UID FETCH: NO [SERVERBUG] Internal error in ${folder.path}`,
        false,
      );
    }
    this.refuseUnreadable(folder, uids, "(UID RFC822.SIZE FLAGS INTERNALDATE ENVELOPE)");
    const result: ImapMessageMeta[] = [];
    for (const uid of [...uids].sort((a, b) => a - b)) {
      const key = `${folder.path}:${uid}`;
      const message = folder.messages.get(uid);
      if (!message || this.server.faults.omit.has(key)) {
        continue;
      }
      result.push({
        uid,
        size: message.source.length,
        flags: [...message.flags],
        internalDate: message.internalDate,
        messageId: message.messageId,
        ...(this.server.faults.envelopeFailures.has(key) ? {} : { envelope: message.envelope }),
      });
    }
    return result;
  }

  async *fetchSources(uids: readonly number[]): AsyncIterable<ImapMessageSource> {
    await this.command();
    const folder = this.requireFolder();
    if (uids.some((uid) => this.server.faults.refuseSource.has(`${folder.path}:${uid}`))) {
      const code = this.server.faults.refuseSourceCode;
      const text = code ? "Account exceeded download limits" : "The message could not be retrieved";
      const cause = Object.assign(new Error("Command failed"), {
        responseStatus: "NO",
        responseText: text,
        executedCommand: `1F UID FETCH ${uids.join(",")} (UID BODY.PEEK[])`,
        ...(code ? { serverResponseCode: code } : {}),
      });
      throw new ImapSessionError(`UID FETCH: NO ${text}`, false, { cause });
    }
    this.refuseUnreadable(folder, uids, "(UID BODY.PEEK[])");
    for (const uid of [...uids].sort((a, b) => a - b)) {
      await tick();
      const key = `${folder.path}:${uid}`;
      if (this.server.faults.dropOnDeliver.has(key)) {
        this.server.faults.dropOnDeliver.delete(key);
        this.usable = false;
        this.server.sessionClosed();
        throw new ImapSessionError("read ECONNRESET", true);
      }
      const message = folder.messages.get(uid);
      if (!message || this.server.faults.omit.has(key) || this.server.faults.omitSource.has(key)) {
        continue;
      }
      this.server.stats.sourcesDelivered.push(key);
      yield {
        uid,
        size: message.source.length,
        flags: [...message.flags],
        internalDate: message.internalDate,
        messageId: message.messageId,
        ...(this.server.faults.envelopeFailures.has(key) ? {} : { envelope: message.envelope }),
        source: Buffer.from(message.source),
      };
      this.server.onDelivered?.(folder.path, uid);
    }
  }

  async closeFolder(): Promise<void> {
    await this.command();
    this.current = null;
  }

  async logout(): Promise<void> {
    if (this.usable) {
      this.usable = false;
      this.server.sessionClosed();
    }
    this.server.dropListeners.delete(this.drop);
    this.wakeIdle?.();
  }

  private async command(): Promise<void> {
    await tick();
    if (!this.usable) {
      throw new ImapSessionError("connection is closed", true);
    }
  }

  /** Dovecot's answer to a FETCH over a set with a message it cannot read: NO for all of it. */
  private refuseUnreadable(folder: FakeFolder, uids: readonly number[], items: string): void {
    if (!uids.some((uid) => this.server.faults.unreadable.has(`${folder.path}:${uid}`))) {
      return;
    }
    const text = "Some messages could not be FETCHed (Unknown error)";
    const cause = Object.assign(new Error("Command failed"), {
      responseStatus: "NO",
      responseText: text,
      executedCommand: `1F UID FETCH ${uids.join(",")} ${items}`,
    });
    throw new ImapSessionError(`UID FETCH: NO ${text}`, false, { cause });
  }

  private requireFolder(): FakeFolder {
    if (!this.current) {
      throw new ImapSessionError("no folder selected", false);
    }
    return this.current;
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
