/**
 * A stateful fake of the Graph mailbox endpoints the Exchange restore uses:
 * mail folders, messages, calendars, events, contact folders and contacts.
 * Built on {@link createFakeGraph}, so every request is recorded and nothing
 * touches the network.
 */
import {
  batchEnvelope,
  createFakeGraph,
  type FakeGraph,
  type FixtureResponse,
  type FixtureRoute,
  graphError,
  type RecordedCall,
} from "../../graph/testing/fake-graph.js";

export interface FakeMailFolder {
  id: string;
  displayName: string;
  parentFolderId: string | null;
}

export interface FakeMessage {
  id: string;
  parentFolderId: string;
  internetMessageId: string | undefined;
  subject: string | undefined;
  /** The decoded MIME as received, for byte comparisons. */
  mime: string | undefined;
  json: Record<string, unknown> | undefined;
  patches: Record<string, unknown>[];
  attachments: Record<string, unknown>[];
  /** What Graph reports for the created item. */
  isDraft: boolean;
  receivedDateTime: string;
  sentDateTime: string | null;
}

/** The session id in an attachment upload URL. */
function uploadIdOf(call: RecordedCall): string {
  return /AttachmentSessions\('([^']+)'\)/.exec(decodeURIComponent(call.url))?.[1] ?? "";
}

/** Host of the pre-authenticated attachment upload URLs. */
const UPLOAD_HOST = "outlook.office.example";

/** The time the fake stamps on an item created without its own dates. */
export const FAKE_CREATED_AT = "2026-09-22T14:31:07Z";

/** Graph's answer to a create whose custom headers include a standard header. */
function invalidHeader(name: string): FixtureResponse {
  return {
    status: 400,
    json: graphError(
      "InvalidInternetMessageHeader",
      `The internet message header name '${name}' should start with 'x-' or 'X-'.`,
    ),
  };
}

/**
 * The extended properties Graph honours on a create from JSON:
 * PidTagMessageFlags (0x0E07) decides the draft state (no property, or the
 * unsent bit 0x8: a draft), PidTagMessageDeliveryTime (0x0E06) and
 * PidTagClientSubmitTime (0x0039) the received and sent times.
 */
function extendedProperty(json: Record<string, unknown>, id: string): string | undefined {
  const list = Array.isArray(json.singleValueExtendedProperties)
    ? (json.singleValueExtendedProperties as Array<{ id?: unknown; value?: unknown }>)
    : [];
  const found = list.find(
    (entry) => typeof entry.id === "string" && entry.id.toLowerCase() === id.toLowerCase(),
  );
  return typeof found?.value === "string" ? found.value : undefined;
}

export interface FakeCalendar {
  id: string;
  name: string;
  isDefaultCalendar: boolean;
}

export interface FakeEvent {
  id: string;
  calendarId: string;
  body: Record<string, unknown>;
  iCalUId: string;
  patches: Record<string, unknown>[];
  attachments: Record<string, unknown>[];
}

export interface FakeContactFolder {
  id: string;
  displayName: string;
  parentFolderId: string | null;
}

export interface FakeContact {
  id: string;
  folderId: string | null;
  body: Record<string, unknown>;
}

const NOT_FOUND: FixtureResponse = { status: 404, json: graphError("ErrorItemNotFound") };
const TOO_LARGE: FixtureResponse = {
  status: 413,
  json: graphError("RequestBodyTooLarge", "The request body exceeds the maximum size"),
};

function unquote(filterValue: string): string {
  const match = /^'(.*)'$/.exec(filterValue);
  return (match ? match[1] : filterValue)?.replace(/''/g, "'") ?? "";
}

/** `displayName eq 'x'` -> ["displayName", "x"]. */
function parseEqFilter(url: URL): [string, string] | null {
  const filter = url.searchParams.get("$filter");
  const match = filter ? /^(\w+)\s+eq\s+(.+)$/.exec(filter) : null;
  return match ? [match[1] as string, unquote(match[2] as string)] : null;
}

