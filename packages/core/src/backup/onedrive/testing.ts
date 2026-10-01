/**
 * Test harness for the OneDrive engine: an in-memory job context over a
 * temporary local storage root, a fake Graph wired to canned drive content,
 * and a fetch wrapper that serves a file as a real byte stream so streaming
 * behaviour can be asserted. Used by the *.test.ts files next to it only.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Dek } from "../../crypto.js";
import { ChunkReader } from "../../engine/chunkstore.js";
import { Keyring } from "../../engine/keyring.js";
import {
  MemoryChunkIndex,
  MemoryCursorStore,
  MemoryProgressSink,
  MemorySnapshotIndex,
  createMemoryJobContext,
} from "../../engine/memory.js";
import type { ProgressUpdate } from "../../engine/progress.js";
import { loadManifest } from "../../engine/snapshot.js";
import type { BackupResult, JobContext, ProtectedObjectRef } from "../../engine/types.js";
import type { GraphClient } from "../../graph/client.js";
import {
  type FakeGraph,
  type FixtureResponse,
  type FixtureRoute,
  createFakeGraph,
} from "../../graph/testing/fake-graph.js";
import type { ManifestObject, SnapshotManifest } from "../../manifest.js";
import type { StorageBackend } from "../../storage/backend.js";
import { LocalStorageBackend } from "../../storage/local.js";
import { OneDriveBackupEngine, type OneDriveBackupEngineOptions } from "./engine.js";

export const TENANT = "aaaaaaaa-0000-4000-8000-00000000d21e";
export const DRIVE = "b!drive1";
export const DELTA_PATH = `/v1.0/drives/${DRIVE}/root/delta`;
export const FIXED_NOW = new Date("2026-09-22T10:00:00Z");

export const dek: Dek = { version: 1, material: Buffer.alloc(32, 0x0d) };

export const oneDrive: ProtectedObjectRef = {
  id: "po-onedrive-1",
  tenantId: TENANT,
  sourceId: "src-1",
  kind: "onedrive",
  externalId: DRIVE,
  displayName: "Alice Example",
  userId: null,
};

/** Random-looking but deterministic bytes so FastCDC finds real cut points. */
export function pseudoRandom(size: number, seed: number): Buffer {
  const out = Buffer.alloc(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

/** Route matcher for the delta endpoint with a given token (or none for the initial URL). */
export function deltaUrl(token: string | null): (url: URL) => boolean {
  return (url) =>
    url.pathname === DELTA_PATH &&
    (token === null ? !url.searchParams.has("token") : url.searchParams.get("token") === token);
}

/** Route matcher for a download URL by its `item` query parameter. */
export function downloadUrl(item: string): (url: URL) => boolean {
  return (url) => url.pathname.endsWith("/download.aspx") && url.searchParams.get("item") === item;
}

export function bytesResponse(content: string | Buffer, headers?: Record<string, string>) {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return { status: 200, bytes: new Uint8Array(bytes), headers } satisfies FixtureResponse;
}

/** One download route per item, answering with the given bytes (or a canned response). */
export function contentRoutes(
  contents: Record<string, string | Buffer | FixtureResponse | FixtureResponse[]>,
): FixtureRoute[] {
  return Object.entries(contents).map(([item, content]) => ({
    url: downloadUrl(item),
    respond:
      typeof content === "string" || Buffer.isBuffer(content) ? bytesResponse(content) : content,
  }));
}

/**
 * Wrap a fetch so URLs matching `matcher` are answered with a body that
 * arrives as a stream of `pieceSize` slices, the way a real download does.
 */
export function streamingFetch(
  base: typeof fetch,
  matcher: (url: URL) => Buffer | null,
  pieceSize = 64 * 1024,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const bytes = matcher(url);
    if (bytes === null) {
      return base(input, init);
    }
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + pieceSize)));
        offset += pieceSize;
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.length),
      },
    });
  }) as unknown as typeof fetch;
}

/**
 * Wrap a fetch so URLs matching `matcher` start answering with `prefix` and
 * then fail mid-stream, the way a reset connection does.
 */
export function interruptedFetch(
  base: typeof fetch,
  matcher: (url: URL) => boolean,
  prefix: Buffer,
  announcedLength: number,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (!matcher(url)) {
      return base(input, init);
    }
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new Uint8Array(prefix));
          return;
        }
        controller.error(new Error("socket hang up"));
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(announcedLength),
      },
    });
  }) as unknown as typeof fetch;
}

