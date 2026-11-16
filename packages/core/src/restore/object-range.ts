/**
 * A backed-up object as a seekable upload source. An upload session that lost
 * a fragment (or the answer to one) continues from the offset Graph reports
 * (graph/resources/upload-session.ts); with a plain stream the bytes before
 * the current fragment are gone. The object is stored as a list of chunks, so
 * any earlier offset can be read again from the chunk that holds it: the
 * plaintext offset of each chunk is learned as the object is read the first
 * time, and a seek back starts the chunk reader at that chunk.
 *
 * Every byte goes into `digest` exactly once and in order, however often a
 * range is read, so the digest proves what the target was sent.
 */
import { type ChunkReader, RestoreIntegrityError } from "../engine/chunkstore.js";
import type { RangeReader } from "../graph/resources/upload-session.js";
import type { ManifestObject } from "../manifest.js";

export interface DigestSink {
  update(chunk: Uint8Array): void;
}

export class ObjectRangeSource {
  /** `starts[i]` is the plaintext offset of chunk i; known for every chunk read so far. */
  private readonly starts: number[] = [0];
  private iterator: AsyncGenerator<Buffer> | null = null;
  /** Index of the chunk the iterator yields next. */
  private nextChunk = 0;
  /** Plaintext offset of the first byte in `pending`. */
  private position = 0;
  private pending: Buffer = Buffer.alloc(0);
  /** Bytes fed to the digest, always a prefix of the object. */
  private digested = 0;
  /** How often a read had to go back to an earlier chunk (for tests and logs). */
  seeks = 0;

  constructor(
    private readonly reader: ChunkReader,
    private readonly object: ManifestObject,
    private readonly digest?: DigestSink,
  ) {}

  /** The {@link RangeReader} to hand to an upload. */
  readonly read: RangeReader = async (offset, length) => {
    if (offset < 0 || offset + length > this.object.size) {
      throw new RestoreIntegrityError(
        `object ${this.object.path}: range ${offset}+${length} is outside its ${this.object.size} bytes`,
      );
    }
    if (this.iterator === null || offset < this.position) {
      this.seekTo(offset);
    }
    const parts: Buffer[] = [];
    let collected = 0;
    while (collected < length) {
      if (this.pending.length === 0 && !(await this.loadChunk())) {
        break;
      }
      const end = this.position + this.pending.length;
      if (end <= offset) {
        this.position = end;
        this.pending = Buffer.alloc(0);
        continue;
      }
      if (this.position < offset) {
        this.pending = this.pending.subarray(offset - this.position);
        this.position = offset;
      }
      const take = Math.min(this.pending.length, length - collected);
      parts.push(this.pending.subarray(0, take));
      this.pending = this.pending.subarray(take);
      this.position += take;
      collected += take;
    }
    if (this.position === this.object.size && this.pending.length === 0) {
      await this.finish();
    }
    return Buffer.concat(parts, collected);
  };

  /** Stop reading (the upload ended or failed). */
  async close(): Promise<void> {
    const iterator = this.iterator;
    this.iterator = null;
    await iterator?.return(undefined);
  }

  private seekTo(offset: number): void {
    let chunk = 0;
    while (chunk + 1 < this.starts.length && (this.starts[chunk + 1] as number) <= offset) {
      chunk++;
    }
    if (this.iterator !== null) {
      this.seeks++;
      void this.iterator.return(undefined);
    }
    this.iterator = this.reader.read(this.object.chunks.slice(chunk));
    this.nextChunk = chunk;
    this.position = this.starts[chunk] as number;
    this.pending = Buffer.alloc(0);
  }

  /** Read the next chunk into `pending`; false at the end of the object. */
  private async loadChunk(): Promise<boolean> {
    const iterator = this.iterator;
    if (iterator === null) {
      return false;
    }
    const next = await iterator.next();
    if (next.done) {
      return false;
    }
    const chunk = next.value;
    const start = this.starts[this.nextChunk] as number;
    const known = this.starts[this.nextChunk + 1];
    if (known === undefined) {
      this.starts[this.nextChunk + 1] = start + chunk.length;
    } else if (known !== start + chunk.length) {
      throw new RestoreIntegrityError(
        `object ${this.object.path}: chunk ${this.nextChunk} has ${chunk.length} bytes on a second reading, ${known - start} on the first`,
      );
    }
    this.nextChunk++;
    this.position = start;
    this.pending = chunk;
    const end = start + chunk.length;
    if (this.digest && end > this.digested && start <= this.digested) {
      this.digest.update(chunk.subarray(this.digested - start));
      this.digested = end;
    }
    return true;
  }

  /** The whole object has been read: its size must be the manifest's. */
  private async finish(): Promise<void> {
    if (this.nextChunk === this.object.chunks.length) {
      const total = this.starts[this.nextChunk] as number;
      if (total !== this.object.size) {
        throw new RestoreIntegrityError(
          `object ${this.object.path}: size mismatch (manifest ${this.object.size}, reconstructed ${total})`,
        );
      }
    }
  }
}