function segment(url: URL, after: string): string | null {
  const parts = url.pathname.split("/");
  const index = parts.indexOf(after);
  return index === -1 || index + 1 >= parts.length
    ? null
    : decodeURIComponent(parts[index + 1] as string);
}

export class FakeMailbox {
  readonly folders = new Map<string, FakeMailFolder>();
  readonly messages = new Map<string, FakeMessage>();
  readonly calendars = new Map<string, FakeCalendar>();
  readonly events = new Map<string, FakeEvent>();
  readonly contactFolders = new Map<string, FakeContactFolder>();
  readonly contacts = new Map<string, FakeContact>();
  readonly graph: FakeGraph;
  private counter = 0;
  /** Occurrences the fake reports for `/events/{id}/instances`, by the master's subject. */
  readonly occurrences = new Map<string, Array<Record<string, unknown>>>();
  /** Graph without support for the extended properties of a create: every JSON create is a draft dated now. */
  ignoresExtendedProperties = false;
  /** When set, MIME imports with a longer base64 body are refused with 413. */
  maxMimeBytes: number | null = null;
  /** Graph's limit for one request body; a longer POST is refused with 413. */
  maxRequestBytes = 4 * 1024 * 1024;
  /** Attachments of at least this size need an upload session; a POST of one is refused. */
  readonly minUploadSessionBytes = 3 * 1024 * 1024;
  /** Largest attachment an upload session takes. */
  maxAttachmentBytes = 150 * 1024 * 1024;
  /** The next attachment fragments PUT at these offsets are refused with 502 (once each). */
  readonly failAttachmentFragmentsAt: number[] = [];
  /** Upload sessions cancelled with DELETE. */
  readonly cancelledUploads: string[] = [];
  /** Open attachment upload sessions by id. */
  private readonly uploads = new Map<
    string,
    {
      messageId: string;
      holder: { attachments: Record<string, unknown>[] };
      item: Record<string, unknown>;
      size: number;
      parts: Buffer[];
      received: number;
    }
  >();

  constructor() {
    this.addFolder("Inbox", null, "wk-inbox");
    this.addFolder("Sent Items", null, "wk-sentitems");
    this.addFolder("Deleted Items", null, "wk-deleteditems");
    this.calendars.set("cal-default", {
      id: "cal-default",
      name: "Calendar",
      isDefaultCalendar: true,
    });
    this.graph = createFakeGraph(this.routes().map((route) => this.withFaults(route)));
  }

  /**
   * Faults after the commit, as Graph shows them: the request is carried
   * out, and then the gateway answers 504 or the connection breaks before the
   * answer arrives. Each fault applies to the next `times` successful calls
   * of `method` on a path matching `path`.
   */
  readonly faults: Array<{
    method: string;
    path: RegExp;
    after: "504" | "reset";
    times: number;
    visibleAfter: number;
  }> = [];

  /**
   * With `visibleAfter`, the mailbox is still working on the request when the
   * gateway gives up, as with a large import into a throttled mailbox: what
   * it creates shows in no list until that many further requests have
   * reached the mailbox.
   */
  failAfterCommit(
    method: string,
    path: RegExp,
    after: "504" | "reset" = "504",
    times = 1,
    options: { readonly visibleAfter?: number } = {},
  ): void {
    this.faults.push({ method, path, after, times, visibleAfter: options.visibleAfter ?? 0 });
  }

  /** Requests the fake has answered, the clock of {@link failAfterCommit}'s `visibleAfter`. */
  private requests = 0;
  /** What the last request created (a message, folder, attachment or contact). */
  private lastCreated: object | undefined;
  /** Items that show in no list before the request count reaches the value. */
  private readonly hiddenUntil = new Map<object, number>();

  /** Whether a list shows `item` yet. */
  private visible(item: object): boolean {
    const until = this.hiddenUntil.get(item);
    return until === undefined || this.requests >= until;
  }

  private created<T extends object>(item: T): T {
    this.lastCreated = item;
    return item;
  }

  /**
   * The attempt stops (a drain for an update, a shutdown) when it sends the
   * `nth` call of `method` on a path matching `path`: that call is never
   * carried out.
   */
  interruptAt(method: string, path: RegExp, nth = 1): void {
    this.interruptions.push({ method, path, remaining: nth });
  }

