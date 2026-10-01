/**
 * Read access to a Restow chunk store, for the standalone restore.
 *
 * Without a running server there is no Postgres chunk index, so this rebuilds
 * the stored-id -> pack mapping by scanning the pack index of every pack under
 * `tenants/<tid>/packs/` (the pack format carries its own index; see
 * @restow/core `PackReader` and docs/ARCHITECTURE.md). Pack files are opened on
 * demand through a small bounded cache so a large store never has to be held in
 * memory all at once.
 *
 * The scan covers every pack under the prefix rather than only the packs a
 * manifest lists: garbage collection repacks live chunks into new packs, so a
 * manifest's pack list can be stale while its chunks are still present.
 *
 * Manifests are stored sealed with the tenant key (@restow/core
 * `sealManifest`). The key a sealed manifest is bound to sits in its header in
 * clear text and names the tenant, so the tool knows which tenant's keys to
 * load before it can read anything else.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  PackReader,
  type SnapshotManifest,
  type StorageBackend,
  deserializeManifest,
  isManifestHeaderLine,
  isSealedManifest,
  openManifest,
  parseManifestKey,
  readManifestLines,
  sealedManifestKey,
} from "@restow/core";
import type { Keyring } from "./keyring.js";

/** How many decoded pack files to keep open at once during reconstruction. */
const PACK_CACHE_LIMIT = 6;

/** UTF-8 byte order mark some editors put in front of a hand-exported JSON file. */
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** JSON whitespace (RFC 8259): space, tab, line feed, carriage return. */
const JSON_WHITESPACE: ReadonlySet<number> = new Set([0x20, 0x09, 0x0a, 0x0d]);

const OPEN_BRACE = 0x7b;

function toHex(id: Buffer): string {
  return id.toString("hex");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withoutBom(bytes: Buffer): Buffer {
  return bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)
    ? bytes.subarray(UTF8_BOM.length)
    : bytes;
}

/**
 * Whether the bytes are plain JSON text rather than the codec-tagged form. A
 * serialized manifest starts with its codec tag (a control byte such as 0x03,
 * or 0x10 for a sealed one), which can never begin a JSON document, so the
 * first significant byte decides.
 */
export function isPlainJsonManifest(bytes: Buffer): boolean {
  for (const byte of withoutBom(bytes)) {
    if (!JSON_WHITESPACE.has(byte)) {
      return byte === OPEN_BRACE;
    }
  }
  return false;
}

/** Reject documents that parse but cannot drive a restore, with a message that says why. */
function assertManifestShape(value: unknown, source: string): SnapshotManifest {
  const candidate = value as Partial<SnapshotManifest> | null;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.tenantId !== "string" ||
    candidate.tenantId.length === 0 ||
    typeof candidate.snapshotId !== "string" ||
    !Array.isArray(candidate.objects)
  ) {
    throw new Error(
      `manifest ${source} is not a snapshot manifest (tenantId, snapshotId and objects are required)`,
    );
  }
  return candidate as SnapshotManifest;
}

/** Whether plain text is the line form (a header line, then one object per line). */
function isManifestLineText(text: Buffer): boolean {
  const end = text.indexOf(0x0a);
  return end > 0 && isManifestHeaderLine(text.subarray(0, end));
}

/** Loads the keys of the tenant a sealed manifest belongs to, once that tenant is known. */
export type ManifestKeyringResolver = (tenantId: string) => Promise<Pick<Keyring, "decrypt">>;

export interface ParseManifestOptions {
  /** Supplies the tenant keys a sealed manifest needs. */
  readonly keyringFor?: ManifestKeyringResolver;
  /** The storage key the bytes were read from; a sealed manifest bound to another key is refused. */
  readonly storageKey?: string;
}

/** Open a sealed manifest with the keys of the tenant its bound storage key names. */
async function openSealedManifest(
  bytes: Buffer,
  source: string,
  options: ParseManifestOptions,
): Promise<SnapshotManifest> {
  let tenantId: string;
  try {
    const bound = parseManifestKey(sealedManifestKey(bytes));
    if (!bound) {
      throw new Error("it is bound to a key outside the manifest layout");
    }
    tenantId = bound.tenantId;
  } catch (error) {
    throw new Error(`manifest ${source} could not be decoded: ${messageOf(error)}`);
  }
  if (!options.keyringFor) {
    throw new Error(`manifest ${source} is encrypted: the keys of tenant ${tenantId} are needed`);
  }
  const keyring = await options.keyringFor(tenantId);
  try {
    return await openManifest(bytes, {
      open: (sealed) => keyring.decrypt(sealed),
      storageKey: options.storageKey,
    });
  } catch (error) {
    throw new Error(`manifest ${source} could not be decoded: ${messageOf(error)}`);
  }
}

/**
 * Decode manifest bytes. A sealed manifest (the form Restow stores) is opened
 * with the tenant keys `keyringFor` supplies; other codec-tagged manifests go
 * through @restow/core `deserializeManifest`. Errors (an unknown codec, a
 * runtime without zstd, a corrupt or truncated payload, the wrong key)
 * surface as they are instead of being masked by a JSON fallback. Plain text
 * is accepted so an operator can hand the tool a manifest exported by hand:
 * either the uncompressed line form (a header line, then one object per line;
 * read line by line, so its size is not limited by the longest possible
 * string) or one JSON document.
 */
