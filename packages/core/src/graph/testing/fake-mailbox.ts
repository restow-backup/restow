/**
 * A stateful fake of one or more Exchange Online mailboxes behind Microsoft Graph, for the
 * archive capture tests (./fake-graph.ts is the recorded-style base it plugs into):
 *
 *   - folder tree (`/mailFolders`, `/childFolders`, well-known names), message delta per
 *     folder with paging and delta links that can be expired (410 Gone), plain message
 *     listing (`$top` + nextLink) for the backfill, message metadata and `$value` MIME;
 *   - `/subscriptions`: create (with the notification URL validated through a callback),
 *     PATCH renewal, reauthorize, DELETE;
 *   - `$batch`, dispatched to the same handlers, so batched and direct calls behave alike;
 *   - every `Prefer` header is recorded, to assert immutable ids were asked for.
 *
 * Message ids are stable across folder moves, like immutable ids.
 */
import { randomUUID } from "node:crypto";
import type { GraphClientOptions } from "../client.js";
import {
  createFakeGraph,
  type FakeGraph,
  type FixtureResponse,
  graphError,
  type RecordedCall,
} from "./fake-graph.js";

export interface FakeFolder {
  readonly id: string;
  readonly displayName: string;
  readonly parentFolderId?: string | null;
  readonly wellKnownName?: string;
  /** Not listed in the tree (`recoverableitemsdeletions`), reachable by well-known name. */
  readonly outsideTree?: boolean;
}

export interface FakeMessage {
  id: string;
  folderId: string;
  internetMessageId?: string;
  receivedDateTime?: string;
  isDraft?: boolean;
  /** The MIME `$value` returns; defaults to a small generated mail. */
  mime?: string;
  /** `$value` answers 413 (too large for a MIME export). */
  tooLarge?: boolean;
}

export interface FakeSubscription {
  id: string;
  resource: string;
  changeType: string;
  notificationUrl: string;
  lifecycleNotificationUrl?: string;
  clientState: string;
  expirationDateTime: string;
  prefer: string | null;
}

interface MailboxState {
  readonly folders: FakeFolder[];
  readonly messages: Map<string, FakeMessage>;
  /** Event log per folder: message ids added, in order (delta tokens index into it). */
  readonly log: Map<string, string[]>;
  /** Folders whose delta links answer 410 until enumerated again. */
  readonly expired: Set<string>;
}

export interface FakeMailboxGraphOptions {
  /** Messages per delta or listing page (small, to exercise paging). */
  readonly pageSize?: number;
  /** Answer for the notification URL validation of a new subscription (default 200). */
  readonly validate?: (subscription: FakeSubscription) => number;
}

const BASE = "https://graph.microsoft.com/v1.0";

function defaultMime(message: FakeMessage): string {
  const id = message.internetMessageId ?? `<${message.id}@fake.example>`;
  return `Message-ID: ${id}\r\nFrom: sender@fabrikam.example\r\nTo: user@contoso.example\r\nSubject: Message ${message.id}\r\nDate: Mon, 02 Nov 2026 08:00:00 +0000\r\n\r\nBody of ${message.id}\r\n`;
}

function json(status: number, body: unknown): FixtureResponse {
  return { status, json: body };
}

function notFound(what: string): FixtureResponse {
  return json(404, graphError("ErrorItemNotFound", `${what} not found`));
}

export class FakeMailboxGraph {
  readonly mailboxes = new Map<string, MailboxState>();
  readonly subscriptions = new Map<string, FakeSubscription>();
  /** Every `Prefer` header seen, direct and inside `$batch`. */
  readonly prefer: string[] = [];
  /** Answers to force for the next calls whose path includes a key (status per call). */
  readonly failures = new Map<string, number[]>();
  readonly graph: FakeGraph;
  private readonly pageSize: number;