  private readonly interruptions: Array<{ method: string; path: RegExp; remaining: number }> = [];

  private withFaults(route: FixtureRoute): FixtureRoute {
    const { respond } = route;
    return {
      ...route,
      respond: (call, index) => {
        this.requests++;
        this.lastCreated = undefined;
        const stop = this.interruptions.find(
          (entry) =>
            entry.remaining > 0 &&
            entry.method === call.method &&
            entry.path.test(new URL(call.url).pathname),
        );
        if (stop !== undefined && --stop.remaining === 0) {
          throw Object.assign(new Error("the job was stopped"), { name: "JobAbortedError" });
        }
        const result =
          typeof respond === "function"
            ? respond(call, index)
            : Array.isArray(respond)
              ? (respond[Math.min(index, respond.length - 1)] as FixtureResponse)
              : respond;
        const fault = this.faults.find(
          (entry) =>
            entry.times > 0 &&
            entry.method === call.method &&
            entry.path.test(new URL(call.url).pathname),
        );
        if (!fault || result.status >= 300) {
          return result;
        }
        fault.times--;
        if (fault.visibleAfter > 0 && this.lastCreated !== undefined) {
          this.hiddenUntil.set(this.lastCreated, this.requests + fault.visibleAfter);
        }
        if (fault.after === "reset") {
          throw Object.assign(new TypeError("fetch failed"), {
            cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
          });
        }
        return {
          status: 504,
          json: graphError("GatewayTimeout", "The gateway did not receive a response"),
        };
      },
    };
  }

  nextId(prefix: string): string {
    this.counter++;
    return `${prefix}-${this.counter}`;
  }

  addFolder(displayName: string, parentFolderId: string | null, id?: string): FakeMailFolder {
    const folder = this.created({ id: id ?? this.nextId("folder"), displayName, parentFolderId });
    this.folders.set(folder.id, folder);
    return folder;
  }

  addMessage(input: {
    parentFolderId: string;
    internetMessageId?: string;
    subject?: string;
  }): FakeMessage {
    const message: FakeMessage = this.created({
      id: this.nextId("msg"),
      parentFolderId: input.parentFolderId,
      internetMessageId: input.internetMessageId,
      subject: input.subject,
      mime: undefined,
      json: undefined,
      patches: [],
      attachments: [],
      isDraft: false,
      receivedDateTime: "2026-01-15T10:30:00Z",
      sentDateTime: "2026-01-15T10:29:00Z",
    });
    this.messages.set(message.id, message);
    return message;
  }

  addContactFolder(displayName: string, parentFolderId: string | null): FakeContactFolder {
    const folder = { id: this.nextId("cfolder"), displayName, parentFolderId };
    this.contactFolders.set(folder.id, folder);
    return folder;
  }

  addContact(folderId: string | null, body: Record<string, unknown>): FakeContact {
    const contact = this.created({ id: this.nextId("contact"), folderId, body });
    this.contacts.set(contact.id, contact);
    return contact;
  }

  addEvent(calendarId: string, body: Record<string, unknown>, iCalUId: string): FakeEvent {
    const event = {
      id: this.nextId("event"),
      calendarId,
      body,
      iCalUId,
      patches: [],
      attachments: [],
    };
    this.events.set(event.id, event);
    return event;
  }

  /** Folder path (display names from the root) of a folder id. */
  folderPath(id: string): string[] {
    const folder = this.folders.get(id);
    if (!folder) {
      return [`<unknown ${id}>`];
    }
    return [
      ...(folder.parentFolderId ? this.folderPath(folder.parentFolderId) : []),
      folder.displayName,
    ];
  }

  contactFolderPath(id: string | null): string[] {
    if (id === null) {
      return [];
    }
    const folder = this.contactFolders.get(id);
    if (!folder) {
      return [`<unknown ${id}>`];
    }
    return [...this.contactFolderPath(folder.parentFolderId), folder.displayName];
  }