export async function parseManifest(
  bytes: Buffer,
  source: string,
  options: ParseManifestOptions = {},
): Promise<SnapshotManifest> {
  if (bytes.length === 0) {
    throw new Error(`manifest ${source} is empty`);
  }
  if (isSealedManifest(bytes)) {
    return assertManifestShape(await openSealedManifest(bytes, source, options), source);
  }
  if (!isPlainJsonManifest(bytes)) {
    let decoded: SnapshotManifest;
    try {
      decoded = await deserializeManifest(bytes);
    } catch (error) {
      throw new Error(`manifest ${source} could not be decoded: ${messageOf(error)}`);
    }
    return assertManifestShape(decoded, source);
  }
  const text = withoutBom(bytes);
  if (isManifestLineText(text)) {
    let decoded: SnapshotManifest;
    try {
      decoded = await readManifestLines([text]);
    } catch (error) {
      throw new Error(`manifest ${source} could not be decoded: ${messageOf(error)}`);
    }
    return assertManifestShape(decoded, source);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.toString("utf8"));
  } catch (error) {
    throw new Error(`manifest ${source} is not valid JSON: ${messageOf(error)}`);
  }
  return assertManifestShape(parsed, source);
}

/**
 * Read a snapshot manifest. `manifestRef` is a local file path when one exists
 * there, otherwise a key inside the storage backend. Accepts the sealed form
 * Restow stores (it needs `keyringFor`), the unsealed codec-tagged form of
 * older manifests (see @restow/core `serializeManifest`) and plain text (the
 * line form or one JSON document).
 */
export async function readManifest(
  manifestRef: string,
  backend: StorageBackend,
  keyringFor?: ManifestKeyringResolver,
): Promise<SnapshotManifest> {
  const local = existsSync(manifestRef);
  const bytes = local ? await readFile(manifestRef) : await backend.get(manifestRef);
  return parseManifest(bytes, manifestRef, {
    keyringFor,
    storageKey: local ? undefined : manifestRef,
  });
}

/** A pack the index scan could not open; the chunks it holds are unavailable to this run. */
export interface UnreadablePack {
  /** Storage key of the pack. */
  key: string;
  /** Why it could not be read (truncated, damaged, unreadable). */
  reason: string;
}

/**
 * The stored-id index plus a bounded cache of decoded packs. Built once per
 * restore from the manifest's tenant id.
 */
export class ChunkStore {
  private readonly readers = new Map<string, PackReader>();

  private constructor(
    private readonly backend: StorageBackend,
    /** hex(storedId) -> pack storage key. */
    private readonly index: Map<string, string>,
    private readonly unreadable: readonly UnreadablePack[],
  ) {}

  /**
   * Scan every pack for `tenantId` and build the stored-id index. A pack that
   * cannot be opened (for example an orphan a worker left half-written when it
   * was killed) is recorded in `unreadablePacks` and skipped, so every object
   * whose chunks sit in intact packs stays restorable; objects that need a
   * chunk only the skipped pack held fail on their own.
   */
  static async build(backend: StorageBackend, tenantId: string): Promise<ChunkStore> {
    const packPrefix = `tenants/${tenantId}/packs/`;
    const packKeys = await backend.list(packPrefix);
    const index = new Map<string, string>();
    const unreadable: UnreadablePack[] = [];
    for (const packKey of packKeys) {
      let reader: PackReader;
      try {
        // verify:false keeps index building fast; the scrub / `verify` command
        // is where whole-pack hashes are checked.
        reader = PackReader.open(await backend.get(packKey), { verify: false });
      } catch (error) {
        unreadable.push({ key: packKey, reason: messageOf(error) });
        continue;
      }
      for (const entry of reader.entries()) {
        index.set(toHex(entry.storedId), packKey);
      }
    }
    return new ChunkStore(backend, index, unreadable);
  }

  /** Number of distinct stored chunks discovered across all readable packs. */
  get chunkCount(): number {
    return this.index.size;
  }

  /** Packs the scan skipped because they could not be opened. */
  get unreadablePacks(): readonly UnreadablePack[] {
    return this.unreadable;
  }

  private async readerFor(packKey: string): Promise<PackReader> {
    const cached = this.readers.get(packKey);
    if (cached) {
      // Refresh recency.
      this.readers.delete(packKey);
      this.readers.set(packKey, cached);
      return cached;
    }
    const bytes = await this.backend.get(packKey);
    const reader = PackReader.open(bytes, { verify: false });
    this.readers.set(packKey, reader);
    if (this.readers.size > PACK_CACHE_LIMIT) {
      const oldest = this.readers.keys().next().value;
      if (oldest !== undefined) {
        this.readers.delete(oldest);
      }
    }
    return reader;
  }

  /** Fetch the sealed bytes of one chunk by its stored id. Throws if missing. */
  async getSealed(storedId: Buffer): Promise<Buffer> {
    const hex = toHex(storedId);
    const packKey = this.index.get(hex);
    if (!packKey) {
      const skipped = this.unreadable.length;
      throw new Error(
        skipped > 0
          ? `chunk ${hex} is not present in any readable pack of this store (${skipped} unreadable pack(s) skipped)`
          : `chunk ${hex} is not present in any pack of this store`,
      );
    }
    const reader = await this.readerFor(packKey);
    const sealed = reader.get(storedId);
    if (!sealed) {
      throw new Error(`chunk ${hex} was indexed in ${packKey} but could not be read`);
    }
    return sealed;
  }
}

/**
 * Join a manifest object's logical path onto an output directory, refusing any
 * path that would escape it (absolute paths, `..`, drive-relative segments).
 */
export function safeJoin(outDir: string, logicalPath: string): string {
  const root = resolve(outDir);
  const parts = logicalPath.split(/[\\/]+/).filter((part) => part.length > 0 && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new Error(`manifest object path escapes the output directory: ${logicalPath}`);
  }
  const target = resolve(root, ...parts);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || rel.split(sep).includes("..")) {
    throw new Error(`manifest object path escapes the output directory: ${logicalPath}`);
  }
  return target;
}