  constructor(private readonly options: FakeMailboxGraphOptions = {}) {
    this.pageSize = options.pageSize ?? 2;
    this.graph = createFakeGraph([
      {
        method: "POST",
        url: (url) => url.pathname.endsWith("/$batch"),
        respond: (call) => this.batch(call),
      },
      ...["GET", "POST", "PATCH", "DELETE"].map((method) => ({
        method,
        url: (url: URL) => !url.pathname.endsWith("/$batch"),
        respond: (call: RecordedCall) =>
          this.handle(method, new URL(call.url), call.headers, call.json),
      })),
    ]);
  }

  /** A client wired to the fake (no sleeping on retries). */
  client(options: Partial<GraphClientOptions> = {}) {
    return this.graph.client(options);
  }

  addMailbox(userId: string, folders: FakeFolder[], messages: FakeMessage[] = []): void {
    const state: MailboxState = {
      folders,
      messages: new Map(),
      log: new Map(folders.map((folder) => [folder.id, []])),
      expired: new Set(),
    };
    this.mailboxes.set(userId, state);
    for (const message of messages) {
      this.addMessage(userId, message);
    }
  }

  addMessage(userId: string, message: FakeMessage): void {
    const state = this.mailbox(userId);
    state.messages.set(message.id, message);
    state.log.get(message.folderId)?.push(message.id);
  }

  /** Move a message (its id stays, like an immutable id); delta reports it in the new folder. */
  moveMessage(userId: string, id: string, folderId: string): void {
    const state = this.mailbox(userId);
    const message = state.messages.get(id);
    if (message) {
      message.folderId = folderId;
      state.log.get(folderId)?.push(id);
    }
  }

  deleteMessage(userId: string, id: string): void {
    this.mailbox(userId).messages.delete(id);
  }

  /** The folder's delta links answer 410 Gone until it is enumerated from scratch. */
  expireDelta(userId: string, folderId: string): void {
    this.mailbox(userId).expired.add(folderId);
  }

  /** Make the next calls whose path includes `pathPart` answer `statuses`, one per call. */
  failNext(pathPart: string, ...statuses: number[]): void {
    this.failures.set(pathPart, [...(this.failures.get(pathPart) ?? []), ...statuses]);
  }

  private mailbox(userId: string): MailboxState {
    const state = this.mailboxes.get(userId);
    if (!state) {
      throw new Error(`fake mailbox ${userId} does not exist`);
    }
    return state;
  }