/** Storage whose pack writes fail, as a full disk or a revoked bucket would. */
export function failingPackStorage(inner: StorageBackend, message = "no space left on device") {
  const storage: StorageBackend = {
    put: (key, data, options) =>
      key.includes("/packs/") ? Promise.reject(new Error(message)) : inner.put(key, data, options),
    get: (key) => inner.get(key),
    getStream: (key) => inner.getStream(key),
    head: (key) => inner.head(key),
    list: (prefix) => inner.list(prefix),
    delete: (key) => inner.delete(key),
  };
  return storage;
}

export interface HarnessContextOptions {
  readonly jobId?: string;
  readonly signal?: AbortSignal;
  readonly attempt?: number;
  /** Observe every progress update (the harness sink still records it). */
  readonly onProgress?: (update: ProgressUpdate) => void;
  /** Replace the pinned clock. */
  readonly now?: () => Date;
  /** Replace the local storage root (e.g. with a failing wrapper). */
  readonly storage?: StorageBackend;
}

/** Everything one engine test needs, sharing indexes and cursor across runs like the worker does. */
export class Harness {
  readonly chunkIndex = new MemoryChunkIndex();
  readonly snapshots = new MemorySnapshotIndex(TENANT);
  readonly cursor = new MemoryCursorStore();
  readonly keys = new Keyring(TENANT, [dek]);
  readonly progress = new MemoryProgressSink();
  private nextSnapshot = 1;
  private nextPack = 1;

  private constructor(readonly root: string) {}

  static async create(): Promise<Harness> {
    return new Harness(await mkdtemp(join(tmpdir(), "restow-onedrive-")));
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  get storage(): LocalStorageBackend {
    return new LocalStorageBackend(this.root);
  }

  context(options: HarnessContextOptions = {}): JobContext {
    return createMemoryJobContext({
      tenantId: TENANT,
      keys: this.keys,
      storage: options.storage ?? this.storage,
      chunkIndex: this.chunkIndex,
      snapshots: this.snapshots,
      cursor: this.cursor,
      progressSink: options.onProgress
        ? {
            publish: async (update) => {
              options.onProgress?.(update);
              await this.progress.publish(update);
            },
          }
        : this.progress,
      jobId: options.jobId ?? "job-1",
      attempt: options.attempt,
      signal: options.signal,
      now: options.now ?? (() => FIXED_NOW),
    });
  }

  engine(
    graph: FakeGraph | GraphClient,
    options: Partial<OneDriveBackupEngineOptions> = {},
  ): OneDriveBackupEngine {
    const client: GraphClient = "client" in graph && "calls" in graph ? graph.client() : graph;
    return new OneDriveBackupEngine({
      graph: async () => client,
      // The clock is pinned in tests; the item threshold alone decides.
      checkpointMinIntervalMs: 0,
      snapshotIdGenerator: () => `snap-${this.nextSnapshot++}`,
      packIdGenerator: () => `pack-${String(this.nextPack++).padStart(4, "0")}`,
      ...options,
    });
  }

  async manifest(result: BackupResult): Promise<SnapshotManifest> {
    const record = await this.snapshots.get(result.snapshotId);
    if (!record?.manifestPath) {
      throw new Error(`snapshot ${result.snapshotId} has no manifest`);
    }
    return loadManifest({ primary: this.storage, copies: [] }, record.manifestPath, this.keys);
  }

  async readObject(object: ManifestObject): Promise<Buffer> {
    const reader = new ChunkReader({
      storage: { primary: this.storage, copies: [] },
      keys: this.keys,
      index: this.chunkIndex,
    });
    return reader.readObjectToBuffer(object);
  }
}

export function objectAt(manifest: SnapshotManifest, path: string): ManifestObject {
  const object = manifest.objects.find((o) => o.path === path);
  if (!object) {
    throw new Error(
      `manifest has no object at ${path}; has ${manifest.objects.map((o) => o.path).join(", ")}`,
    );
  }
  return object;
}

export function paths(manifest: SnapshotManifest): string[] {
  return manifest.objects.map((o) => o.path);
}

export { createFakeGraph };
