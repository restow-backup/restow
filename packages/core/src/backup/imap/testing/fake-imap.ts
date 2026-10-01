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
}

export interface FakeFolderOptions {
  readonly delimiter?: string;
  readonly specialUse?: string;
  readonly selectable?: boolean;
  readonly uidValidity?: number;
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
}

let messageCounter = 0;

export class FakeFolder {
  readonly name: string;
  readonly parent: string[];
  readonly delimiter: string;
  readonly specialUse: string | undefined;
  readonly selectable: boolean;
  uidValidity: number;
  uidNext = 1;
  readonly messages = new Map<number, FakeMessage>();

  constructor(
    readonly path: string,
    options: FakeFolderOptions = {},
  ) {
    this.delimiter = options.delimiter ?? "/";
    const parts = path.split(this.delimiter);
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
    };
    this.messages.set(uid, message);
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
  metaFetches: number;
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
    metaFetches: 0,
    sourcesDelivered: [],
  };
  readonly faults: FakeServerFaults = {
    rejectAuth: false,
    connectFailures: 0,
    openFailures: new Set(),
    dropOnDeliver: new Set(),
    omit: new Set(),
    envelopeFailures: new Set(),
  };
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

  addFolder(path: string, options?: FakeFolderOptions): FakeFolder {
    const folder = new FakeFolder(path, options);
    this.folders.set(path, folder);
    return folder;
  }

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

  constructor(private readonly server: FakeImapServer) {}

  async listFolders(): Promise<ImapFolderInfo[]> {
    await this.command();
    this.server.stats.listFolders++;
    return [...this.server.folders.values()].map((folder) => ({
      path: folder.path,
      name: folder.name,
      parent: [...folder.parent],
      delimiter: folder.delimiter,
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
    if (!folder || !folder.selectable) {
      throw new ImapSessionError(`EXAMINE ${path}: NO Mailbox does not exist`, false);
    }
    this.current = folder;
    return {
      path,
      uidValidity: String(folder.uidValidity),
      uidNext: folder.uidNext,
      exists: folder.messages.size,
    };
  }

  async listFlags(): Promise<ImapMessageFlags[]> {
    await this.command();
    this.server.stats.listFlags++;
    const folder = this.requireFolder();
    return folder.uids().map((uid) => {
      const message = folder.messages.get(uid) as FakeMessage;
      return { uid, flags: [...message.flags] };
    });
  }

  async fetchMeta(uids: readonly number[]): Promise<ImapMessageMeta[]> {
    await this.command();
    this.server.stats.metaFetches++;
    const folder = this.requireFolder();
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
      if (!message || this.server.faults.omit.has(key)) {
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
  }

  private async command(): Promise<void> {
    await tick();
    if (!this.usable) {
      throw new ImapSessionError("connection is closed", true);
    }
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
