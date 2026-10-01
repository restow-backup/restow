/**
 * Test fixtures for verify and scrub: an in-memory storage backend that can be
 * damaged on purpose, and a real snapshot written through the chunk store.
 * Nothing here touches the network or the disk (docs/TESTING.md).
 */
import { Readable } from "node:stream";
import type { Dek } from "../crypto.js";
import { Keyring } from "../engine/keyring.js";
import {
  MemoryChunkIndex,
  type MemoryProgressSink,
  MemorySnapshotIndex,
  createMemoryJobContext,
} from "../engine/memory.js";
import { SnapshotWriter } from "../engine/snapshot.js";
import type {
  JobContext,
  ProtectedObjectKind,
  ProtectedObjectRef,
  StorageTargets,
} from "../engine/types.js";
import type { ManifestObject } from "../manifest.js";
import type { HeadResult, StorageBackend } from "../storage/backend.js";

export const TEST_TENANT = "0f0e0d0c-0b0a-4908-8706-050403020100";
export const TEST_DEK: Dek = { version: 1, material: Buffer.alloc(32, 0x3c) };

/** A map-backed {@link StorageBackend} with modification times and damage helpers. */
export class MemoryStorage implements StorageBackend {
  readonly files = new Map<string, { bytes: Buffer; modified: Date }>();
  /** Reads of keys under these prefixes fail with the error the factory makes (an outage). */
  private readonly failing: { prefix: string; error: () => unknown }[] = [];

  constructor(private readonly clock: () => Date = () => new Date()) {}

  /** Make every read of a key under `prefix` throw `error()` (the storage does not answer). */
  failReads(prefix: string, error: () => unknown): void {
    this.failing.push({ prefix, error });
  }

  async put(key: string, data: Buffer | Readable): Promise<void> {
    const bytes = Buffer.isBuffer(data) ? Buffer.from(data) : await collect(data);
    this.files.set(key, { bytes, modified: this.clock() });
  }

  async get(key: string): Promise<Buffer> {
    const failure = this.failing.find((entry) => key.startsWith(entry.prefix));
    if (failure) {
      throw failure.error();
    }
    const file = this.files.get(key);
    if (!file) {
      throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
    }
    return Buffer.from(file.bytes);
  }

  async getStream(key: string): Promise<Readable> {
    return Readable.from([await this.get(key)]);
  }

  async head(key: string): Promise<HeadResult | null> {
    const file = this.files.get(key);
    return file ? { size: file.bytes.length, lastModified: file.modified } : null;
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }

  /** Flip one byte of a stored file (bit rot). */
  flipByte(key: string, offset: number): void {
    const file = this.files.get(key);
    if (!file) {
      throw new Error(`no file ${key}`);
    }
    const at = offset < 0 ? file.bytes.length + offset : offset;
    file.bytes[at] = (file.bytes[at] ?? 0) ^ 0xff;
  }

  setModified(key: string, at: Date): void {
    const file = this.files.get(key);
    if (file) {
      file.modified = at;
    }
  }
}

async function collect(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) {
    parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
  }
  return Buffer.concat(parts);
}

/** Deterministic bytes with real entropy. */
export function fixtureBytes(size: number, seed: number): Buffer {
  const out = Buffer.alloc(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

export type FixtureItem = {
  readonly path: string;
  readonly type?: string;
  /** Content size in bytes; 0 for folders. */
  readonly size: number;
  readonly seed?: number;
};

export type StoreFixture = {
  readonly ctx: JobContext & { readonly progressSink: MemoryProgressSink };
  readonly storage: StorageTargets;
  readonly primary: MemoryStorage;
  readonly copies: MemoryStorage[];
  readonly index: MemoryChunkIndex;
  readonly snapshots: MemorySnapshotIndex;
  readonly clock: { now: Date };
  readonly protectedObject: ProtectedObjectRef;
};

export type StoreFixtureOptions = {
  readonly kind?: ProtectedObjectKind;
  readonly copies?: number;
  readonly now?: Date;
};

/** An empty store with one protected object and a controllable clock. */
export function createStoreFixture(options: StoreFixtureOptions = {}): StoreFixture {
  const clock = { now: options.now ?? new Date("2026-09-20T02:00:00.000Z") };
  const now = () => clock.now;
  const primary = new MemoryStorage(now);
  const copies = Array.from({ length: options.copies ?? 0 }, () => new MemoryStorage(now));
  const storage: StorageTargets = { primary, copies };
  const index = new MemoryChunkIndex();
  const snapshots = new MemorySnapshotIndex(TEST_TENANT);
  const ctx = createMemoryJobContext({
    tenantId: TEST_TENANT,
    keys: new Keyring(TEST_TENANT, [TEST_DEK]),
    storage,
    chunkIndex: index,
    snapshots,
    queue: "verify",
    now,
  });
  const protectedObject: ProtectedObjectRef = {
    id: "5b8f2c1e-9d4a-4f6b-8c3e-2a1d0e9f8b7c",
    tenantId: TEST_TENANT,
    sourceId: "7c6b5a49-3827-4165-9f4e-3d2c1b0a9f8e",
    kind: options.kind ?? "mailbox",
    externalId: "anna@example.org",
    displayName: "Anna Example",
    userId: null,
  };
  return {
    ctx: ctx as StoreFixture["ctx"],
    storage,
    primary,
    copies,
    index,
    snapshots,
    clock,
    protectedObject,
  };
}

/** Write `items` as one committed snapshot of the fixture's object. */
export async function writeSnapshot(
  fixture: StoreFixture,
  items: readonly FixtureItem[],
  maxPackBytes = 16 * 1024,
): Promise<{ snapshotId: string; objects: ManifestObject[] }> {
  const writer = await SnapshotWriter.begin(fixture.ctx, {
    protectedObject: fixture.protectedObject,
    sourceType: fixture.protectedObject.kind === "imap" ? "imap" : "m365",
    maxPackBytes,
  });
  const objects: ManifestObject[] = [];
  for (const [position, item] of items.entries()) {
    const content = item.size > 0 ? fixtureBytes(item.size, item.seed ?? position + 1) : null;
    const written = content ? await writer.chunks.write(content) : null;
    const object: ManifestObject = {
      path: item.path,
      size: written?.size ?? 0,
      mtime: Date.UTC(2026, 8, 1, 8, 0),
      id: `item-${position}`,
      ...(item.type !== undefined ? { type: item.type } : {}),
      ...(written ? { sha256: written.sha256 } : {}),
      chunks: written?.chunks ?? [],
    };
    writer.add(object);
    objects.push(object);
  }
  const committed = await writer.commit();
  return { snapshotId: committed.snapshotId, objects };
}

/** A typical mailbox snapshot: mails, events, contacts and a folder. */
export function mailboxItems(mails: number, extras = 3): FixtureItem[] {
  const items: FixtureItem[] = [{ path: "mail/Inbox", type: "folder", size: 0 }];
  for (let i = 0; i < mails; i++) {
    items.push({ path: `mail/Inbox/${i}.eml`, type: "mail", size: 600 + i * 7, seed: 100 + i });
  }
  for (let i = 0; i < extras; i++) {
    items.push({
      path: `calendar/Calendar/${i}.json`,
      type: "event",
      size: 300 + i,
      seed: 500 + i,
    });
    items.push({
      path: `contacts/Contacts/${i}.json`,
      type: "contact",
      size: 200 + i,
      seed: 700 + i,
    });
  }
  return items;
}