  private folderList(parentId: string | null, url: URL): FixtureResponse {
    const filter = parseEqFilter(url);
    const value = [...this.folders.values()]
      .filter((folder) => folder.parentFolderId === parentId && this.visible(folder))
      .filter((folder) =>
        filter && filter[0] === "displayName"
          ? folder.displayName.toLowerCase() === filter[1].toLowerCase()
          : true,
      )
      .map((folder) => ({ id: folder.id, displayName: folder.displayName }));
    return { status: 200, json: { value } };
  }

  private createFolder(parentId: string | null, call: RecordedCall): FixtureResponse {
    const body = call.json as { displayName?: string };
    if (!body.displayName) {
      return { status: 400, json: graphError("ErrorInvalidRequest") };
    }
    const name = body.displayName.toLowerCase();
    if (
      [...this.folders.values()].some(
        (folder) => folder.parentFolderId === parentId && folder.displayName.toLowerCase() === name,
      )
    ) {
      return {
        status: 409,
        json: graphError("ErrorFolderExists", "A folder with the specified name already exists."),
      };
    }
    const folder = this.addFolder(body.displayName, parentId);
    return { status: 201, json: { id: folder.id, displayName: folder.displayName } };
  }

  private messageList(url: URL): FixtureResponse {
    const folderId = segment(url, "mailFolders");
    const filter = parseEqFilter(url);
    const value = [...this.messages.values()]
      .filter((message) => this.visible(message))
      .filter((message) => (folderId ? message.parentFolderId === folderId : true))
      .filter((message) =>
        filter && filter[0] === "internetMessageId"
          ? message.internetMessageId === filter[1]
          : true,
      )
      .map((message) => ({
        id: message.id,
        parentFolderId: message.parentFolderId,
        receivedDateTime: message.receivedDateTime,
      }));
    return { status: 200, json: { value } };
  }

  private createMessage(url: URL, call: RecordedCall): FixtureResponse {
    const folderId = segment(url, "mailFolders");
    if (!folderId || !this.folders.has(folderId)) {
      return NOT_FOUND;
    }
    const isMime = (call.headers["content-type"] ?? "").startsWith("text/plain");
    const length = String(call.body ?? "").length;
    if (
      length > this.maxRequestBytes ||
      (isMime && this.maxMimeBytes !== null && length > this.maxMimeBytes)
    ) {
      return TOO_LARGE;
    }
    const json = isMime ? undefined : (call.json as Record<string, unknown>);
    if (json !== undefined && Array.isArray(json.internetMessageHeaders)) {
      for (const header of json.internetMessageHeaders as Array<{ name?: unknown }>) {
        const name = typeof header.name === "string" ? header.name : "";
        if (!/^x-/i.test(name)) {
          return invalidHeader(name);
        }
      }
    }
    const message = this.addMessage({ parentFolderId: folderId });
    if (isMime) {
      const mime = Buffer.from(String(call.body), "base64").toString("utf8");
      message.mime = mime;
      message.internetMessageId = /^Message-ID:\s*(.+)$/im.exec(mime)?.[1]?.trim();
      message.subject = /^Subject:\s*(.+)$/im.exec(mime)?.[1]?.trim();
      // Graph makes a MIME import a draft when its header lacks Date or From.
      const header = mime.split(/\r?\n\r?\n/, 1)[0] ?? "";
      message.isDraft = !(/^Date:/im.test(header) && /^From:/im.test(header));
    } else if (json !== undefined) {
      message.json = json;
      message.internetMessageId =
        typeof json.internetMessageId === "string" ? json.internetMessageId : undefined;
      message.subject = typeof json.subject === "string" ? json.subject : undefined;
      // Graph creates a message posted as JSON as a draft dated now, unless
      // PidTagMessageFlags without the unsent bit says otherwise.
      const property = (id: string) =>
        this.ignoresExtendedProperties ? undefined : extendedProperty(json, id);
      const flags = property("Integer 0x0E07");
      message.isDraft = flags === undefined || (Number(flags) & 0x8) !== 0;
      message.receivedDateTime = property("SystemTime 0x0E06") ?? FAKE_CREATED_AT;
      message.sentDateTime = message.isDraft
        ? null
        : (property("SystemTime 0x0039") ?? FAKE_CREATED_AT);
    }
    return {
      status: 201,
      json: {
        id: message.id,
        internetMessageId: message.internetMessageId,
        subject: message.subject,
        parentFolderId: folderId,
        isDraft: message.isDraft,
        receivedDateTime: message.receivedDateTime,
        sentDateTime: message.sentDateTime,
      },
    };
  }

