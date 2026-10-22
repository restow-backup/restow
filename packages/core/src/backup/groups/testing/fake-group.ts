/**
 * An in-memory Microsoft 365 group mailbox for tests (no real tenant). It
 * answers the Graph routes below `/groups/{id}` that the group backup, the
 * group restore and the directory sync use: the group itself, the calendar
 * (`/calendar/events`, `/calendarView`, `/events/{id}`, `/events/{id}/instances`,
 * creating events), the conversations (`/threads`, `/threads/{id}/posts` with
 * and without `$expand=attachments`), and `groups/delta` for a set of groups.
 *
 * Switches model the application-permission answers Graph documents for
 * group mailboxes, so the fallbacks are testable: the plain event listing,
 * a series master read, the attachment expansion and event creation can each
 * be refused with 403.
 */
import type { Attachment, Event, Recipient } from "@microsoft/microsoft-graph-types";
import type {
  FixtureResponse,
  FixtureRoute,
  RecordedCall,
} from "../../../graph/testing/fake-graph.js";
import { graphError } from "../../../graph/testing/fake-graph.js";

export interface FakeGroupEvent extends Event {
  id: string;
  /** Series masters: modified occurrences (`/instances` and `calendarView`). */
  exceptions?: Event[];
  /** Series masters: the unmodified occurrences `calendarView` lists. */
  occurrences?: Event[];
}

export interface FakePostAttachment {
  id: string;
  name: string;
  contentType: string;
  bytes: Uint8Array;
  isInline?: boolean;
  odataType?: string;
}

export interface FakePost {
  id: string;
  from: Recipient;
  sender?: Recipient;
  body: string;
  bodyType?: "html" | "text";
  receivedDateTime: string;
  changeKey?: string;
  newParticipants?: Recipient[];
  attachments?: FakePostAttachment[];
}

export interface FakeThread {
  id: string;
  topic: string;
  lastDeliveredDateTime: string;
  posts: FakePost[];
}

export interface FakeGroupInfo {
  id: string;
  displayName: string;
  mail: string;
  description?: string;
  groupTypes?: string[];
  resourceProvisioningOptions?: string[];
  mailEnabled?: boolean;
}

const FORBIDDEN: FixtureResponse = {
  status: 403,
  json: graphError("ErrorAccessDenied", "Access is denied. Check credentials and try again."),
};

export class FakeGroupMailbox {
  readonly events = new Map<string, FakeGroupEvent>();
  readonly threads = new Map<string, FakeThread>();
  /** Events created through Graph (restore), in order. */
  readonly created: Array<Record<string, unknown>> = [];
  exists = true;
  refuseEventsListing = false;
  refuseMasterRead = false;
  refuseCalendarView = false;
  refuseAttachmentExpand = false;
  refuseThreads = false;
  refuseEventCreate = false;
  private nextCreated = 1;

  constructor(readonly group: FakeGroupInfo) {}

  addEvent(event: FakeGroupEvent): FakeGroupEvent {
    this.events.set(event.id, event);
    return event;
  }

  addThread(thread: FakeThread): FakeThread {
    this.threads.set(thread.id, thread);
    return thread;
  }

