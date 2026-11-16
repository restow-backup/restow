/**
 * A stateful fake of the OneDrive endpoints the restore uses: child lookup by
 * name, folder creation, simple upload, upload sessions, `fileSystemInfo`
 * patches and the user's drive. Uploaded bytes are kept so tests can compare
 * them; the QuickXorHash of the stored bytes is reported the way OneDrive
 * for Business does.
 */

import { GraphResponseTimeoutError } from "../../graph/client.js";
import {
  createFakeGraph,
  type FakeGraph,
  type FixtureResponse,
  type FixtureRoute,
  graphError,
  type RecordedCall,
} from "../../graph/testing/fake-graph.js";
import { quickXorHash } from "../quickxorhash.js";

export interface FakeDriveItem {
  id: string;
  name: string;
  parentId: string;
  /** A package is what OneDrive returns for a OneNote notebook: a container without a folder facet. */
  kind: "folder" | "file" | "package";
  content: Buffer;
  fileSystemInfo: Record<string, unknown> | undefined;
  conflictBehavior: string | undefined;
}

interface FakeSession {
  driveId: string;
  parentId: string;
  name: string;
  conflictBehavior: string | undefined;
  fileSystemInfo: Record<string, unknown> | undefined;
  received: Buffer[];
  receivedBytes: number;
  total: number | null;
  ranges: string[];
  /** The last fragment arrived and the item was created: the upload URL is gone. */
  completed: boolean;
  /** Cancelled with DELETE on the upload URL. */
  cancelled: boolean;
}

/**
 * What goes wrong with one fragment PUT, the way SharePoint and the network do it:
 * - `status`: the fragment is refused with this status (500, 502, ...) and nothing is taken;
 * - `reset-after-accept`: the bytes are taken, then the connection breaks before the answer;
 * - `timeout-after-accept`: the bytes are taken, the answer does not come in time (the client
 *   sends the fragment once more, which the session refuses with 416);
 * - `lose-previous`: answered 500, and the session lost the fragment before this one (it
 *   expects that range again).
 */
export type FragmentFault =
  | { kind: "status"; status: number }
  | { kind: "reset-after-accept" }
  | { kind: "timeout-after-accept" }
  | { kind: "lose-previous" };

function connectionReset(): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  });
}

const NOT_FOUND: FixtureResponse = { status: 404, json: graphError("itemNotFound") };

function isOfficeFile(name: string): boolean {
  return /\.(docx|xlsx|pptx)$/i.test(name);
}

/** What SharePoint does to an Office file's document properties: other bytes, another size. */
export function rewriteOfficeProperties(content: Buffer): Buffer {
  return Buffer.concat([content, Buffer.from(`<cp:lastModifiedBy>SharePoint</cp:lastModifiedBy>`)]);
}
const UPLOAD_HOST = "https://upload.example.test";

export class FakeDrive {
  readonly items = new Map<string, FakeDriveItem>();
  readonly sessions = new Map<string, FakeSession>();
  readonly graph: FakeGraph;
  /** When set, every reported QuickXorHash is replaced with this value (mismatch tests). */
  reportedQuickXorHash: string | null = null;
  /**
   * Like a SharePoint library: an uploaded Office file is stored with its
   * document properties rewritten, so its size and hash differ from the bytes
   * that were sent.
   */
  rewritesOfficeFiles = false;
  /** Faults by the first byte of a fragment's Content-Range; each is used `times` times. */
  private readonly fragmentFaults: Array<{ start: number; fault: FragmentFault; times: number }> =
    [];
  private counter = 0;

  constructor(
    readonly driveId = "drive-anna",
    readonly drivesByUser: Record<string, string> = { "carla@example.org": "drive-carla" },
  ) {
    this.items.set("root", {
      id: "root",
      name: "root",
      parentId: "",
      kind: "folder",
      content: Buffer.alloc(0),
      fileSystemInfo: undefined,
      conflictBehavior: undefined,
    });
    this.graph = createFakeGraph(this.routes());
  }

