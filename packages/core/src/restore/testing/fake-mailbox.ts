/**
 * A stateful fake of the Graph mailbox endpoints the Exchange restore uses:
 * mail folders, messages, calendars, events, contact folders and contacts.
 * Built on {@link createFakeGraph}, so every request is recorded and nothing
 * touches the network.
 */
import {
  type FakeGraph,
  type FixtureResponse,
  type FixtureRoute,
  type RecordedCall,
  batchEnvelope,
  createFakeGraph,
  graphError,
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
  /** When set, MIME imports with a longer base64 body are refused with 413. */
  maxMimeBytes: number | null = null;

  constructor() {
    this.addFolder("Inbox", null, "wk-inbox");
    this.addFolder("Sent Items", null, "wk-sentitems");
    this.addFolder("Deleted Items", null, "wk-deleteditems");
    this.calendars.set("cal-default", {
      id: "cal-default",
      name: "Calendar",
      isDefaultCalendar: true,
    });
    this.graph = createFakeGraph(this.routes());
  }

  nextId(prefix: string): string {
    this.counter++;
    return `${prefix}-${this.counter}`;
  }

  addFolder(displayName: string, parentFolderId: string | null, id?: string): FakeMailFolder {
    const folder = { id: id ?? this.nextId("folder"), displayName, parentFolderId };
    this.folders.set(folder.id, folder);
    return folder;
  }

  addMessage(input: {
    parentFolderId: string;
    internetMessageId?: string;
    subject?: string;
  }): FakeMessage {
    const message: FakeMessage = {
      id: this.nextId("msg"),
      parentFolderId: input.parentFolderId,
      internetMessageId: input.internetMessageId,
      subject: input.subject,
      mime: undefined,
      json: undefined,
      patches: [],
      attachments: [],
    };
    this.messages.set(message.id, message);
    return message;
  }

  addContactFolder(displayName: string, parentFolderId: string | null): FakeContactFolder {
    const folder = { id: this.nextId("cfolder"), displayName, parentFolderId };
    this.contactFolders.set(folder.id, folder);
    return folder;
  }

  addContact(folderId: string | null, body: Record<string, unknown>): FakeContact {
    const contact = { id: this.nextId("contact"), folderId, body };
    this.contacts.set(contact.id, contact);
    return contact;
  }

  addEvent(calendarId: string, body: Record<string, unknown>, iCalUId: string): FakeEvent {
    const event = { id: this.nextId("event"), calendarId, body, iCalUId, patches: [] };
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
      .filter((folder) => folder.parentFolderId === parentId)
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
    const folder = this.addFolder(body.displayName, parentId);
    return { status: 201, json: { id: folder.id, displayName: folder.displayName } };
  }

  private messageList(url: URL): FixtureResponse {
    const folderId = segment(url, "mailFolders");
    const filter = parseEqFilter(url);
    const value = [...this.messages.values()]
      .filter((message) => (folderId ? message.parentFolderId === folderId : true))
      .filter((message) =>
        filter && filter[0] === "internetMessageId"
          ? message.internetMessageId === filter[1]
          : true,
      )
      .map((message) => ({
        id: message.id,
        parentFolderId: message.parentFolderId,
        receivedDateTime: "2026-01-15T10:30:00Z",
      }));
    return { status: 200, json: { value } };
  }

  private createMessage(url: URL, call: RecordedCall): FixtureResponse {
    const folderId = segment(url, "mailFolders");
    if (!folderId || !this.folders.has(folderId)) {
      return NOT_FOUND;
    }
    const isMime = (call.headers["content-type"] ?? "").startsWith("text/plain");
    if (isMime && this.maxMimeBytes !== null && String(call.body).length > this.maxMimeBytes) {
      return {
        status: 413,
        json: graphError("RequestBodyTooLarge", "The request body exceeds the maximum size"),
      };
    }
    const message = this.addMessage({ parentFolderId: folderId });
    if (isMime) {
      const mime = Buffer.from(String(call.body), "base64").toString("utf8");
      message.mime = mime;
      message.internetMessageId = /^Message-ID:\s*(.+)$/im.exec(mime)?.[1]?.trim();
      message.subject = /^Subject:\s*(.+)$/im.exec(mime)?.[1]?.trim();
    } else {
      const json = call.json as Record<string, unknown>;
      message.json = json;
      message.internetMessageId =
        typeof json.internetMessageId === "string" ? json.internetMessageId : undefined;
      message.subject = typeof json.subject === "string" ? json.subject : undefined;
    }
    return {
      status: 201,
      json: {
        id: message.id,
        internetMessageId: message.internetMessageId,
        subject: message.subject,
        parentFolderId: folderId,
        // Graph creates messages posted as JSON as drafts; MIME with full headers is not.
        isDraft: !isMime,
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
      .filter((contact) => contact.folderId === folderId)
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
        url: path(/\/users\/[^/]+\/messages\/[^/]+\/attachments$/),
        respond: (call) => {
          const message = this.messages.get(segment(new URL(call.url), "messages") ?? "");
          if (!message) {
            return NOT_FOUND;
          }
          message.attachments.push(call.json as Record<string, unknown>);
          return { status: 201, json: { id: this.nextId("att") } };
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
