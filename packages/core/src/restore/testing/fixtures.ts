/**
 * Test fixtures for the restore engines: a real snapshot written through the
 * chunk store into a temporary local storage backend, plus request builders.
 * Nothing here touches the network (docs/TESTING.md).
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Dek } from "../../crypto.js";
import { Keyring } from "../../engine/keyring.js";
import {
  type MemoryChunkIndex,
  MemoryProgressSink,
  createMemoryJobContext,
} from "../../engine/memory.js";
import { SnapshotWriter } from "../../engine/snapshot.js";
import type {
  JobContext,
  ProtectedObjectKind,
  ProtectedObjectRef,
  RestoreMode,
  RestoreRequest,
  RestoreSelection,
  RestoreTarget,
} from "../../engine/types.js";
import type { ManifestObject } from "../../manifest.js";
import { LocalStorageBackend } from "../../storage/local.js";

export const FIXTURE_TENANT = "11111111-2222-4333-8444-555555555555";

export interface FixtureObject {
  readonly path: string;
  readonly content: Buffer | string;
  readonly type?: string;
  readonly id?: string;
  readonly mtime?: number;
  readonly metadata?: Record<string, string>;
}

export interface SnapshotFixture {
  readonly ctx: JobContext & { readonly progressSink: MemoryProgressSink };
  readonly protectedObject: ProtectedObjectRef;
  readonly snapshotId: string;
  readonly objects: ManifestObject[];
  readonly storage: LocalStorageBackend;
  readonly root: string;
  cleanup(): Promise<void>;
}

export interface SnapshotFixtureOptions {
  readonly kind: ProtectedObjectKind;
  readonly externalId: string;
  readonly objects: readonly FixtureObject[];
  readonly tenantId?: string;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

/** Deterministic bytes with real entropy so FastCDC finds cut points. */
export function pseudoRandomBytes(size: number, seed: number): Buffer {
  const out = Buffer.alloc(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

export type JobContextFixture = Omit<SnapshotFixture, "snapshotId" | "objects">;

/** A job context over a fresh local store with in-memory indexes, and a protected object. */
export async function createJobContextFixture(
  options: Omit<SnapshotFixtureOptions, "objects">,
): Promise<JobContextFixture> {
  const tenantId = options.tenantId ?? FIXTURE_TENANT;
  const root = await mkdtemp(join(tmpdir(), "restow-restore-"));
  const storage = new LocalStorageBackend(root);
  const dek: Dek = { version: 1, material: Buffer.alloc(32, 0x5a) };
  const progressSink = new MemoryProgressSink();
  const ctx = {
    ...createMemoryJobContext({
      tenantId,
      keys: new Keyring(tenantId, [dek]),
      storage,
      queue: "restore",
      now: options.now,
      signal: options.signal,
      progressSink,
    }),
    progressSink,
  };
  const protectedObject: ProtectedObjectRef = {
    id: randomUUID(),
    tenantId,
    sourceId: randomUUID(),
    kind: options.kind,
    externalId: options.externalId,
    displayName: null,
    userId: null,
  };
  return {
    ctx,
    protectedObject,
    storage,
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Write the objects into a fresh local store and commit them as one snapshot. */
export async function createSnapshotFixture(
  options: SnapshotFixtureOptions,
): Promise<SnapshotFixture> {
  const { ctx, protectedObject, storage, root, cleanup } = await createJobContextFixture(options);
  const writer = await SnapshotWriter.begin(ctx, {
    protectedObject,
    sourceType: options.kind === "imap" ? "imap" : "m365",
    maxPackBytes: 1024 * 1024,
  });
  const objects: ManifestObject[] = [];
  for (const fixture of options.objects) {
    const bytes = Buffer.isBuffer(fixture.content)
      ? fixture.content
      : Buffer.from(fixture.content, "utf8");
    const isFolder = fixture.type === "folder";
    const written = isFolder ? null : await writer.chunks.write(bytes);
    const object: ManifestObject = {
      path: fixture.path,
      size: written?.size ?? 0,
      mtime: fixture.mtime ?? Date.UTC(2026, 0, 15, 10, 30),
      ...(fixture.id !== undefined ? { id: fixture.id } : {}),
      ...(fixture.type !== undefined ? { type: fixture.type } : {}),
      ...(written ? { sha256: written.sha256 } : {}),
      ...(fixture.metadata !== undefined ? { metadata: fixture.metadata } : {}),
      chunks: written?.chunks ?? [],
    };
    writer.add(object);
    objects.push(object);
  }
  const committed = await writer.commit();
  return {
    ctx,
    protectedObject,
    snapshotId: committed.snapshotId,
    objects,
    storage,
    root,
    cleanup,
  };
}

export interface RequestOptions {
  readonly selection?: RestoreSelection;
  readonly target?: RestoreTarget;
  readonly mode?: RestoreMode;
  readonly restoreJobId?: string;
  readonly options?: Record<string, unknown>;
  readonly requestedAt?: Date;
}

export function restoreRequestFor(
  fixture: Pick<SnapshotFixture, "protectedObject" | "snapshotId">,
  options: RequestOptions = {},
): RestoreRequest {
  const request: RestoreRequest & { options?: Record<string, unknown> } = {
    restoreJobId: options.restoreJobId ?? randomUUID(),
    snapshotId: fixture.snapshotId,
    protectedObject: fixture.protectedObject,
    selection: options.selection ?? { all: true },
    target: options.target ?? { type: "original", ref: null },
    mode: options.mode ?? "rename",
    actor: { userId: null, impersonated: false, reason: null },
    ...(options.requestedAt !== undefined ? { requestedAt: options.requestedAt } : {}),
  };
  if (options.options) {
    request.options = options.options;
  }
  return request;
}

/**
 * Flip the last byte of an object's first stored chunk, so reading the object
 * fails authentication: a backup that cannot be restored.
 */
export async function corruptStoredObject(
  fixture: Pick<SnapshotFixture, "ctx" | "storage">,
  object: ManifestObject,
): Promise<void> {
  const chunk = object.chunks[0];
  const location =
    chunk === undefined
      ? undefined
      : (fixture.ctx.chunkIndex as MemoryChunkIndex).chunks.get(chunk);
  if (!location) {
    throw new Error(`object ${object.path} has no stored chunk to corrupt`);
  }
  const pack = await fixture.storage.get(location.packPath);
  const last = location.offset + location.length - 1;
  pack[last] = (pack[last] ?? 0) ^ 0xff;
  await fixture.storage.put(location.packPath, pack);
}

/** A small but complete RFC 5322 message. */
export function mimeMessage(input: {
  messageId: string;
  subject: string;
  body?: string;
  date?: string;
}): string {
  return [
    `Message-ID: ${input.messageId}`,
    `Date: ${input.date ?? "Thu, 15 Jan 2026 10:30:00 +0000"}`,
    "From: Anna Example <anna@example.org>",
    "To: Ben Example <ben@example.org>",
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    input.body ?? "Hello from the fixture.",
    "",
  ].join("\r\n");
}
