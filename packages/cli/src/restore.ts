/**
 * Reassembly: turn a snapshot manifest plus a chunk store back into files.
 *
 * `restoreSnapshot` writes each object to disk; `verifySnapshot` runs the same
 * reconstruction path but writes nothing. Both stream chunk by chunk, so an
 * object never has to be fully buffered, and both check the same things:
 *
 *   - every chunk is the one the manifest asked for: its sealed header must
 *     carry the requested stored id (bound to the ciphertext as the AES-GCM
 *     AAD, so decryption authenticates it), and, when the keyring has the
 *     tenant's chunk-id key, the id recomputed from the decrypted plaintext
 *     must match as well
 *   - the reassembled object has the size and, when the manifest records one,
 *     the SHA-256 the manifest states
 *
 * A restored file is written under a temporary name next to its destination
 * and renamed into place only after every check passed. An object that fails
 * a check is reported in the run's failure list and leaves nothing behind: no
 * partial file, and no file with the wrong content under its name.
 *
 * Every engine records its folders as manifest objects at the parent paths of
 * their items (mailbox areas and folders, IMAP mailboxes, OneDrive folders),
 * so a folder becomes a directory and never a file. Records without content
 * (OneDrive shortcuts into other drives, packages) are reported as skipped.
 */
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type ManifestObject, type SnapshotManifest, sealedAad, storedId } from "@restow/core";
import type { Keyring } from "./keyring.js";
import { safeJoin } from "./store.js";
import type { ChunkStore } from "./store.js";

/** Per-object outcome. */
export interface ObjectResult {
  path: string;
  /** Bytes written (restore) or read back (verify). */
  bytes: number;
  ok: boolean;
  /** Present when the object has no content to restore (`ok` stays true): why. */
  skipped?: string;
  /** Present when `ok` is false. */
  error?: string;
  /**
   * True when the object failed because its data is not what the manifest
   * says (a chunk under the wrong id, a size or SHA-256 mismatch), as opposed
   * to data that could not be read at all.
   */
  integrity?: boolean;
}

/** Aggregate outcome of a restore or verify run. */
export interface RunReport {
  snapshotId: string;
  tenantId: string;
  total: number;
  /** Objects written (restore) or checked (verify), directories included. */
  restored: number;
  /** Records without content, see {@link ObjectResult.skipped}. */
  skipped: number;
  failed: number;
  results: ObjectResult[];
  /** The failed objects, in manifest order (the failure list). */
  failures: ObjectResult[];
}

/**
 * How an object materializes on disk, by its manifest type (the shared
 * vocabulary of @restow/core, restore/conventions.ts):
 *   directory  "folder": no chunks, kept so the tree (and empty folders) restore
 *   record     "package" or "shortcut" without chunks: recorded, nothing to write
 *   file       everything else, including untyped objects
 */
export type ObjectLayout =
  | { kind: "directory" }
  | { kind: "file" }
  | { kind: "record"; reason: string };

const CONTENTLESS_RECORDS: Readonly<Record<string, string>> = {
  shortcut: "shortcut to an item in another drive, recorded without content",
  package: "package recorded without content",
};

export function objectLayoutOf(object: Pick<ManifestObject, "type" | "chunks">): ObjectLayout {
  if (object.type === "folder") {
    return { kind: "directory" };
  }
  const reason = object.type === undefined ? undefined : CONTENTLESS_RECORDS[object.type];
  if (reason !== undefined && object.chunks.length === 0) {
    return { kind: "record", reason };
  }
  return { kind: "file" };
}

/** The object's data is not what the manifest says it is. */
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

const STORED_ID = /^(?:[0-9a-f]{2})+$/i;

function skippedResult(object: ManifestObject, reason: string): ObjectResult {
  return { path: object.path, bytes: 0, ok: true, skipped: reason };
}

function failedResult(object: ManifestObject, bytes: number, error: unknown): ObjectResult {
  return {
    path: object.path,
    bytes,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof IntegrityError ? { integrity: true } : {}),
  };
}

/**
 * Fetch and open one chunk, proving it is the chunk `hexId` names: the id
 * sealed into its header must match (GCM authenticates that header when the
 * chunk is decrypted), and with the chunk-id key the id recomputed from the
 * plaintext must match too.
 */