  /** Add a post to a thread and move its delivery time, as Exchange does. */
  addPost(threadId: string, post: FakePost): void {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`no thread ${threadId}`);
    }
    thread.posts.push(post);
    thread.lastDeliveredDateTime = post.receivedDateTime;
  }

  routes(): FixtureRoute[] {
    return [
      { method: "GET", url: (url) => this.handles(url), respond: (call) => this.dispatch(call) },
      { method: "POST", url: (url) => this.handles(url), respond: (call) => this.dispatch(call) },
    ];
  }

  private prefix(): string {
    return `/v1.0/groups/${encodeURIComponent(this.group.id)}`;
  }

  private handles(url: URL): boolean {
    return url.pathname === this.prefix() || url.pathname.startsWith(`${this.prefix()}/`);
  }

  private dispatch(call: RecordedCall): FixtureResponse {
    const url = new URL(call.url);
    const path = url.pathname.slice(this.prefix().length);
    if (!this.exists) {
      return { status: 404, json: graphError("Request_ResourceNotFound", "group not found") };
    }
    if (call.method === "POST") {
      if (path === "/calendar/events") {
        return this.createEvent(call);
      }
      return { status: 405, json: graphError("MethodNotAllowed", path) };
    }
    if (path === "") {
      return { status: 200, json: this.groupJson() };
    }
    if (path === "/calendar/events") {
      return this.eventsPage(url);
    }
    if (path === "/calendarView") {
      return this.refuseCalendarView ? FORBIDDEN : this.calendarView();
    }
    let match = /^\/events\/([^/]+)\/instances$/.exec(path);
    if (match) {
      const master = this.events.get(decodeURIComponent(match[1] ?? ""));
      return master
        ? { status: 200, json: { value: [...(master.exceptions ?? [])] } }
        : this.notFound("event");
    }
    match = /^\/events\/([^/]+)$/.exec(path);
    if (match) {
      if (this.refuseMasterRead) {
        return FORBIDDEN;
      }
      const event = this.events.get(decodeURIComponent(match[1] ?? ""));
      return event ? { status: 200, json: this.eventJson(event) } : this.notFound("event");
    }
    if (path === "/threads") {
      return this.refuseThreads
        ? FORBIDDEN
        : {
            status: 200,
            json: {
              value: [...this.threads.values()].map((thread) => ({
                id: thread.id,
                topic: thread.topic,
                lastDeliveredDateTime: thread.lastDeliveredDateTime,
                hasAttachments: thread.posts.some((post) => (post.attachments?.length ?? 0) > 0),
                preview: thread.posts.at(-1)?.body.slice(0, 40) ?? "",
                uniqueSenders: [],
                isLocked: false,
              })),
            },
          };
    }
    match = /^\/threads\/([^/]+)\/posts$/.exec(path);
    if (match) {
      const thread = this.threads.get(decodeURIComponent(match[1] ?? ""));
      if (!thread) {
        return this.notFound("thread");
      }
      const expand = url.searchParams.get("$expand") === "attachments";
      if (expand && this.refuseAttachmentExpand) {
        return FORBIDDEN;
      }
      return {
        status: 200,
        json: { value: thread.posts.map((post) => this.postJson(thread, post, expand)) },
      };
    }
    return { status: 404, json: graphError("FakeRouteNotFound", url.pathname) };
  }

  private notFound(what: string): FixtureResponse {
    return { status: 404, json: graphError("ErrorItemNotFound", `${what} not found`) };
  }

  groupJson(): Record<string, unknown> {
    return {
      id: this.group.id,
      displayName: this.group.displayName,
      mail: this.group.mail,
      description: this.group.description ?? null,
      mailEnabled: this.group.mailEnabled ?? true,
      groupTypes: this.group.groupTypes ?? ["Unified"],
      resourceProvisioningOptions: this.group.resourceProvisioningOptions ?? [],
    };
  }

  private eventJson(event: FakeGroupEvent): Event {
    const { exceptions: _exceptions, occurrences: _occurrences, ...rest } = event;
    return rest;
  }

  private eventsPage(url: URL): FixtureResponse {
    if (this.refuseEventsListing) {
      return FORBIDDEN;
    }
    const filter = url.searchParams.get("$filter");
    const uid = filter ? /iCalUId eq '(.*)'$/.exec(filter)?.[1]?.replace(/''/g, "'") : undefined;
    const all = [...this.events.values(), ...this.createdEvents()];
    const events = all
      .filter((event) => uid === undefined || event.iCalUId === uid)
      .map((event) => this.eventJson(event));
    return { status: 200, json: { value: events } };
  }

  private createdEvents(): FakeGroupEvent[] {
    return this.created.map((event) => event as unknown as FakeGroupEvent);
  }

  private calendarView(): FixtureResponse {
    const value: Event[] = [];
    for (const event of this.events.values()) {
      if (event.type === "seriesMaster") {
        value.push(...(event.occurrences ?? []), ...(event.exceptions ?? []));
      } else {
        value.push(this.eventJson(event));
      }
    }
    return { status: 200, json: { value } };
  }

  private createEvent(call: RecordedCall): FixtureResponse {
    if (this.refuseEventCreate) {
      return FORBIDDEN;
    }
    const body = (call.json ?? {}) as Record<string, unknown>;
    const created = { ...body, id: `created-${this.nextCreated++}` };
    this.created.push(created);
    return { status: 201, json: created };
  }

  private postJson(thread: FakeThread, post: FakePost, expand: boolean): Record<string, unknown> {
    const attachments: Attachment[] | undefined = expand
      ? (post.attachments ?? []).map(
          (attachment) =>
            ({
              "@odata.type": attachment.odataType ?? "#microsoft.graph.fileAttachment",
              id: attachment.id,
              name: attachment.name,
              contentType: attachment.contentType,
              isInline: attachment.isInline ?? false,
              size: attachment.bytes.length,
              ...((attachment.odataType ?? "#microsoft.graph.fileAttachment") ===
              "#microsoft.graph.fileAttachment"
                ? { contentBytes: Buffer.from(attachment.bytes).toString("base64") }
                : {}),
            }) as Attachment,
        )
      : undefined;
    return {
      id: post.id,
      conversationThreadId: thread.id,
      from: post.from,
      sender: post.sender ?? post.from,
      body: { contentType: post.bodyType ?? "html", content: post.body },
      receivedDateTime: post.receivedDateTime,
      createdDateTime: post.receivedDateTime,
      lastModifiedDateTime: post.receivedDateTime,
      changeKey: post.changeKey ?? `ck-${post.id}`,
      hasAttachments: (post.attachments?.length ?? 0) > 0,
      newParticipants: post.newParticipants ?? [],
      categories: [],
      ...(attachments ? { attachments } : {}),
    };
  }
}

