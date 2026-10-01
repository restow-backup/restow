/**
 * The restic REST backend protocol (v2) on top of the Restow storage
 * abstraction (docs/AGENT.md).
 *
 * `handleResticRequest` is a plain Fetch API handler (Request in, Response
 * out) with no web framework in it, so the API mounts it on
 * `/agent/restic/:endpointId/*` and the server's own loopback listener
 * (./loopback.ts) serves the very same code to restic runs on the server.
 * Who the caller is has been decided by then: the handler gets a
 * {@link ResticPrincipal} and applies the authorization matrix
 * (./restic-authz.ts) to every request.
 *
 * Storage layout: the objects of an endpoint's repository sit under
 * `endpoints/<endpoint id>/` in the tenant's primary storage target, in the
 * folder structure restic's own rest-server uses (`config`, `data/<xx>/<id>`,
 * `index/<id>`, `keys/<id>`, `locks/<id>`, `snapshots/<id>`). The folder is a
 * valid restic repository as it stands: with a local target, `restic -r
 * <path>` opens it without Restow (docs/AGENT.md, "Restore without Restow").
 *
 * Uploads and downloads are streamed and never held whole in memory. An
 * upload is verified against its name while it streams (every restic object is
 * named by the SHA-256 of its content); a stream that does not match fails
 * before the storage commits it, so a wrong object never becomes visible.
 * Bodies over `maxBodyBytes` (128 MiB; restic packs are smaller) are refused.
 *
 * Two guards apply to the agent only (the caller passes them in):
 *
 *   - Lock files: the agent's lock files are recorded when it writes them
 *     (`locks`), and it may delete only those. The server's own locks, and a
 *     lock it never wrote, stay where they are.
 *   - Storage budget: before an upload the handler asks how many bytes the
 *     agent may still add (`remainingBytes`). An upload that does not fit is
 *     refused with 403 and the problem type {@link QUOTA_EXCEEDED_PROBLEM}
 *     (403, not 507: restic gives up at once instead of sending the same pack
 *     again for a quarter of an hour). Lock files are exempt, so a restore on
 *     the machine still works when the budget is used up.
 */
import { createHash } from "node:crypto";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { type StorageBackend, listWithSizes, readRange } from "../storage/backend.js";
import {
  type ResticAction,
  type ResticPrincipal,
  type ResticResource,
  type ResticType,
  actionOf,
  authorizeResticAction,
  needsExistenceCheck,
  needsLockOwnership,
  parseResticPath,
} from "./restic-authz.js";

export const MAX_RESTIC_BODY_BYTES = 128 * 1024 * 1024;

/** The problem type of an upload refused because the storage budget is used up. */
export const QUOTA_EXCEEDED_PROBLEM = "urn:restow:problem:endpoint-quota-exceeded";

/** The lock files the append-only principal wrote, so it can release only its own. */
export interface ResticLockRegistry {
  /** Whether the lock `name` is one the agent wrote. */
  isOwn(name: string): Promise<boolean>;
  /** Record a lock the agent is about to write. */
  created(name: string): Promise<void>;
  /** Forget a lock that was deleted, or whose upload failed. */
  removed(name: string): Promise<void>;
}

const V2_CONTENT_TYPE = "application/vnd.x.restic.rest.v2";

export interface ResticRestOptions {
  storage: StorageBackend;
  /** Storage prefix of the repository, with a trailing slash: `endpoints/<id>/`. */
  prefix: string;
  principal: ResticPrincipal;
  /** Path below the repository root, e.g. `/data/ab/abcd...`; `/` is the root. */
  path: string;
  query?: URLSearchParams;
  maxBodyBytes?: number;
  /**
   * Called for every request that was allowed, after the fact, for accounting:
   * `bytes` is what a write stored and what a deletion freed, 0 otherwise.
   */
  onAllowed?: (event: {
    action: ResticAction;
    resource: ResticResource;
    bytes: number;
  }) => void | Promise<void>;
  /** Called for every request the authorization matrix refused. */
  onDenied?: (event: { action: ResticAction; resource: ResticResource; reason: string }) => void;
  /** The agent's lock files (see {@link ResticLockRegistry}); without it the agent deletes no lock. */
  locks?: ResticLockRegistry;
  /**
   * Bytes the caller may still add to the repository, or null for no limit.
   * Asked before every upload except a lock file.
   */
  remainingBytes?: () => Promise<number | null>;
  /** Called when an upload was refused because it does not fit the storage budget. */
  onQuotaExceeded?: (event: {
    resource: ResticResource;
    declaredBytes: number | null;
  }) => void | Promise<void>;
}