  addFolder(parentId: string, name: string): FakeDriveItem {
    return this.add(parentId, name, "folder", Buffer.alloc(0));
  }

  addFile(parentId: string, name: string, content: Buffer): FakeDriveItem {
    return this.add(parentId, name, "file", content);
  }

  /** Let the fragment that starts at byte `start` fail with `fault`, `times` times. */
  failFragmentAt(start: number, fault: FragmentFault, times = 1): void {
    this.fragmentFaults.push({ start, fault, times });
  }

  /** A OneNote notebook as OneDrive lists it: `package: { type: "oneNote" }`, no `folder` facet. */
  addNotebook(parentId: string, name: string): FakeDriveItem {
    return this.add(parentId, name, "package", Buffer.alloc(0));
  }

  private add(
    parentId: string,
    name: string,
    kind: FakeDriveItem["kind"],
    content: Buffer,
  ): FakeDriveItem {
    this.counter++;
    const item: FakeDriveItem = {
      id: `item-${this.counter}`,
      name,
      parentId,
      kind,
      content,
      fileSystemInfo: undefined,
      conflictBehavior: undefined,
    };
    this.items.set(item.id, item);
    return item;
  }

  child(parentId: string, name: string): FakeDriveItem | undefined {
    return [...this.items.values()].find(
      (item) => item.parentId === parentId && item.name.toLowerCase() === name.toLowerCase(),
    );
  }

  /** Path of an item from the root, e.g. `Documents/report.docx`. */
  pathOf(id: string): string {
    const item = this.items.get(id);
    if (!item || item.id === "root") {
      return "";
    }
    const parent = this.pathOf(item.parentId);
    return parent.length === 0 ? item.name : `${parent}/${item.name}`;
  }

  files(): FakeDriveItem[] {
    return [...this.items.values()].filter((item) => item.kind === "file");
  }

  toJson(item: FakeDriveItem): Record<string, unknown> {
    const base = {
      id: item.id,
      name: item.name,
      size: item.content.length,
      parentReference: { id: item.parentId, driveId: this.driveId },
      fileSystemInfo: item.fileSystemInfo,
    };
    if (item.kind === "folder") {
      return { ...base, folder: { childCount: 0 } };
    }
    if (item.kind === "package") {
      return { ...base, package: { type: "oneNote" } };
    }
    return {
      ...base,
      file: {
        mimeType: "application/octet-stream",
        hashes: { quickXorHash: this.reportedQuickXorHash ?? quickXorHash(item.content) },
      },
    };
  }

  /** Like OneDrive under conflictBehavior=rename: the first free `name N.ext`, N from 1. */
  private freeCopyName(parentId: string, name: string): string {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    let copy = 1;
    while (this.child(parentId, `${stem} ${copy}${extension}`)) {
      copy++;
    }
    return `${stem} ${copy}${extension}`;
  }

  /** `/drives/{d}/root:/x` -> parent "root"; `/drives/{d}/items/{id}:/x` -> parent id. */
  private parentAndName(url: URL): { parentId: string; name: string } | null {
    const decoded = decodeURIComponent(url.pathname);
    const match = /\/drives\/[^/]+\/(root|items\/[^/:]+):\/([^/:]+)(?::|$)/.exec(decoded);
    if (!match) {
      return null;
    }
    const parentId = match[1] === "root" ? "root" : (match[1] as string).slice("items/".length);
    return { parentId, name: match[2] as string };
  }

  private place(
    parentId: string,
    name: string,
    content: Buffer,
    conflictBehavior: string | undefined,
    fileSystemInfo: Record<string, unknown> | undefined,
  ): FixtureResponse {
    if (this.rewritesOfficeFiles && isOfficeFile(name)) {
      content = rewriteOfficeProperties(content);
    }
    const existing = this.child(parentId, name);
    let finalName = name;
    if (existing) {
      if (conflictBehavior === "fail" || conflictBehavior === undefined) {
        return { status: 409, json: graphError("nameAlreadyExists") };
      }
      if (conflictBehavior === "replace") {
        existing.content = content;
        existing.fileSystemInfo = fileSystemInfo ?? existing.fileSystemInfo;
        existing.conflictBehavior = conflictBehavior;
        return { status: 200, json: this.toJson(existing) };
      }
      finalName = this.freeCopyName(parentId, name);
    }
    const item = this.addFile(parentId, finalName, content);
    item.conflictBehavior = conflictBehavior;
    item.fileSystemInfo = fileSystemInfo;
    return { status: 201, json: this.toJson(item) };
  }

