/**
 * S3-compatible storage backend (AWS, Hetzner Object Storage, Garage, Wasabi, Backblaze B2, ...).
 *
 * A thin adapter over @aws-sdk/client-s3 v3. Object lock is requested via
 * `retainUntil` for archive/WORM targets. Retries are the SDK's.
 *
 * Buffers (packs, manifests, keys) go up in one PutObject. Streams of unknown
 * length (the restore ZIP) cannot: the SDK needs the length of a streamed body
 * up front, and a single PutObject ends at 5 GiB. A stream is therefore read
 * part by part into a bounded buffer and uploaded as a multipart upload; a
 * stream that ends within its first part still becomes a single PutObject.
 */
import type { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  type ChecksumAlgorithm,
  CompleteMultipartUploadCommand,
  type CompletedPart,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import type { HeadResult, PutOptions, StorageBackend } from "./backend.js";

const MIB = 1024 * 1024;

/** S3 limits for a multipart upload: parts are numbered 1..10,000; all but the last >= 5 MiB. */
export const MAX_MULTIPART_PARTS = 10_000;
export const MIN_MULTIPART_PART_SIZE = 5 * MIB;

const FIRST_PART_SIZE = 8 * MIB;
const LARGEST_PART_SIZE = 64 * MIB;
const PARTS_PER_SIZE_STEP = 1_000;

/**
 * The size of part `partNumber` (1-based): 8 MiB for the first thousand
 * parts, doubling every thousand after up to 64 MiB. Small uploads buffer
 * little, and the 10,000 parts S3 allows still carry about 490 GiB with only
 * one part buffered at a time.
 */
export function multipartPartSize(partNumber: number): number {
  const step = Math.floor((partNumber - 1) / PARTS_PER_SIZE_STEP);
  return Math.min(FIRST_PART_SIZE * 2 ** step, LARGEST_PART_SIZE);
}

/** The most bytes one multipart upload can carry with {@link multipartPartSize}. */
export function multipartCapacity(): number {
  let total = 0;
  for (let part = 1; part <= MAX_MULTIPART_PARTS; part++) {
    total += multipartPartSize(part);
  }
  return total;
}

/** One part of a multipart upload. */
export interface UploadPart {
  /** 1-based, as S3 numbers parts. */
  partNumber: number;
  data: Buffer;
}

function asBuffer(chunk: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  return typeof chunk === "string"
    ? Buffer.from(chunk)
    : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

/**
 * Cut a byte stream into parts of the sizes `sizeOf(partNumber)` asks for.
 * Every part but the last is full; an empty stream yields one empty part. At
 * most one part is buffered, and the next is read only when the consumer
 * asks for it, so a slow upload holds the stream back.
 */
export async function* streamParts(
  stream: AsyncIterable<Buffer | Uint8Array | string>,
  sizeOf: (partNumber: number) => number = multipartPartSize,
): AsyncGenerator<UploadPart> {
  let partNumber = 1;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  for await (const chunk of stream) {
    let rest = asBuffer(chunk);
    while (rest.length > 0) {
      const size = sizeOf(partNumber);
      const taken = rest.subarray(0, size - pendingBytes);
      rest = rest.subarray(taken.length);
      pending.push(taken);
      pendingBytes += taken.length;
      if (pendingBytes === size) {
        yield { partNumber, data: Buffer.concat(pending, pendingBytes) };
        partNumber += 1;
        pending = [];
        pendingBytes = 0;
      }
    }
  }
  if (pendingBytes > 0 || partNumber === 1) {
    yield { partNumber, data: Buffer.concat(pending, pendingBytes) };
  }
}

export interface S3StorageOptions {
  bucket: string;
  /** Optional key prefix, prepended to every key (e.g. an installation namespace). */
  prefix?: string;
  /** An existing client, or `clientConfig` to construct one. */
  client?: S3Client;
  clientConfig?: S3ClientConfig;
  /** Object-lock mode to use when a `retainUntil` is given. Defaults to COMPLIANCE. */
  objectLockMode?: "GOVERNANCE" | "COMPLIANCE";
}

function isNotFound(error: unknown): boolean {
  const err = error as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  return (
    err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404
  );
}

export class S3StorageBackend implements StorageBackend {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly objectLockMode: "GOVERNANCE" | "COMPLIANCE";

  constructor(options: S3StorageOptions) {
    this.client = options.client ?? new S3Client(options.clientConfig ?? {});
    this.bucket = options.bucket;
    this.prefix = options.prefix ? options.prefix.replace(/\/+$/, "") : "";
    this.objectLockMode = options.objectLockMode ?? "COMPLIANCE";
  }

  private keyFor(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  private stripPrefix(key: string): string {
    if (this.prefix && key.startsWith(`${this.prefix}/`)) {
      return key.slice(this.prefix.length + 1);
    }
    return key;
  }

  async put(key: string, data: Buffer | Readable, options?: PutOptions): Promise<void> {
    if (Buffer.isBuffer(data)) {
      await this.putObject(key, data, options);
      return;
    }
    await this.putStream(key, data, options);
  }

  private objectLock(options: PutOptions | undefined) {
    return {
      ObjectLockRetainUntilDate: options?.retainUntil,
      ObjectLockMode: options?.retainUntil ? this.objectLockMode : undefined,
    };
  }

  private async putObject(key: string, data: Buffer, options?: PutOptions): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.keyFor(key),
        Body: data,
        ContentLength: data.length,
        ContentType: options?.contentType,
        ...this.objectLock(options),
      }),
    );
  }

  /**
   * Upload a stream of unknown length: one PutObject when it fits in the
   * first part, a multipart upload otherwise. Any failure, of the stream or
   * of a request, aborts the multipart upload so no orphaned parts are billed.
   */
  private async putStream(key: string, stream: Readable, options?: PutOptions): Promise<void> {
    const parts = streamParts(stream);
    const first = await parts.next();
    const firstPart = first.done ? { partNumber: 1, data: Buffer.alloc(0) } : first.value;
    if (firstPart.data.length < multipartPartSize(1)) {
      // The stream ended within the first part: its length is known now.
      await parts.return(undefined);
      await this.putObject(key, firstPart.data, options);
      return;
    }

    const checksumAlgorithm = await this.partChecksumAlgorithm();
    let uploadId: string | undefined;
    try {
      const created = await this.client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: this.keyFor(key),
          ContentType: options?.contentType,
          ChecksumAlgorithm: checksumAlgorithm,
          ...this.objectLock(options),
        }),
      );
      uploadId = created.UploadId;
      if (!uploadId) {
        throw new Error(`the storage returned no upload id for ${key}`);
      }
      const completed = [await this.uploadPart(key, uploadId, firstPart, checksumAlgorithm)];
      for await (const part of parts) {
        if (part.partNumber > MAX_MULTIPART_PARTS) {
          throw new Error(
            `${key} exceeds the largest multipart upload (${multipartCapacity()} bytes)`,
          );
        }
        completed.push(await this.uploadPart(key, uploadId, part, checksumAlgorithm));
      }
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: this.keyFor(key),
          UploadId: uploadId,
          MultipartUpload: { Parts: completed },
        }),
      );
    } catch (error) {
      stream.destroy();
      if (uploadId) {
        await this.abortUpload(key, uploadId);
      }
      throw error;
    }
  }

  /**
   * Drop the parts of a failed upload. The upload's own failure is what the
   * caller needs, so a failed abort is not reported; the parts it leaves
   * behind are removed by the bucket's lifecycle rules.
   */
  private async abortUpload(key: string, uploadId: string): Promise<void> {
    await this.client
      .send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: this.keyFor(key),
          UploadId: uploadId,
        }),
      )
      .catch(() => undefined);
  }

  private async uploadPart(
    key: string,
    uploadId: string,
    part: UploadPart,
    checksumAlgorithm: ChecksumAlgorithm | undefined,
  ): Promise<CompletedPart> {
    const result = await this.client.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: this.keyFor(key),
        UploadId: uploadId,
        PartNumber: part.partNumber,
        Body: part.data,
        ContentLength: part.data.length,
        ChecksumAlgorithm: checksumAlgorithm,
      }),
    );
    return {
      PartNumber: part.partNumber,
      ETag: result.ETag,
      ChecksumCRC32: result.ChecksumCRC32,
    };
  }

  /**
   * The checksum the parts carry. With the SDK's default (checksums whenever
   * an operation supports them) the upload is declared CRC32 from the start,
   * so every part and the completion agree; a client configured to send
   * checksums only when required sends none.
   */
  private async partChecksumAlgorithm(): Promise<ChecksumAlgorithm | undefined> {
    const calculation = await this.client.config.requestChecksumCalculation();
    return calculation === "WHEN_SUPPORTED" ? "CRC32" : undefined;
  }

  async get(key: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.keyFor(key) }),
    );
    if (!result.Body) {
      throw new Error(`empty response body for ${key}`);
    }
    const bytes = await result.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async getStream(key: string): Promise<Readable> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.keyFor(key) }),
    );
    if (!result.Body) {
      throw new Error(`empty response body for ${key}`);
    }
    // In Node the SDK returns a Readable; the union also covers browser stream types.
    return result.Body as unknown as Readable;
  }

  async getRange(key: string, start: number, end: number): Promise<Readable> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.keyFor(key),
        Range: `bytes=${start}-${end}`,
      }),
    );
    if (!result.Body) {
      throw new Error(`empty response body for ${key}`);
    }
    return result.Body as unknown as Readable;
  }

  async listWithSizes(prefix: string): Promise<{ key: string; size: number }[]> {
    const entries: { key: string; size: number }[] = [];
    let continuationToken: string | undefined;
    const fullPrefix = this.keyFor(prefix);
    do {
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: fullPrefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of result.Contents ?? []) {
        if (object.Key) {
          entries.push({ key: this.stripPrefix(object.Key), size: object.Size ?? 0 });
        }
      }
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);
    return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async head(key: string): Promise<HeadResult | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.keyFor(key) }),
      );
      return {
        size: result.ContentLength ?? 0,
        etag: result.ETag,
        lastModified: result.LastModified,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    const fullPrefix = this.keyFor(prefix);
    do {
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: fullPrefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of result.Contents ?? []) {
        if (object.Key) {
          keys.push(this.stripPrefix(object.Key));
        }
      }
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys.sort();
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.keyFor(key) }));
  }
}
