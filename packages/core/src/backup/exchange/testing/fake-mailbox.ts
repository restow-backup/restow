/**
 * An in-memory Exchange mailbox for engine tests. It answers the Graph routes
 * the backup engine uses (folder tree via $batch, per-folder message delta
 * with skip and delta tokens, MIME via $value with the JSON fallback,
 * calendars, events, instances, contact folders, contacts) from a mutable
 * model, so a test can mutate the mailbox between runs and observe exactly
 * what the engine fetches. Delta semantics follow Graph: an initial run pages
 * through everything and ends with a delta link; an incremental run returns
 * changes since the token, deletions as `@removed`; an invalidated token
 * answers 410 Gone with `SyncStateNotFound`.
 */
import type { Contact, Event, Recipient } from "@microsoft/microsoft-graph-types";
import type {
  FixtureResponse,
  FixtureRoute,
  RecordedCall,
} from "../../../graph/testing/fake-graph.js";
import { batchEnvelope, graphError } from "../../../graph/testing/fake-graph.js";

export interface FakeFolder {
  id: string;
  displayName: string;
  /** `null` for a top-level folder. */
  parentFolderId: string | null;
  isHidden?: boolean;
  wellKnownName?: string;
}

export interface FakeAttachment {
  id: string;
  name: string;
  contentType: string;
  bytes: Uint8Array;
  isInline?: boolean;
  odataType?: string;
}

export interface FakeMessage {
  id: string;
  folderId: string;
  subject: string;
  internetMessageId: string;
  receivedDateTime: string;
  lastModifiedDateTime: string;
  isRead: boolean;
  flagStatus: "notFlagged" | "flagged" | "complete";
  categories: string[];
  hasAttachments: boolean;
  isDraft?: boolean;
  bodyPreview?: string;
  importance?: "low" | "normal" | "high";
  from?: Recipient;
  to?: Recipient[];
  cc?: Recipient[];
  /** Only consulted for the oversized-message JSON fallback (`internetMessageHeaders` in `$select`). */
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  mime: string;
  /** Graph refuses the MIME export (413) and the engine must fall back to JSON plus attachments. */
  mimeTooLarge?: boolean;
  attachments?: FakeAttachment[];
  /** Responses served for `$value` before the real one (e.g. a 429, or a 404 forever). */
  mimeResponses?: FixtureResponse[];
}

export interface FakeCalendar {
  id: string;
  name: string;
  isDefaultCalendar?: boolean;
}

export interface FakeEvent extends Event {
  id: string;
  calendarId: string;
  /** Modified occurrences, for series masters. */
  exceptions?: Event[];
}

export interface FakeContactFolder {
  id: string;
  displayName: string;
  parentFolderId: string | null;
}

export interface FakeContact extends Contact {
  id: string;
  /** `null` for the default contacts folder. */
  folderId: string | null;
}

interface ChangeLogEntry {
  version: number;
  folderId: string;
  messageId: string;
  removed: boolean;
}

/** Answers one route; `ids` are the pattern's captured, URI-decoded path segments. */
type RouteHandler = (ids: string[], params: URLSearchParams) => FixtureResponse;

/** The `$select` list of a request. */
function selectOf(params: URLSearchParams): string[] {
  return (params.get("$select") ?? "").split(",").filter((s) => s.length > 0);
}

export const ROOT_FOLDER_ID = "AAMkRoot";