  private batch(call: RecordedCall): FixtureResponse {
    const payload = call.json as {
      requests: Array<{
        id: string;
        method: string;
        url: string;
        headers?: Record<string, string>;
        body?: unknown;
      }>;
    };
    const responses = payload.requests.map((sub) => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(sub.headers ?? {})) {
        headers[key.toLowerCase()] = value;
      }
      const url = new URL(sub.url.startsWith("http") ? sub.url : `${BASE}${sub.url}`);
      const answer = this.handle(sub.method.toUpperCase(), url, headers, sub.body);
      return {
        id: sub.id,
        status: answer.status,
        headers: answer.headers ?? {},
        body: answer.json ?? answer.text,
      };
    });
    return json(200, { responses });
  }

  private forced(path: string): FixtureResponse | null {
    for (const [part, statuses] of this.failures) {
      if (path.includes(part) && statuses.length > 0) {
        const status = statuses.shift() as number;
        return json(status, graphError(status === 429 ? "TooManyRequests" : "Forced"));
      }
    }
    return null;
  }

  private handle(
    method: string,
    url: URL,
    headers: Record<string, string>,
    body: unknown,
  ): FixtureResponse {
    if (headers.prefer) {
      this.prefer.push(headers.prefer);
    }
    const path = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ""));
    const forced = this.forced(path);
    if (forced) {
      return forced;
    }
    if (path === "/subscriptions" && method === "POST") {
      return this.createSubscription(body as Record<string, string>, headers.prefer ?? null);
    }
    const subscription = /^\/subscriptions\/([^/]+)(\/reauthorize)?$/.exec(path);
    if (subscription) {
      return this.subscription(method, subscription[1] as string, Boolean(subscription[2]), body);
    }
    const user = /^\/users\/([^/]+)(\/.*)$/.exec(path);
    if (!user) {
      return notFound(path);
    }
    const state = this.mailboxes.get(user[1] as string);
    if (!state) {
      return json(404, graphError("ErrorInvalidUser", "user not found"));
    }
    const rest = user[2] as string;
    if (method !== "GET") {
      return notFound(rest);
    }
    if (rest === "/mailFolders") {
      return json(200, {
        value: state.folders
          .filter((f) => !f.outsideTree && (f.parentFolderId ?? null) === null)
          .map((f) => this.folderJson(state, f)),
      });
    }
    const children = /^\/mailFolders\/([^/]+)\/childFolders$/.exec(rest);
    if (children) {
      return json(200, {
        value: state.folders
          .filter((f) => f.parentFolderId === children[1])
          .map((f) => this.folderJson(state, f)),
      });
    }
    const delta = /^\/mailFolders\/([^/]+)\/messages\/delta$/.exec(rest);
    if (delta) {
      return this.delta(state, user[1] as string, delta[1] as string, url);
    }
    const listing = /^\/mailFolders\/([^/]+)\/messages$/.exec(rest);
    if (listing) {
      return this.listing(state, user[1] as string, listing[1] as string, url);
    }
    const folder = /^\/mailFolders\/([^/]+)$/.exec(rest);
    if (folder) {
      const found = state.folders.find((f) => f.id === folder[1] || f.wellKnownName === folder[1]);
      return found ? json(200, { id: found.id }) : notFound("folder");
    }
    const mime = /^\/messages\/([^/]+)\/\$value$/.exec(rest);
    if (mime) {
      const message = state.messages.get(mime[1] as string);
      if (!message) {
        return notFound("message");
      }
      if (message.tooLarge) {
        return json(413, graphError("ErrorMessageSizeExceeded", "too large"));
      }
      return { status: 200, text: message.mime ?? defaultMime(message) };
    }
    const attachments = /^\/messages\/([^/]+)\/attachments$/.exec(rest);
    if (attachments) {
      return json(200, { value: [] });
    }
    const message = /^\/messages\/([^/]+)$/.exec(rest);
    if (message) {
      const found = state.messages.get(message[1] as string);
      return found ? json(200, this.messageJson(found)) : notFound("message");
    }
    return notFound(rest);
  }

  private folderJson(state: MailboxState, folder: FakeFolder) {
    return {
      id: folder.id,
      displayName: folder.displayName,
      parentFolderId: folder.parentFolderId ?? "root",
      childFolderCount: state.folders.filter((f) => f.parentFolderId === folder.id).length,
      totalItemCount: 0,
      unreadItemCount: 0,
      isHidden: false,
    };
  }

  private messageJson(message: FakeMessage) {
    return {
      id: message.id,
      internetMessageId: message.internetMessageId ?? `<${message.id}@fake.example>`,
      receivedDateTime: message.receivedDateTime ?? "2026-11-02T08:00:00Z",
      isDraft: message.isDraft ?? false,
      parentFolderId: message.folderId,
    };
  }

  /** Delta: `$deltatoken=<n>` resumes after log entry n, `$skiptoken=<n>` pages a run. */
  private delta(state: MailboxState, userId: string, folderId: string, url: URL): FixtureResponse {
    const log = state.log.get(folderId);
    if (!log) {
      return notFound("folder");
    }
    const deltaToken = url.searchParams.get("$deltatoken");
    const skipToken = url.searchParams.get("$skiptoken");
    if ((deltaToken !== null || skipToken?.startsWith("d")) && state.expired.has(folderId)) {
      return json(410, graphError("SyncStateNotFound", "the sync state expired"));
    }
    // A run: the ids from `from` to the end of the log, still in this folder, deduplicated.
    const from = skipToken !== null ? Number(skipToken.split(":")[1]) : Number(deltaToken ?? 0);
    const offset = skipToken !== null ? Number(skipToken.split(":")[2]) : 0;
    const initial = deltaToken === null && (skipToken === null || skipToken.startsWith("i"));
    if (initial) {
      state.expired.delete(folderId);
    }
    const ids = [...new Set(log.slice(initial ? 0 : from))].filter(
      (id) => state.messages.get(id)?.folderId === folderId,
    );
    const page = ids.slice(offset, offset + this.pageSize);
    const base = `${BASE}/users/${encodeURIComponent(userId)}/mailFolders/${encodeURIComponent(folderId)}/messages/delta`;
    const body: Record<string, unknown> = {
      value: page.map((id) => this.messageJson(state.messages.get(id) as FakeMessage)),
    };
    if (offset + this.pageSize < ids.length) {
      body["@odata.nextLink"] =
        `${base}?$skiptoken=${initial ? "i" : "d"}:${initial ? 0 : from}:${offset + this.pageSize}`;
    } else {
      body["@odata.deltaLink"] = `${base}?$deltatoken=${log.length}`;
    }
    return json(200, body);
  }

  private listing(state: MailboxState, userId: string, folderId: string, url: URL) {
    if (!state.log.has(folderId)) {
      return notFound("folder");
    }
    const skip = Number(url.searchParams.get("$skip") ?? 0);
    const ids = [...state.messages.values()].filter((m) => m.folderId === folderId);
    const page = ids.slice(skip, skip + this.pageSize);
    const body: Record<string, unknown> = { value: page.map((m) => this.messageJson(m)) };
    if (skip + this.pageSize < ids.length) {
      body["@odata.nextLink"] =
        `${BASE}/users/${encodeURIComponent(userId)}/mailFolders/${encodeURIComponent(folderId)}/messages?$skip=${skip + this.pageSize}`;
    }
    return json(200, body);
  }

  private createSubscription(
    body: Record<string, string> | undefined,
    prefer: string | null,
  ): FixtureResponse {
    if (!body?.notificationUrl?.startsWith("https://")) {
      return json(400, graphError("ValidationError", "notificationUrl must be https"));
    }
    const subscription: FakeSubscription = {
      id: randomUUID(),
      resource: body.resource ?? "",
      changeType: body.changeType ?? "",
      notificationUrl: body.notificationUrl,
      ...(body.lifecycleNotificationUrl
        ? { lifecycleNotificationUrl: body.lifecycleNotificationUrl }
        : {}),
      clientState: body.clientState ?? "",
      expirationDateTime: body.expirationDateTime ?? new Date().toISOString(),
      prefer,
    };
    const validation = this.options.validate?.(subscription) ?? 200;
    if (validation !== 200) {
      return json(
        400,
        graphError(
          "ValidationError",
          "Subscription validation request failed. Notification endpoint must respond with 200 OK to validation request.",
        ),
      );
    }
    this.subscriptions.set(subscription.id, subscription);
    return json(201, {
      id: subscription.id,
      resource: subscription.resource,
      expirationDateTime: subscription.expirationDateTime,
    });
  }

  private subscription(
    method: string,
    id: string,
    reauthorize: boolean,
    body: unknown,
  ): FixtureResponse {
    const found = this.subscriptions.get(id);
    if (!found) {
      return json(404, graphError("ResourceNotFound", "subscription not found"));
    }
    if (reauthorize && method === "POST") {
      return { status: 200 };
    }
    if (method === "PATCH") {
      const expiry = (body as { expirationDateTime?: string } | undefined)?.expirationDateTime;
      if (expiry) {
        found.expirationDateTime = expiry;
      }
      return json(200, {
        id: found.id,
        resource: found.resource,
        expirationDateTime: found.expirationDateTime,
      });
    }
    if (method === "DELETE") {
      this.subscriptions.delete(id);
      return { status: 204 };
    }
    return json(200, found);
  }
}