/**
 * `groups/delta` for a set of groups: the first call lists them all (in
 * pages of `pageSize`) and ends with a delta link; a call with that link
 * returns `changes` (set by the test between runs) and a new link.
 */
export class FakeGroupDirectory {
  readonly groups = new Map<string, Record<string, unknown>>();
  /** Entries the next incremental call returns. */
  changes: Array<Record<string, unknown>> = [];
  pageSize = 2;
  refuse = false;
  private round = 0;

  set(group: Record<string, unknown> & { id: string }): void {
    this.groups.set(group.id, group);
  }

  routes(): FixtureRoute[] {
    return [
      {
        method: "GET",
        url: (url) => url.pathname === "/v1.0/groups/delta",
        respond: (call) => this.answer(new URL(call.url)),
      },
    ];
  }

  private answer(url: URL): FixtureResponse {
    if (this.refuse) {
      return FORBIDDEN;
    }
    const base = "https://graph.microsoft.com/v1.0/groups/delta";
    const token = url.searchParams.get("$deltatoken");
    if (token !== null) {
      const value = this.changes;
      this.changes = [];
      this.round += 1;
      return {
        status: 200,
        json: { value, "@odata.deltaLink": `${base}?$deltatoken=round-${this.round}` },
      };
    }
    const skip = Number(url.searchParams.get("$skiptoken") ?? "0");
    const all = [...this.groups.values()];
    const page = all.slice(skip, skip + this.pageSize);
    const next = skip + this.pageSize;
    this.round += next >= all.length ? 1 : 0;
    return {
      status: 200,
      json: {
        value: page,
        ...(next < all.length
          ? { "@odata.nextLink": `${base}?$skiptoken=${next}` }
          : { "@odata.deltaLink": `${base}?$deltatoken=round-${this.round}` }),
      },
    };
  }
}