/** Build a MIME body for a fake message. */
export function mimeFor(
  message: Pick<FakeMessage, "subject" | "internetMessageId">,
  body = "Hello",
): string {
  return [
    "From: Alice Example <alice@contoso.example>",
    "To: Bob Example <bob@contoso.example>",
    `Subject: ${message.subject}`,
    "Date: Tue, 1 Sep 2026 10:15:00 +0200",
    `Message-ID: ${message.internetMessageId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
    "",
  ].join("\r\n");
}

export class FakeMailbox {
  readonly folders = new Map<string, FakeFolder>();
  readonly messages = new Map<string, FakeMessage>();
  readonly calendars = new Map<string, FakeCalendar>();
  readonly events = new Map<string, FakeEvent>();
  readonly contactFolders = new Map<string, FakeContactFolder>();
  readonly contacts = new Map<string, FakeContact>();
  /** Delta page size for initial enumerations. */
  pageSize = 2;
  /** Hook run before every request; may return a response to short-circuit. */
  intercept: ((call: RecordedCall) => FixtureResponse | undefined) | undefined;

  private version = 0;
  private readonly log: ChangeLogEntry[] = [];
  /** Delta tokens issued before this version are gone (per folder). */
  private readonly invalidatedBefore = new Map<string, number>();
  private clock = Date.parse("2026-09-10T08:00:00Z");

  constructor(readonly userId: string) {}

  // -- mutation -------------------------------------------------------------

  private tick(): string {
    this.clock += 60_000;
    this.version += 1;
    return new Date(this.clock).toISOString();
  }

  addFolder(folder: FakeFolder): FakeFolder {
    this.folders.set(folder.id, folder);
    return folder;
  }

  renameFolder(id: string, displayName: string): void {
    const folder = this.folders.get(id);
    if (!folder) {
      throw new Error(`no folder ${id}`);
    }
    folder.displayName = displayName;
    this.tick();
  }

  deleteFolder(id: string): void {
    this.folders.delete(id);
    for (const message of [...this.messages.values()]) {
      if (message.folderId === id) {
        this.messages.delete(message.id);
      }
    }
    this.tick();
  }

  addMessage(
    input: Omit<FakeMessage, "mime" | "receivedDateTime" | "lastModifiedDateTime"> &
      Partial<Pick<FakeMessage, "mime" | "receivedDateTime" | "lastModifiedDateTime">>,
  ): FakeMessage {
    const now = this.tick();
    const message: FakeMessage = {
      ...input,
      receivedDateTime: input.receivedDateTime ?? now,
      lastModifiedDateTime: input.lastModifiedDateTime ?? now,
      mime: input.mime ?? mimeFor(input, `Body of ${input.subject}`),
    };
    this.messages.set(message.id, message);
    this.log.push({
      version: this.version,
      folderId: message.folderId,
      messageId: message.id,
      removed: false,
    });
    return message;
  }

  /** Change properties; bumps lastModifiedDateTime like Exchange does. */
  updateMessage(id: string, patch: Partial<FakeMessage>): FakeMessage {
    const message = this.messages.get(id);
    if (!message) {
      throw new Error(`no message ${id}`);
    }
    Object.assign(message, patch, { lastModifiedDateTime: this.tick() });
    this.log.push({
      version: this.version,
      folderId: message.folderId,
      messageId: id,
      removed: false,
    });
    return message;
  }

  deleteMessage(id: string): void {
    const message = this.messages.get(id);
    if (!message) {
      throw new Error(`no message ${id}`);
    }
    this.messages.delete(id);
    this.tick();
    this.log.push({
      version: this.version,
      folderId: message.folderId,
      messageId: id,
      removed: true,
    });
  }

  /** Move to another folder: Graph assigns a new id, the old folder reports a removal. */
  moveMessage(id: string, folderId: string, newId: string): FakeMessage {
    const message = this.messages.get(id);
    if (!message) {
      throw new Error(`no message ${id}`);
    }
    this.deleteMessage(id);
    return this.addMessage({ ...message, id: newId, folderId });
  }

  /** Every delta token issued so far for the folder answers 410 from now on. */
  invalidateDelta(folderId: string): void {
    this.invalidatedBefore.set(folderId, this.version + 1);
    this.tick();
  }

  addCalendar(calendar: FakeCalendar): FakeCalendar {
    this.calendars.set(calendar.id, calendar);
    return calendar;
  }

  addEvent(event: FakeEvent): FakeEvent {
    const stamped = { ...event, lastModifiedDateTime: event.lastModifiedDateTime ?? this.tick() };
    this.events.set(stamped.id, stamped);
    return stamped;
  }

  updateEvent(id: string, patch: Partial<FakeEvent>): FakeEvent {
    const event = this.events.get(id);
    if (!event) {
      throw new Error(`no event ${id}`);
    }
    Object.assign(event, patch, {
      lastModifiedDateTime: this.tick(),
      changeKey: `ck-${this.version}`,
    });
    return event;
  }

  addContactFolder(folder: FakeContactFolder): FakeContactFolder {
    this.contactFolders.set(folder.id, folder);
    return folder;
  }

  addContact(contact: FakeContact): FakeContact {
    const stamped = {
      ...contact,
      lastModifiedDateTime: contact.lastModifiedDateTime ?? this.tick(),
    };
    this.contacts.set(stamped.id, stamped);
    return stamped;
  }

  updateContact(id: string, patch: Partial<FakeContact>): FakeContact {
    const contact = this.contacts.get(id);
    if (!contact) {
      throw new Error(`no contact ${id}`);
    }
    Object.assign(contact, patch, {
      lastModifiedDateTime: this.tick(),
      changeKey: `ck-${this.version}`,
    });
    return contact;
  }

  // -- routes ---------------------------------------------------------------

  routes(): FixtureRoute[] {
    return [
      { method: "POST", url: () => true, respond: (call) => this.dispatch(call) },
      { method: "GET", url: () => true, respond: (call) => this.dispatch(call) },
    ];
  }

  private dispatch(call: RecordedCall): FixtureResponse {
    const intercepted = this.intercept?.(call);
    if (intercepted) {
      return intercepted;
    }
    const url = new URL(call.url);
    if (call.method === "POST" && url.pathname.endsWith("/$batch")) {
      return batchEnvelope(call, (sub) => this.answerBatchSub(sub.url));
    }
    return this.answer(url);
  }

  private notFound(what: string): FixtureResponse {
    return { status: 404, json: graphError("ErrorItemNotFound", `${what} not found`) };
  }

  private userPrefix(): string {
    return `/v1.0/users/${encodeURIComponent(this.userId)}`;
  }

  private answerBatchSub(subUrl: string): { status: number; body?: unknown } {
    const url = new URL(subUrl, "https://graph.microsoft.com/v1.0/");
    const response = this.answer(url);
    return { status: response.status, body: response.json };
  }

  /**
   * The Graph routes the engine uses, below `/users/{id}`. Captured path
   * segments arrive URI-decoded; the first matching pattern answers.
   */
  private readonly table: ReadonlyArray<readonly [RegExp, RouteHandler]> = [
    [/^\/mailFolders$/, () => this.folderPage(null)],
    [
      /^\/mailFolders\/([^/]+)\/childFolders$/,
      ([id = ""]) => (this.folders.has(id) ? this.folderPage(id) : this.notFound("folder")),
    ],
    [
      /^\/mailFolders\/([^/]+)\/messages\/delta$/,
      ([id = ""], params) =>
        this.folders.has(id) ? this.delta(id, params) : this.notFound("folder"),
    ],
    [/^\/mailFolders\/([^/]+)$/, ([name = ""]) => this.wellKnownFolder(name)],
    [/^\/messages\/([^/]+)\/\$value$/, ([id = ""]) => this.mime(id)],
    [/^\/messages\/([^/]+)\/attachments$/, ([id = ""]) => this.attachmentList(id)],
    [
      /^\/messages\/([^/]+)\/attachments\/([^/]+)\/\$value$/,
      ([id = "", attachmentId = ""]) => this.attachmentContent(id, attachmentId),
    ],
    [
      /^\/messages\/([^/]+)$/,
      ([id = ""], params) => {
        const message = this.messages.get(id);
        return message
          ? { status: 200, json: this.messageJson(message, selectOf(params)) }
          : this.notFound("message");
      },
    ],
    [/^\/calendars$/, () => ({ status: 200, json: { value: [...this.calendars.values()] } })],
    [/^\/calendars\/([^/]+)\/events$/, ([id = ""]) => this.eventPage(id)],
    [
      /^\/events\/([^/]+)\/instances$/,
      ([id = ""]) => {
        const master = this.events.get(id);
        return master
          ? { status: 200, json: { value: master.exceptions ?? [] } }
          : this.notFound("event");
      },
    ],
    [/^\/contactFolders$/, () => this.contactFolderPage(null)],
    [/^\/contactFolders\/([^/]+)\/childFolders$/, ([id = ""]) => this.contactFolderPage(id)],
    [/^\/contacts$/, () => this.contactPage(null)],
    [/^\/contactFolders\/([^/]+)\/contacts$/, ([id = ""]) => this.contactPage(id)],
  ];

  private answer(url: URL): FixtureResponse {
    const prefix = this.userPrefix();
    const path = url.pathname.startsWith(prefix)
      ? url.pathname.slice(prefix.length)
      : url.pathname.replace(/^\/(v1\.0\/)?users\/[^/]+/, "");
    for (const [pattern, handle] of this.table) {
      const match = pattern.exec(path);
      if (match) {
        return handle(match.slice(1).map(decodeURIComponent), url.searchParams);
      }
    }
    return { status: 404, json: graphError("FakeRouteNotFound", `${url.pathname}`) };
  }

  private wellKnownFolder(name: string): FixtureResponse {
    const folder = [...this.folders.values()].find((f) => f.wellKnownName === name);
    return folder ? { status: 200, json: { id: folder.id } } : this.notFound("well-known folder");
  }

  private attachmentList(messageId: string): FixtureResponse {
    const message = this.messages.get(messageId);
    if (!message) {
      return this.notFound("message");
    }
    return {
      status: 200,
      json: {
        value: (message.attachments ?? []).map((a) => ({
          "@odata.type": a.odataType ?? "#microsoft.graph.fileAttachment",
          id: a.id,
          name: a.name,
          contentType: a.contentType,
          size: a.bytes.length,
          isInline: a.isInline ?? false,
          lastModifiedDateTime: message.lastModifiedDateTime,
        })),
      },
    };
  }

  private attachmentContent(messageId: string, attachmentId: string): FixtureResponse {
    const attachment = this.messages
      .get(messageId)
      ?.attachments?.find((a) => a.id === attachmentId);
    return attachment ? { status: 200, bytes: attachment.bytes } : this.notFound("attachment");
  }

  private eventPage(calendarId: string): FixtureResponse {
    if (!this.calendars.has(calendarId)) {
      return this.notFound("calendar");
    }
    const events = [...this.events.values()]
      .filter((e) => e.calendarId === calendarId)
      .map((e) => this.eventJson(e));
    return { status: 200, json: { value: events } };
  }

  private folderPage(parentId: string | null): FixtureResponse {
    const children = [...this.folders.values()].filter((f) => f.parentFolderId === parentId);
    return {
      status: 200,
      json: {
        value: children.map((f) => ({
          id: f.id,
          displayName: f.displayName,
          parentFolderId: f.parentFolderId ?? ROOT_FOLDER_ID,
          childFolderCount: [...this.folders.values()].filter((c) => c.parentFolderId === f.id)
            .length,
          totalItemCount: [...this.messages.values()].filter((m) => m.folderId === f.id).length,
          unreadItemCount: 0,
          isHidden: f.isHidden ?? false,
        })),
      },
    };
  }

  private deltaEntry(message: FakeMessage, select: string[]): Record<string, unknown> {
    return this.project(this.properties(message), select);
  }

  /** Keep the `$select`ed properties (plus the id); everything when nothing was selected. */
  private project(full: Record<string, unknown>, select: string[]): Record<string, unknown> {
    if (select.length === 0) {
      return full;
    }
    const entry: Record<string, unknown> = { id: full.id };
    for (const property of select) {
      if (property in full) {
        entry[property] = full[property];
      }
    }
    return entry;
  }

  private properties(message: FakeMessage): Record<string, unknown> {
    return {
      id: message.id,
      internetMessageId: message.internetMessageId,
      subject: message.subject,
      receivedDateTime: message.receivedDateTime,
      lastModifiedDateTime: message.lastModifiedDateTime,
      isRead: message.isRead,
      flag: { flagStatus: message.flagStatus },
      categories: message.categories,
      hasAttachments: message.hasAttachments,
      parentFolderId: message.folderId,
      isDraft: message.isDraft ?? false,
      bodyPreview: message.bodyPreview ?? "",
      importance: message.importance ?? "normal",
      from: message.from ?? null,
      toRecipients: message.to ?? [],
      ccRecipients: message.cc ?? [],
      internetMessageHeaders: message.internetMessageHeaders ?? [],
    };
  }

  private delta(folderId: string, params: URLSearchParams): FixtureResponse {
    const select = selectOf(params);
    const deltaToken = params.get("$deltatoken");
    const skipToken = params.get("$skiptoken");
    const base = `https://graph.microsoft.com/v1.0/users/${this.userId}/mailFolders/${folderId}/messages/delta?$select=${select.join(",")}`;

    if (deltaToken) {
      const [tokenFolder, versionText] = deltaToken.split(":");
      const since = Number(versionText);
      if (tokenFolder !== folderId || Number.isNaN(since)) {
        return { status: 400, json: graphError("BadRequest", "malformed delta token") };
      }
      const gone = this.invalidatedBefore.get(folderId) ?? 0;
      if (since < gone) {
        return {
          status: 410,
          json: graphError("SyncStateNotFound", "The sync state is not found; resync required."),
        };
      }
      const latest = new Map<string, ChangeLogEntry>();
      for (const entry of this.log) {
        if (entry.folderId === folderId && entry.version > since) {
          latest.set(entry.messageId, entry);
        }
      }
      const value: unknown[] = [];
      for (const entry of latest.values()) {
        const message = this.messages.get(entry.messageId);
        if (entry.removed || !message || message.folderId !== folderId) {
          value.push({ "@removed": { reason: "deleted" }, id: entry.messageId });
        } else {
          value.push(this.deltaEntry(message, select));
        }
      }
      return {
        status: 200,
        json: { value, "@odata.deltaLink": `${base}&$deltatoken=${folderId}:${this.version}` },
      };
    }

    const all = [...this.messages.values()]
      .filter((m) => m.folderId === folderId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let page = 0;
    let snapshotVersion = this.version;
    if (skipToken) {
      const [tokenFolder, pageText, versionText] = skipToken.split(":");
      if (tokenFolder !== folderId) {
        return { status: 400, json: graphError("BadRequest", "malformed skip token") };
      }
      page = Number(pageText);
      snapshotVersion = Number(versionText);
    }
    const start = page * this.pageSize;
    const value = all.slice(start, start + this.pageSize).map((m) => this.deltaEntry(m, select));
    const hasMore = start + this.pageSize < all.length;
    return {
      status: 200,
      json: hasMore
        ? {
            value,
            "@odata.nextLink": `${base}&$skiptoken=${folderId}:${page + 1}:${snapshotVersion}`,
          }
        : { value, "@odata.deltaLink": `${base}&$deltatoken=${folderId}:${this.version}` },
    };
  }

  private readonly mimeServed = new Map<string, number>();

  private mime(messageId: string): FixtureResponse {
    const message = this.messages.get(messageId);
    if (!message) {
      return this.notFound("message");
    }
    const served = this.mimeServed.get(messageId) ?? 0;
    this.mimeServed.set(messageId, served + 1);
    const scripted = message.mimeResponses?.[served];
    if (scripted) {
      return scripted;
    }
    if (message.mimeTooLarge) {
      return {
        status: 413,
        json: graphError("ErrorMessageSizeExceeded", "The message exceeds the maximum size."),
      };
    }
    return { status: 200, headers: { "content-type": "message/rfc822" }, text: message.mime };
  }

  private messageJson(message: FakeMessage, select: string[]): Record<string, unknown> {
    const full = {
      ...this.properties(message),
      body: { contentType: "text", content: `Body of ${message.subject}` },
    };
    return this.project(full, select);
  }

  private eventJson(event: FakeEvent): Event {
    const { calendarId: _calendarId, exceptions: _exceptions, ...rest } = event;
    return rest;
  }

  private contactFolderPage(parentId: string | null): FixtureResponse {
    const folders = [...this.contactFolders.values()].filter((f) => f.parentFolderId === parentId);
    return {
      status: 200,
      json: {
        value: folders.map((f) => ({
          id: f.id,
          displayName: f.displayName,
          parentFolderId: f.parentFolderId ?? "cf-root",
        })),
      },
    };
  }

  private contactPage(folderId: string | null): FixtureResponse {
    if (folderId !== null && !this.contactFolders.has(folderId)) {
      return this.notFound("contact folder");
    }
    const contacts = [...this.contacts.values()]
      .filter((c) => c.folderId === folderId)
      .map(({ folderId: _folderId, ...rest }) => rest);
    return { status: 200, json: { value: contacts } };
  }
}