  /** The routes behind {@link graph}, for tests that combine this drive with other fakes. */
  routes(): FixtureRoute[] {
    const path = (pattern: RegExp) => (url: URL) => pattern.test(decodeURIComponent(url.pathname));
    return [
      {
        method: "GET",
        url: path(/\/users\/[^/]+\/drive$/),
        respond: (call) => {
          const parts = new URL(call.url).pathname.split("/");
          const user = decodeURIComponent(parts[parts.indexOf("users") + 1] ?? "");
          const id = this.drivesByUser[user];
          return id
            ? { status: 200, json: { id, driveType: "business" } }
            : { status: 404, json: graphError("ResourceNotFound") };
        },
      },
      {
        method: "GET",
        url: path(/\/drives\/[^/]+\/(root|items\/[^/:]+):\/[^/:]+$/),
        respond: (call) => {
          const target = this.parentAndName(new URL(call.url));
          const item = target ? this.child(target.parentId, target.name) : undefined;
          return item ? { status: 200, json: this.toJson(item) } : NOT_FOUND;
        },
      },
      {
        method: "POST",
        url: path(/\/drives\/[^/]+\/(root|items\/[^/:]+)\/children$/),
        respond: (call) => {
          const decoded = decodeURIComponent(new URL(call.url).pathname);
          const match = /\/(root|items\/([^/]+))\/children$/.exec(decoded);
          const parentId = match?.[2] ?? "root";
          const body = call.json as { name: string; "@microsoft.graph.conflictBehavior"?: string };
          if (this.child(parentId, body.name)) {
            return { status: 409, json: graphError("nameAlreadyExists") };
          }
          return { status: 201, json: this.toJson(this.addFolder(parentId, body.name)) };
        },
      },
      {
        method: "PUT",
        url: path(/\/drives\/[^/]+\/(root|items\/[^/:]+):\/[^/:]+:\/content$/),
        respond: (call) => {
          const url = new URL(call.url);
          const target = this.parentAndName(url);
          if (!target) {
            return NOT_FOUND;
          }
          const body =
            call.body instanceof Uint8Array
              ? Buffer.from(call.body)
              : Buffer.from(String(call.body ?? ""));
          return this.place(
            target.parentId,
            target.name,
            body,
            url.searchParams.get("@microsoft.graph.conflictBehavior") ?? undefined,
            undefined,
          );
        },
      },
      {
        method: "PATCH",
        url: path(/\/drives\/[^/]+\/items\/[^/:]+$/),
        respond: (call) => {
          const id = decodeURIComponent(new URL(call.url).pathname).split("/").pop() ?? "";
          const item = this.items.get(id);
          if (!item) {
            return NOT_FOUND;
          }
          const body = call.json as { fileSystemInfo?: Record<string, unknown> };
          item.fileSystemInfo = body.fileSystemInfo;
          return { status: 200, json: this.toJson(item) };
        },
      },
      {
        method: "POST",
        url: path(/\/drives\/[^/]+\/(root|items\/[^/:]+):\/[^/:]+:\/createUploadSession$/),
        respond: (call) => {
          const target = this.parentAndName(new URL(call.url));
          if (!target) {
            return NOT_FOUND;
          }
          const body = call.json as {
            item?: {
              "@microsoft.graph.conflictBehavior"?: string;
              fileSystemInfo?: Record<string, unknown>;
            };
          };
          this.counter++;
          const id = `session-${this.counter}`;
          this.sessions.set(id, {
            driveId: this.driveId,
            parentId: target.parentId,
            name: target.name,
            conflictBehavior: body.item?.["@microsoft.graph.conflictBehavior"],
            fileSystemInfo: body.item?.fileSystemInfo,
            received: [],
            receivedBytes: 0,
            total: null,
            ranges: [],
            completed: false,
            cancelled: false,
          });
          return {
            status: 200,
            json: { uploadUrl: `${UPLOAD_HOST}/${id}`, nextExpectedRanges: ["0-"] },
          };
        },
      },
      {
        method: "PUT",
        url: (url) => url.href.startsWith(`${UPLOAD_HOST}/`),
        respond: (call) => this.uploadFragment(call),
      },
      {
        // The session's status: what it still expects (404 once it completed or was cancelled).
        method: "GET",
        url: (url) => url.href.startsWith(`${UPLOAD_HOST}/`),
        respond: (call) => {
          const session = this.liveSession(call);
          return session
            ? {
                status: 200,
                json: {
                  expirationDateTime: "2099-01-01T00:00:00Z",
                  nextExpectedRanges: [`${session.receivedBytes}-`],
                },
              }
            : NOT_FOUND;
        },
      },
      {
        method: "DELETE",
        url: (url) => url.href.startsWith(`${UPLOAD_HOST}/`),
        respond: (call) => {
          const session = this.liveSession(call);
          if (!session) {
            return NOT_FOUND;
          }
          session.cancelled = true;
          return { status: 204 };
        },
      },
    ];
  }