  private calendarEvents(url: URL): FixtureResponse {
    const calendarId = segment(url, "calendars");
    const filter = parseEqFilter(url);
    const value = [...this.events.values()]
      .filter((event) => event.calendarId === calendarId)
      .filter((event) => (filter && filter[0] === "iCalUId" ? event.iCalUId === filter[1] : true))
      .map((event) => ({ id: event.id, subject: event.body.subject }));
    return { status: 200, json: { value } };
  }

  /** The message or event an `/attachments` URL belongs to. */
  private attachmentHolder(url: URL): { attachments: Record<string, unknown>[] } | undefined {
    const messageId = segment(url, "messages");
    if (messageId !== null) {
      return this.messages.get(messageId);
    }
    const eventId = segment(url, "events");
    return eventId === null ? undefined : this.events.get(eventId);
  }

  private createEvent(url: URL, call: RecordedCall): FixtureResponse {
    const calendarId = segment(url, "calendars");
    if (!calendarId || !this.calendars.has(calendarId)) {
      return NOT_FOUND;
    }
    const body = call.json as Record<string, unknown>;
    const transactionId = typeof body.transactionId === "string" ? body.transactionId : undefined;
    const existing = [...this.events.values()].find(
      (event) => transactionId !== undefined && event.body.transactionId === transactionId,
    );
    const event = existing ?? this.addEvent(calendarId, body, `uid-${this.nextId("ical")}`);
    return {
      status: existing ? 200 : 201,
      json: { id: event.id, iCalUId: event.iCalUId, ...event.body },
    };
  }

  private contactList(folderId: string | null): FixtureResponse {
    const value = [...this.contacts.values()]
      .filter((contact) => contact.folderId === folderId && this.visible(contact))
      .map((contact) => ({ id: contact.id, ...contact.body }));
    return { status: 200, json: { value } };
  }