export async function openChunk(
  store: ChunkStore,
  keyring: Keyring,
  hexId: string,
): Promise<Buffer> {
  if (!STORED_ID.test(hexId)) {
    throw new IntegrityError(`the manifest names an invalid chunk id "${hexId}"`);
  }
  const wantedId = Buffer.from(hexId, "hex");
  const sealed = await store.getSealed(wantedId);
  let sealedId: Buffer;
  try {
    sealedId = sealedAad(sealed);
  } catch (error) {
    throw new IntegrityError(
      `chunk ${hexId} is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!sealedId.equals(wantedId)) {
    throw new IntegrityError(
      `chunk ${hexId} is stored under a mismatched id (${sealedId.toString("hex")})`,
    );
  }
  const plaintext = keyring.decrypt(sealed);
  if (keyring.hmacKey && !storedId(keyring.hmacKey, plaintext).equals(wantedId)) {
    throw new IntegrityError(`chunk ${hexId} failed the content hash check`);
  }
  return plaintext;
}

/** Streams an object's chunks while counting and hashing them. */
class ObjectReassembly {
  bytes = 0;
  private readonly hash = createHash("sha256");

  constructor(
    private readonly store: ChunkStore,
    private readonly keyring: Keyring,
    private readonly object: ManifestObject,
  ) {}

  async *chunks(): AsyncGenerator<Buffer> {
    for (const hexId of this.object.chunks) {
      const plaintext = await openChunk(this.store, this.keyring, hexId);
      this.bytes += plaintext.length;
      this.hash.update(plaintext);
      yield plaintext;
    }
  }

  /** Throws unless the reassembled bytes match the manifest's size and SHA-256. */
  assertComplete(verb: "wrote" | "read"): void {
    const { object } = this;
    if (this.bytes !== object.size) {
      throw new IntegrityError(
        `size mismatch: manifest says ${object.size} bytes, ${verb} ${this.bytes}`,
      );
    }
    const digest = this.hash.digest("hex");
    if (object.sha256 !== undefined && object.sha256.toLowerCase() !== digest) {
      throw new IntegrityError(
        `SHA-256 mismatch: manifest says ${object.sha256}, reassembled ${digest}`,
      );
    }
  }
}

/**
 * A short, random name in the destination's directory (same file system, so
 * the final rename is atomic). It does not embed the destination's name: a
 * name near the file system's length limit must not fail on the temporary.
 */
function temporaryPathFor(destination: string): string {
  const suffix = randomBytes(8).toString("hex");
  return join(dirname(destination), `.restow-restore-${suffix}.partial`);
}

/** Write one object below `outDir`: a directory for a folder, a file for content. */
async function restoreObject(
  object: ManifestObject,
  store: ChunkStore,
  keyring: Keyring,
  outDir: string,
): Promise<ObjectResult> {
  const layout = objectLayoutOf(object);
  if (layout.kind === "record") {
    return skippedResult(object, layout.reason);
  }
  const reassembly = new ObjectReassembly(store, keyring, object);
  let temporary: string | null = null;
  try {
    const destination = safeJoin(outDir, object.path);
    if (layout.kind === "directory") {
      await mkdir(destination, { recursive: true });
      return { path: object.path, bytes: 0, ok: true };
    }
    await mkdir(dirname(destination), { recursive: true });
    temporary = temporaryPathFor(destination);
    await pipeline(
      Readable.from(reassembly.chunks()),
      createWriteStream(temporary, { flags: "wx" }),
    );
    reassembly.assertComplete("wrote");
    await rename(temporary, destination);
    temporary = null;
    return { path: object.path, bytes: reassembly.bytes, ok: true };
  } catch (error) {
    return failedResult(object, reassembly.bytes, error);
  } finally {
    if (temporary) {
      await rm(temporary, { force: true });
    }
  }
}

/** Read one object back and run every check, writing nothing. */
async function verifyObject(
  object: ManifestObject,
  store: ChunkStore,
  keyring: Keyring,
): Promise<ObjectResult> {
  const layout = objectLayoutOf(object);
  if (layout.kind === "record") {
    return skippedResult(object, layout.reason);
  }
  const reassembly = new ObjectReassembly(store, keyring, object);
  try {
    for await (const _chunk of reassembly.chunks()) {
      // Reading is the check; the bytes are not kept.
    }
    reassembly.assertComplete("read");
    return { path: object.path, bytes: reassembly.bytes, ok: true };
  } catch (error) {
    return failedResult(object, reassembly.bytes, error);
  }
}

/** Write every object in the manifest to `outDir`, preserving logical paths. */
export async function restoreSnapshot(params: {
  manifest: SnapshotManifest;
  store: ChunkStore;
  keyring: Keyring;
  outDir: string;
  onObject?: (result: ObjectResult) => void;
}): Promise<RunReport> {
  const { manifest, store, keyring, outDir, onObject } = params;
  const results: ObjectResult[] = [];

  for (const object of manifest.objects) {
    const result = await restoreObject(object, store, keyring, outDir);
    results.push(result);
    onObject?.(result);
  }

  return summarize(manifest, results);
}

/** Reconstruct every object without writing and run the same checks as a restore. */
export async function verifySnapshot(params: {
  manifest: SnapshotManifest;
  store: ChunkStore;
  keyring: Keyring;
  onObject?: (result: ObjectResult) => void;
}): Promise<RunReport> {
  const { manifest, store, keyring, onObject } = params;
  const results: ObjectResult[] = [];

  for (const object of manifest.objects) {
    const result = await verifyObject(object, store, keyring);
    results.push(result);
    onObject?.(result);
  }

  return summarize(manifest, results);
}

function summarize(manifest: SnapshotManifest, results: ObjectResult[]): RunReport {
  const failures = results.filter((result) => !result.ok);
  const skipped = results.filter((result) => result.ok && result.skipped !== undefined).length;
  return {
    snapshotId: manifest.snapshotId,
    tenantId: manifest.tenantId,
    total: results.length,
    restored: results.length - failures.length - skipped,
    skipped,
    failed: failures.length,
    results,
    failures,
  };
}