  private liveSession(call: RecordedCall): FakeSession | undefined {
    const session = this.sessions.get(new URL(call.url).pathname.slice(1));
    return session && !session.completed && !session.cancelled ? session : undefined;
  }

  /** The fault planned for a fragment starting at `start`, used up as it is taken. */
  private takeFault(start: number): FragmentFault | undefined {
    const planned = this.fragmentFaults.find((entry) => entry.start === start && entry.times > 0);
    if (!planned) {
      return undefined;
    }
    planned.times -= 1;
    return planned.fault;
  }

  private uploadFragment(call: RecordedCall): FixtureResponse {
    const session = this.liveSession(call);
    if (!session) {
      return NOT_FOUND;
    }
    if (call.headers.authorization) {
      return { status: 401, json: graphError("Unauthorized", "token sent to upload URL") };
    }
    const range = call.headers["content-range"] ?? "";
    session.ranges.push(range);
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range) ?? /^bytes \*\/(\d+)$/.exec(range);
    if (!match) {
      return { status: 400, json: graphError("invalidRange") };
    }
    const body = call.body instanceof Uint8Array ? Buffer.from(call.body) : Buffer.alloc(0);
    let fault: FragmentFault | undefined;
    if (match.length === 4) {
      const start = Number(match[1]);
      if (start !== session.receivedBytes) {
        return { status: 416, json: graphError("invalidRange") };
      }
      session.total = Number(match[3]);
      fault = this.takeFault(start);
    } else {
      session.total = Number(match[1]);
    }
    if (fault?.kind === "status") {
      return { status: fault.status, json: graphError("generalException") };
    }
    if (fault?.kind === "lose-previous") {
      const lost = session.received.pop();
      session.receivedBytes -= lost?.length ?? 0;
      return { status: 500, json: graphError("generalException") };
    }
    session.received.push(body);
    session.receivedBytes += body.length;
    const answer = this.answerFragment(session);
    if (fault?.kind === "reset-after-accept") {
      throw connectionReset();
    }
    if (fault?.kind === "timeout-after-accept") {
      throw new GraphResponseTimeoutError(call.url, 120_000);
    }
    return answer;
  }

  private answerFragment(session: FakeSession): FixtureResponse {
    if (session.receivedBytes < (session.total ?? 0)) {
      return { status: 202, json: { nextExpectedRanges: [`${session.receivedBytes}-`] } };
    }
    session.completed = true;
    const content = Buffer.concat(session.received);
    return this.place(
      session.parentId,
      session.name,
      content,
      session.conflictBehavior,
      session.fileSystemInfo,
    );
  }
}