  private routes(): FixtureRoute[] {
    const path = (pattern: RegExp) => (url: URL) => pattern.test(url.pathname);
    return [
      // Well-known folders through $batch.
      {
        method: "POST",
        url: path(/\/\$batch$/),
        respond: (call) =>
          batchEnvelope(call, (sub) => {
            const name = /mailFolders\/([a-z]+)/.exec(sub.url)?.[1];
            const id = name ? `wk-${name}` : undefined;
            return id && this.folders.has(id) ? { status: 200, body: { id } } : { status: 404 };
          }),
      },
      // Mail folders.
      {
        method: "GET",
        url: path(/\/users\/[^/]+\/mailFolders$/),
        respond: (call) => this.folderList(null, new URL(call.url)),
      },
      {
        method: "POST",
        url: path(/\/users\/[^/]+\/mailFolders$/),
        respond: (call) => this.createFolder(null, call),
      },
      {
        method: "GET",
        url: path(/\/users\/[^/]+\/mailFolders\/[^/]+\/childFolders$/),
        respond: (call) => {
          const url = new URL(call.url);
          return this.folderList(segment(url, "mailFolders"), url);
        },
      },
      {
        method: "POST",
        url: path(/\/users\/[^/]+\/mailFolders\/[^/]+\/childFolders$/),
        respond: (call) => this.createFolder(segment(new URL(call.url), "mailFolders"), call),
      },
      // Messages.
      {
        method: "GET",
        url: path(/\/users\/[^/]+\/(mailFolders\/[^/]+\/)?messages$/),
        respond: (call) => this.messageList(new URL(call.url)),
      },
      {
        method: "POST",
        url: path(/\/users\/[^/]+\/mailFolders\/[^/]+\/messages$/),
        respond: (call) => this.createMessage(new URL(call.url), call),
      },
      {
        method: "PATCH",
        url: path(/\/users\/[^/]+\/messages\/[^/]+$/),
        respond: (call) => {
          const message = this.messages.get(segment(new URL(call.url), "messages") ?? "");
          if (!message) {
            return NOT_FOUND;
          }
          message.patches.push(call.json as Record<string, unknown>);
          return { status: 200, json: { id: message.id } };
        },
      },
      {
        method: "DELETE",
        url: path(/\/users\/[^/]+\/messages\/[^/]+$/),
        respond: (call) => {
          const id = segment(new URL(call.url), "messages") ?? "";
          return this.messages.delete(id) ? { status: 204 } : NOT_FOUND;
        },
      },
      {
        method: "POST",
        url: path(/\/users\/[^/]+\/(messages|events)\/[^/]+\/attachments$/),
        respond: (call) => {
          const message = this.attachmentHolder(new URL(call.url));
          if (!message) {
            return NOT_FOUND;
          }
          const json = call.json as Record<string, unknown>;
          const bytes =
            typeof json.contentBytes === "string"
              ? Buffer.from(json.contentBytes, "base64").length
              : 0;
          // Graph takes an attachment of 3 MB or more only through an upload session.
          if (
            String(call.body ?? "").length > this.maxRequestBytes ||
            bytes >= this.minUploadSessionBytes
          ) {
            return TOO_LARGE;
          }
          const id = this.nextId("att");
          message.attachments.push(this.created({ id, ...json }));
          return { status: 201, json: { id } };
        },
      },
      {
        method: "GET",
        url: path(/\/users\/[^/]+\/(messages|events)\/[^/]+\/attachments$/),
        respond: (call) => {
          const message = this.attachmentHolder(new URL(call.url));
          if (!message) {
            return NOT_FOUND;
          }
          const value = message.attachments
            .filter((attachment) => this.visible(attachment))
            .map((attachment) => ({
              id: attachment.id,
              name: attachment.name,
              contentType: attachment.contentType,
              isInline: attachment.isInline ?? false,
              // Graph's size counts a little more than the content.
              size:
                (typeof attachment.contentBytes === "string"
                  ? Buffer.from(attachment.contentBytes, "base64").length
                  : 0) + 120,
            }));
          return { status: 200, json: { value } };
        },
      },
      {
        method: "GET",
        url: path(/\/users\/[^/]+\/messages\/[^/]+$/),
        respond: (call) => {
          const message = this.messages.get(segment(new URL(call.url), "messages") ?? "");
          return message
            ? {
                status: 200,
                json: {
                  id: message.id,
                  internetMessageId: message.internetMessageId,
                  subject: message.subject,
                  isDraft: message.isDraft,
                  receivedDateTime: message.receivedDateTime,
                  sentDateTime: message.sentDateTime,
                },
              }
            : NOT_FOUND;
        },
      },
      {
        method: "POST",
        url: path(/\/users\/[^/]+\/(messages|events)\/[^/]+\/attachments\/createUploadSession$/),
        respond: (call) => this.createUploadSession(call),
      },
      {
        method: "PUT",
        url: (url: URL) => url.hostname === UPLOAD_HOST,
        respond: (call) => this.uploadFragment(call),
      },
      {
        method: "GET",
        url: (url: URL) => url.hostname === UPLOAD_HOST,
        respond: (call) => {
          const upload = this.uploads.get(uploadIdOf(call));
          return upload
            ? { status: 200, json: { nextExpectedRanges: [`${upload.received}-`] } }
            : NOT_FOUND;
        },
      },
      {
        method: "DELETE",
        url: (url: URL) => url.hostname === UPLOAD_HOST,
        respond: (call) => {
          const id = uploadIdOf(call);
          if (!this.uploads.delete(id)) {
            return NOT_FOUND;
          }
          this.cancelledUploads.push(id);
          return { status: 204 };
        },
      },
      // Calendars and events.
      {
        method: "GET",
        url: path(/\/users\/[^/]+\/calendar$/),
        respond: () => ({ status: 200, json: { id: "cal-default", name: "Calendar" } }),
      },
      {
        method: "GET",
        url: path(/\/users\/[^/]+\/calendars$/),
        respond: () => ({ status: 200, json: { value: [...this.calendars.values()] } }),
      },
      {
        method: "POST",
        url: path(/\/users\/[^/]+\/calendars$/),
        respond: (call) => {
          const body = call.json as { name: string };
          const calendar = { id: this.nextId("cal"), name: body.name, isDefaultCalendar: false };
          this.calendars.set(calendar.id, calendar);
          return { status: 201, json: calendar };
        },
      },
      {
        method: "GET",
        url: path(/\/users\/[^/]+\/calendars\/[^/]+\/events$/),
        respond: (call) => this.calendarEvents(new URL(call.url)),
      },
      {
        method: "POST",
        url: path(/\/users\/[^/]+\/calendars\/[^/]+\/events$/),
        respond: (call) => this.createEvent(new URL(call.url), call),
      },
      {
        method: "GET",
        url: path(/\/users\/[^/]+\/events\/[^/]+\/instances$/),
        respond: (call) => {
          const master = this.events.get(segment(new URL(call.url), "events") ?? "");
          const subject = typeof master?.body.subject === "string" ? master.body.subject : "";
          return { status: 200, json: { value: this.occurrences.get(subject) ?? [] } };
        },
      },
      {
        method: "PATCH",
        url: path(/\/users\/[^/]+\/events\/[^/]+$/),
        respond: (call) => {
          const id = segment(new URL(call.url), "events") ?? "";
          const event = this.events.get(id);
          if (event) {
            event.patches.push(call.json as Record<string, unknown>);
            return { status: 200, json: { id } };
          }
          // Occurrences are not stored as events; record the patch on the master.
          for (const [subject, list] of this.occurrences) {
            if (list.some((occurrence) => occurrence.id === id)) {
              const master = [...this.events.values()].find((e) => e.body.subject === subject);
              master?.patches.push({ occurrence: id, ...(call.json as object) });
              return { status: 200, json: { id } };
            }
          }
          return NOT_FOUND;
        },
      },
      {
        method: "DELETE",
        url: path(/\/users\/[^/]+\/events\/[^/]+$/),
        respond: (call) => {
          const id = segment(new URL(call.url), "events") ?? "";
          return this.events.delete(id) ? { status: 204 } : NOT_FOUND;
        },
      },
      // Contact folders and contacts.
      {
        method: "GET",
        url: path(/\/users\/[^/]+\/contactFolders$/),
        respond: (call) => this.contactFolderList(null, new URL(call.url)),
      },
      {
        method: "POST",
        url: path(/\/users\/[^/]+\/contactFolders$/),
        respond: (call) => this.createContactFolder(null, call),
      },
      {
        method: "GET",
        url: path(/\/users\/[^/]+\/contactFolders\/[^/]+\/childFolders$/),
        respond: (call) => {
          const url = new URL(call.url);
          return this.contactFolderList(segment(url, "contactFolders"), url);
        },
      },
      {
        method: "POST",
        url: path(/\/users\/[^/]+\/contactFolders\/[^/]+\/childFolders$/),
        respond: (call) =>
          this.createContactFolder(segment(new URL(call.url), "contactFolders"), call),
      },
      {
        method: "GET",
        url: path(/\/users\/[^/]+\/contacts$/),
        respond: () => this.contactList(null),
      },
      {
        method: "GET",
        url: path(/\/users\/[^/]+\/contactFolders\/[^/]+\/contacts$/),
        respond: (call) => this.contactList(segment(new URL(call.url), "contactFolders")),
      },
      {
        method: "POST",
        url: path(/\/users\/[^/]+\/(contactFolders\/[^/]+\/)?contacts$/),
        respond: (call) => {
          const folderId = segment(new URL(call.url), "contactFolders");
          const contact = this.addContact(folderId, call.json as Record<string, unknown>);
          return { status: 201, json: { id: contact.id, ...contact.body } };
        },
      },
      {
        method: "DELETE",
        url: path(/\/users\/[^/]+\/contacts\/[^/]+$/),
        respond: (call) => {
          const id = segment(new URL(call.url), "contacts") ?? "";
          return this.contacts.delete(id) ? { status: 204 } : NOT_FOUND;
        },
      },
    ];
  }