/** Marks an error that maps to a specific HTTP answer. */
class ResticHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** An `application/problem+json` answer of this type instead of plain text. */
    readonly problemType?: string,
  ) {
    super(message);
    this.name = "ResticHttpError";
  }
}

function text(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function quotaExceededError(): ResticHttpError {
  return new ResticHttpError(
    403,
    "The storage budget of this endpoint's repository is used up; the upload was refused.",
    QUOTA_EXCEEDED_PROBLEM,
  );
}

function errorResponse(error: ResticHttpError): Response {
  if (!error.problemType) {
    return text(error.status, error.message);
  }
  return new Response(
    JSON.stringify({
      type: error.problemType,
      title: "Storage quota exceeded",
      status: error.status,
      detail: error.message,
    }),
    { status: error.status, headers: { "content-type": "application/problem+json" } },
  );
}

/** The `Content-Length` of a request as a number, or null when it is absent or not one. */
function declaredLength(request: Request): number | null {
  const header = request.headers.get("content-length");
  if (header === null || !/^\d+$/.test(header.trim())) {
    return null;
  }
  return Number(header);
}

/** The storage key of a resource inside the repository prefix. */
export function objectKey(prefix: string, resource: ResticResource): string {
  switch (resource.kind) {
    case "config":
      return `${prefix}config`;
    case "object":
      return resource.type === "data"
        ? `${prefix}data/${resource.name.slice(0, 2)}/${resource.name}`
        : `${prefix}${resource.type}/${resource.name}`;
    default:
      throw new TypeError("only config and objects have a key");
  }
}

/** Parsed `Range` header: an inclusive byte range, or a reason to ignore or refuse it. */
export type ByteRange = { start: number; end: number } | "ignore" | "unsatisfiable";

export function parseRange(header: string | null, size: number): ByteRange {
  if (!header) {
    return "ignore";
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  // Multiple ranges and other units are not used by restic: answer the whole object.
  if (!match) {
    return "ignore";
  }
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") {
    return "ignore";
  }
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0) {
      return "unsatisfiable";
    }
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (start >= size || end < start) {
    return "unsatisfiable";
  }
  return { start, end };
}

/**
 * Counts the bytes of an upload, refuses one over the limit and, for objects
 * named by their content hash, refuses one whose SHA-256 differs from the
 * name. The verdict comes at the end of the stream, before a storage backend
 * can commit it.
 */
export class UploadGuard extends Transform {
  private readonly hash = createHash("sha256");
  bytes = 0;
  /** Why the upload was refused, once it was; the answer to give even when the storage reports something else. */
  failure: ResticHttpError | null = null;

  constructor(
    private readonly limit: number,
    private readonly expectedSha256: string | null,
    /** Bytes the storage budget still allows, or null for no budget. */
    private readonly budget: number | null = null,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      this.failure = new ResticHttpError(413, "request body too large");
      callback(this.failure);
      return;
    }
    if (this.budget !== null && this.bytes > this.budget) {
      this.failure = quotaExceededError();
      callback(this.failure);
      return;
    }
    if (this.expectedSha256) {
      this.hash.update(chunk);
    }
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    if (this.expectedSha256 && this.hash.digest("hex") !== this.expectedSha256) {
      this.failure = new ResticHttpError(400, "the content does not match the object name");
      callback(this.failure);
      return;
    }
    callback();
  }
}

