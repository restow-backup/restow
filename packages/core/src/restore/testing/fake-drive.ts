/**
 * A stateful fake of the OneDrive endpoints the restore uses: child lookup by
 * name, folder creation, simple upload, upload sessions, `fileSystemInfo`
 * patches and the user's drive. Uploaded bytes are kept so tests can compare
 * them; the QuickXorHash of the stored bytes is reported the way OneDrive
 * for Business does.
 */
import {
  type FakeGraph,
  type FixtureResponse,
  type FixtureRoute,
  type RecordedCall,
  createFakeGraph,
  graphError,
} from "../../graph/testing/fake-graph.js";
import { quickXorHash } from "../quickxorhash.js";

export interface FakeDriveItem {
  id: string;
  name: string;
  parentId: string;
  kind: "folder" | "file";
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
}

const NOT_FOUND: FixtureResponse = { status: 404, json: graphError("itemNotFound") };
const UPLOAD_HOST = "https://upload.example.test";

export class FakeDrive {
  readonly items = new Map<string, FakeDriveItem>();
  readonly sessions = new Map<string, FakeSession>();
  readonly graph: FakeGraph;
  /** When set, every reported QuickXorHash is replaced with this value (mismatch tests). */
  reportedQuickXorHash: string | null = null;
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

  private add(
    parentId: string,
    name: string,
    kind: "folder" | "file",
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

  private routes(): FixtureRoute[] {
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
    ];
  }

  private uploadFragment(call: RecordedCall): FixtureResponse {
    const id = new URL(call.url).pathname.slice(1);
    const session = this.sessions.get(id);
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
    if (match.length === 4) {
      const start = Number(match[1]);
      if (start !== session.receivedBytes) {
        return { status: 416, json: graphError("invalidRange") };
      }
      session.total = Number(match[3]);
    } else {
      session.total = Number(match[1]);
    }
    session.received.push(body);
    session.receivedBytes += body.length;
    if (session.receivedBytes < (session.total ?? 0)) {
      return { status: 202, json: { nextExpectedRanges: [`${session.receivedBytes}-`] } };
    }
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