  private createUploadSession(call: RecordedCall): FixtureResponse {
    const url = new URL(call.url);
    const holder = this.attachmentHolder(url);
    if (!holder) {
      return NOT_FOUND;
    }
    const messageId = segment(url, "messages") ?? segment(url, "events") ?? "";
    const item = ((call.json as { AttachmentItem?: Record<string, unknown> }).AttachmentItem ??
      {}) as Record<string, unknown>;
    const size = typeof item.size === "number" ? item.size : -1;
    if (size < this.minUploadSessionBytes) {
      return {
        status: 400,
        json: graphError(
          "ErrorAttachmentSizeShouldNotBeLessThanMinimumSize",
          "Attachment size must be at least 3 MB for an upload session",
        ),
      };
    }
    if (size > this.maxAttachmentBytes) {
      return {
        status: 400,
        json: graphError(
          "ErrorAttachmentSizeShouldNotBeGreaterThanMaximumSize",
          "Attachment size must not exceed 150 MB",
        ),
      };
    }
    const id = this.nextId("upload");
    this.uploads.set(id, { messageId, holder, item, size, parts: [], received: 0 });
    return {
      status: 201,
      json: {
        uploadUrl: `https://${UPLOAD_HOST}/api/gv1.0/users('x')/messages('${messageId}')/AttachmentSessions('${id}')?authtoken=fake`,
        expirationDateTime: "2026-09-22T18:00:00Z",
        nextExpectedRanges: ["0-"],
      },
    };
  }