function toBody(stream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

async function listObjects(
  storage: StorageBackend,
  prefix: string,
  type: ResticType,
  v2: boolean,
): Promise<Response> {
  const base = `${prefix}${type}/`;
  const entries = await listWithSizes(storage, base);
  const rows = entries
    .map((entry) => ({ name: entry.key.slice(entry.key.lastIndexOf("/") + 1), size: entry.size }))
    .filter((row) => row.name.length > 0);
  if (v2) {
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { "content-type": V2_CONTENT_TYPE },
    });
  }
  return new Response(JSON.stringify(rows.map((row) => row.name)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function readObject(
  storage: StorageBackend,
  key: string,
  request: Request,
  headOnly: boolean,
): Promise<Response> {
  const head = await storage.head(key);
  if (!head) {
    return text(404, "not found");
  }
  const base = {
    "content-type": "application/octet-stream",
    "accept-ranges": "bytes",
  };
  if (headOnly) {
    return new Response(null, {
      status: 200,
      headers: { ...base, "content-length": String(head.size) },
    });
  }
  const range = parseRange(request.headers.get("range"), head.size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${head.size}` },
    });
  }
  if (range === "ignore" || head.size === 0) {
    const stream = await storage.getStream(key);
    return new Response(toBody(stream), {
      status: 200,
      headers: { ...base, "content-length": String(head.size) },
    });
  }
  const stream = await readRange(storage, key, range.start, range.end);
  return new Response(toBody(stream), {
    status: 206,
    headers: {
      ...base,
      "content-length": String(range.end - range.start + 1),
      "content-range": `bytes ${range.start}-${range.end}/${head.size}`,
    },
  });
}

async function writeObject(
  storage: StorageBackend,
  key: string,
  resource: ResticResource,
  request: Request,
  limit: number,
  budget: number | null,
): Promise<{ response: Response; bytes: number; overBudget: boolean }> {
  const declared = declaredLength(request);
  if (declared !== null && declared > limit) {
    return { response: text(413, "request body too large"), bytes: 0, overBudget: false };
  }
  if (budget !== null && (budget <= 0 || (declared !== null && declared > budget))) {
    return { response: errorResponse(quotaExceededError()), bytes: 0, overBudget: true };
  }
  // Every object but the repository config is named by the SHA-256 of its content.
  const expected = resource.kind === "object" ? resource.name : null;
  const guard = new UploadGuard(limit, expected, budget);
  // The verdict can come before the storage starts reading (it opens a file
  // first); an error event nobody listens for would crash the process.
  guard.on("error", () => undefined);
  const source = request.body ? Readable.fromWeb(request.body as never) : Readable.from([]);
  source.on("error", (error) => guard.destroy(error));
  const verified = source.pipe(guard);
  try {
    await storage.put(key, verified);
  } catch (error) {
    verified.destroy();
    const cause =
      guard.failure ?? (error instanceof ResticHttpError ? error : findHttpError(error));
    if (cause) {
      return {
        response: errorResponse(cause),
        bytes: guard.bytes,
        overBudget: cause.problemType === QUOTA_EXCEEDED_PROBLEM,
      };
    }
    throw error;
  }
  if (guard.failure) {
    // Cannot happen with a backend that fails a write whose stream failed; refuse the upload
    // all the same and leave the key alone (it may be an object that was there before).
    return {
      response: errorResponse(guard.failure),
      bytes: guard.bytes,
      overBudget: guard.failure.problemType === QUOTA_EXCEEDED_PROBLEM,
    };
  }
  return { response: new Response(null, { status: 200 }), bytes: guard.bytes, overBudget: false };
}

function findHttpError(error: unknown): ResticHttpError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    if (current instanceof ResticHttpError) {
      return current;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Serve one request of the restic REST protocol against an endpoint's repository. */
export async function handleResticRequest(
  request: Request,
  options: ResticRestOptions,
): Promise<Response> {
  const { storage, prefix, principal } = options;
  const limit = options.maxBodyBytes ?? MAX_RESTIC_BODY_BYTES;
  const resource = parseResticPath(options.path);
  if (!resource) {
    return text(404, "not found");
  }
  const action = actionOf(request.method, resource);
  if (!action) {
    return text(405, "method not allowed");
  }

  // The repository itself: creating and deleting it.
  if (resource.kind === "repository") {
    const decision = authorizeResticAction(principal, action, resource, false);
    if (!decision.allowed) {
      options.onDenied?.({ action, resource, reason: decision.reason });
      return text(403, "forbidden");
    }
    if (action === "create") {
      // Folders exist implicitly in every storage backend; nothing to create.
      return options.query?.get("create") === "true"
        ? new Response(null, { status: 200 })
        : text(400, "missing create=true");
    }
    for (const key of await storage.list(prefix)) {
      await storage.delete(key);
    }
    await options.onAllowed?.({ action, resource, bytes: 0 });
    return new Response(null, { status: 200 });
  }

  // Object-less requests.
  if (resource.kind === "list") {
    const decision = authorizeResticAction(principal, action, resource, false);
    if (!decision.allowed) {
      options.onDenied?.({ action, resource, reason: decision.reason });
      return text(403, "forbidden");
    }
    const v2 = (request.headers.get("accept") ?? "").includes(V2_CONTENT_TYPE);
    const response = await listObjects(storage, prefix, resource.type, v2);
    await options.onAllowed?.({ action, resource, bytes: 0 });
    return response;
  }

  const key = objectKey(prefix, resource);
  // A lock file of the agent: recorded when written, and the only kind it may delete.
  const agentLock =
    principal === "agent" && resource.kind === "object" && resource.type === "locks"
      ? resource.name
      : null;
  const exists = needsExistenceCheck(principal, action)
    ? (await storage.head(key)) !== null
    : false;
  let present: { size: number } | null = null;
  let ownLock = false;
  if (needsLockOwnership(principal, action, resource) && agentLock) {
    // Releasing a lock that is gone already (the server removed it as stale) is no attempt
    // to remove someone else's: answer as restic's rest-server does, and forget the record.
    present = await storage.head(key);
    if (present === null) {
      await options.locks?.removed(agentLock);
      return text(404, "not found");
    }
    ownLock = (await options.locks?.isOwn(agentLock)) ?? false;
  }
  const decision = authorizeResticAction(principal, action, resource, exists, ownLock);
  if (!decision.allowed) {
    options.onDenied?.({ action, resource, reason: decision.reason });
    return text(403, decision.reason === "exists" ? "forbidden: object exists" : "forbidden");
  }

  switch (action) {
    case "head":
    case "read": {
      const response = await readObject(storage, key, request, action === "head");
      await options.onAllowed?.({ action, resource, bytes: 0 });
      return response;
    }
    case "write": {
      // Lock files do not count against the budget: a restore must work when it is used up.
      const budget =
        agentLock === null && options.remainingBytes ? await options.remainingBytes() : null;
      if (agentLock !== null) {
        await options.locks?.created(agentLock);
      }
      const { response, bytes, overBudget } = await writeObject(
        storage,
        key,
        resource,
        request,
        limit,
        budget,
      );
      if (response.ok) {
        await options.onAllowed?.({ action, resource, bytes });
      } else {
        if (agentLock !== null) {
          await options.locks?.removed(agentLock).catch(() => undefined);
        }
        if (overBudget) {
          await options.onQuotaExceeded?.({ resource, declaredBytes: declaredLength(request) });
        }
      }
      return response;
    }
    case "delete": {
      // Like restic's own rest-server: a missing object is a 404, not a success.
      const head = present ?? (await storage.head(key));
      if (head === null) {
        return text(404, "not found");
      }
      await storage.delete(key);
      if (agentLock !== null) {
        await options.locks?.removed(agentLock);
      }
      // A deletion reports the bytes it freed, so the caller can keep its usage count.
      await options.onAllowed?.({ action, resource, bytes: head.size });
      return new Response(null, { status: 200 });
    }
    default:
      return text(405, "method not allowed");
  }
}