  private uploadFragment(call: RecordedCall): FixtureResponse {
    const id = uploadIdOf(call);
    const upload = this.uploads.get(id);
    if (!upload) {
      return NOT_FOUND;
    }
    const body = Buffer.from((call.body as Uint8Array | undefined) ?? new Uint8Array());
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(call.headers["content-range"] ?? "");
    if (!range || Number(range[1]) !== upload.received || body.length > 4 * 1024 * 1024) {
      return { status: 416, json: graphError("InvalidRange") };
    }
    const fault = this.failAttachmentFragmentsAt.indexOf(upload.received);
    if (fault !== -1) {
      this.failAttachmentFragmentsAt.splice(fault, 1);
      return { status: 502, json: graphError("BadGateway") };
    }
    upload.parts.push(body);
    upload.received += body.length;
    if (upload.received < upload.size) {
      return { status: 200, json: { nextExpectedRanges: [`${upload.received}-`] } };
    }
    this.uploads.delete(id);
    const message = upload.holder;
    const attachmentId = this.nextId("att");
    const { attachmentType: _type, ...facts } = upload.item;
    message.attachments.push(
      this.created({
        id: attachmentId,
        "@odata.type": "#microsoft.graph.fileAttachment",
        ...facts,
        contentBytes: Buffer.concat(upload.parts).toString("base64"),
      }),
    );
    return {
      status: 201,
      headers: {
        location: `https://${UPLOAD_HOST}/api/v2.0/Users('x')/Messages('${upload.messageId}')/Attachments('${attachmentId}')`,
      },
    };
  }

  private contactFolderList(parentId: string | null, url: URL): FixtureResponse {
    const filter = parseEqFilter(url);
    const value = [...this.contactFolders.values()]
      .filter((folder) => folder.parentFolderId === parentId)
      .filter((folder) =>
        filter && filter[0] === "displayName"
          ? folder.displayName.toLowerCase() === filter[1].toLowerCase()
          : true,
      )
      .map((folder) => ({ id: folder.id, displayName: folder.displayName }));
    return { status: 200, json: { value } };
  }

  private createContactFolder(parentId: string | null, call: RecordedCall): FixtureResponse {
    const body = call.json as { displayName?: string };
    if (!body.displayName) {
      return { status: 400, json: graphError("ErrorInvalidRequest") };
    }
    const folder = this.addContactFolder(body.displayName, parentId);
    return { status: 201, json: { id: folder.id, displayName: folder.displayName } };
  }
}
