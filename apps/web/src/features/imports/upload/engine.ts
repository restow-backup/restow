import type { ImportUploadDto } from "../types";
import { UploadAborted, UploadFailure, classifyFailure } from "./errors";
import { Semaphore } from "./semaphore";
import { hashBlob } from "./sha256";
import type { UploadErrorCode, UploadEvent, UploadSource, UploadTransport } from "./types";

/** Segments in flight at the same time, over all files. */
export const DEFAULT_CONCURRENCY = 3;
/** Extra tries of one request after the first attempt. */
export const DEFAULT_MAX_RETRIES = 3;

/** 500 ms, 1 s, 2 s, 4 s ... a short pause that grows with every failed try. */
export function defaultBackoffMs(retry: number): number {
  return 500 * 2 ** retry;
}

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new UploadAborted());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new UploadAborted());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface EngineOptions {
  transport: UploadTransport;
  onEvent: (event: UploadEvent) => void;
  /** Segments in flight at once (default 3). */
  concurrency?: number;
  /** Retries of a request after the first attempt (default 3). */
  maxRetries?: number;
  backoffMs?: (retry: number) => number;
  /** Segment size to ask for when creating an upload; the server's answer is what counts. */
  segmentSize?: number;
  /** Larger files are refused before anything is sent. */
  maxFileBytes?: number;
  /** Hash of a segment for `X-Segment-Sha256`; `null` sends no header. */
  hash?: (blob: Blob) => Promise<string | null>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface EnqueueInput {
  localId: string;
  file: UploadSource;
  /** An earlier upload of this file found on the server; continued when it still matches. */
  resume?: ImportUploadDto | null;
}

interface Entry {
  input: EnqueueInput;
  controller: AbortController;
  /** The upload on the server, once there is one. */
  uploadId: string | null;
  /** An earlier upload of this file to look for first. */
  resumeId: string | null;
  /** Set once the upload is complete on the server (never deleted afterwards). */
  finished: boolean;
  /** The file left the queue and `run` began. */
  started: boolean;
  /** `run` returned (or the file was dropped from the queue). */
  settled: boolean;
  done: Promise<void>;
  settle: () => void;
  /** A stop (cancel) is under way; a second one waits for it. */
  stopping: Promise<void> | null;
}

/** Bytes of the given segments of a file cut into `segmentSize` pieces. */
export function bytesOfSegments(
  indices: Iterable<number>,
  size: number,
  segmentSize: number,
): number {
  let total = 0;
  for (const index of indices) {
    const start = index * segmentSize;
    total += Math.max(0, Math.min(size, start + segmentSize) - start);
  }
  return total;
}

/**
 * Chunked, resumable upload of files into the import staging area.
 *
 * Each file: `POST /imports/uploads`, its segments as raw `PUT` bodies (three
 * in flight at a time over all files, every segment a `File.slice` hashed with
 * SHA-256), then `POST .../complete`. A segment is retried with a growing
 * pause; segments the server already holds are skipped, which is also how an
 * interrupted upload continues. Nothing here reads more than one segment per
 * slot into memory.
 *
 * `cancel` aborts and deletes the upload on the server; `suspend` only aborts
 * (the page is going away) so the upload can be picked up again later.
 */
export class UploadEngine {
  private readonly transport: UploadTransport;
  private readonly onEvent: (event: UploadEvent) => void;
  private readonly concurrency: number;
  private readonly maxRetries: number;
  private readonly backoffMs: (retry: number) => number;
  private readonly segmentSizeHint: number | undefined;
  private readonly maxFileBytes: number | undefined;
  private readonly hash: (blob: Blob) => Promise<string | null>;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly slots: Semaphore;
  private readonly entries = new Map<string, Entry>();
  private readonly queue: Entry[] = [];
  private running = 0;
  private suspended = false;

  constructor(options: EngineOptions) {
    this.transport = options.transport;
    this.onEvent = options.onEvent;
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.backoffMs = options.backoffMs ?? defaultBackoffMs;
    this.segmentSizeHint = options.segmentSize;
    this.maxFileBytes = options.maxFileBytes;
    this.hash = options.hash ?? hashBlob;
    this.sleep = options.sleep ?? defaultSleep;
    this.slots = new Semaphore(this.concurrency);
  }

  /** Queue a file; it starts as soon as a file slot is free. */
  enqueue(input: EnqueueInput): void {
    const previous = this.entries.get(input.localId);
    if (previous && !previous.settled) {
      return;
    }
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const entry: Entry = {
      input,
      controller: new AbortController(),
      uploadId: null,
      // A file run again continues its own upload when the server still has it.
      resumeId: input.resume?.id ?? previous?.uploadId ?? null,
      finished: false,
      started: false,
      settled: false,
      done,
      stopping: null,
      settle: () => {
        entry.settled = true;
        resolveDone();
      },
    };
    this.entries.set(input.localId, entry);
    this.queue.push(entry);
    this.pump();
  }

  /** Resolves when every queued file has finished, failed or been cancelled. */
  async idle(): Promise<void> {
    for (;;) {
      const pending = [...this.entries.values()].filter((entry) => !entry.settled);
      if (pending.length === 0) {
        return;
      }
      await Promise.all(pending.map((entry) => entry.done));
    }
  }

  /** Stop one file and delete its upload on the server. */
  async cancel(localId: string): Promise<void> {
    const entry = this.entries.get(localId);
    if (!entry) {
      return;
    }
    await this.stop(entry, true);
  }

  /** Stop everything and delete the unfinished uploads on the server. */
  async cancelAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.stop(entry, true)));
  }

  /** Stop everything without deleting: the page is going away and the uploads stay resumable. */
  suspend(): void {
    this.suspended = true;
    for (const entry of this.entries.values()) {
      entry.controller.abort();
    }
  }

  // --- scheduling ----------------------------------------------------------------

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry || entry.controller.signal.aborted) {
        entry?.settle();
        continue;
      }
      this.running += 1;
      entry.started = true;
      void this.run(entry).finally(() => {
        this.running -= 1;
        entry.settle();
        this.pump();
      });
    }
  }

  private stop(entry: Entry, removeUpload: boolean): Promise<void> {
    entry.stopping ??= this.stopNow(entry, removeUpload);
    return entry.stopping;
  }

  private async stopNow(entry: Entry, removeUpload: boolean): Promise<void> {
    const wasFinished = entry.finished;
    entry.controller.abort();
    if (!entry.started) {
      // Still waiting in the queue: nothing runs, so nobody else settles it.
      this.queue.splice(0, this.queue.length, ...this.queue.filter((queued) => queued !== entry));
      entry.settle();
    }
    await entry.done;
    if (removeUpload && entry.uploadId) {
      try {
        await this.transport.remove(entry.uploadId);
      } catch {
        // Best effort: an upload that could not be deleted expires on its own.
      }
    }
    if (!wasFinished) {
      this.emit({ type: "cancelled", localId: entry.input.localId });
    }
    this.entries.delete(entry.input.localId);
  }

  private emit(event: UploadEvent): void {
    if (!this.suspended) {
      this.onEvent(event);
    }
  }

  // --- one file ------------------------------------------------------------------

  private async run(entry: Entry): Promise<void> {
    const { localId, file } = entry.input;
    const { signal } = entry.controller;
    try {
      if (file.size <= 0) {
        throw new UploadFailure("empty");
      }
      if (this.maxFileBytes !== undefined && file.size > this.maxFileBytes) {
        throw new UploadFailure("too_large");
      }
      this.emit({ type: "opening", localId });
      const upload = await this.open(entry);
      entry.uploadId = upload.id;

      if (upload.status !== "ready") {
        await this.sendSegments(entry, upload, missingIndices(upload));
      }
      const finalUpload = upload.status === "ready" ? upload : await this.complete(entry, upload);
      await this.conclude(entry, finalUpload);
    } catch (error) {
      const failure = classifyFailure(error, signal);
      if (failure instanceof UploadAborted) {
        return;
      }
      this.emit({ type: "failed", localId, code: failure.code });
    }
  }

  private async conclude(entry: Entry, upload: ImportUploadDto): Promise<void> {
    const { localId } = entry.input;
    if (upload.refusal) {
      this.emit({ type: "refused", localId, upload });
      // A refused file is never imported; free its staging area right away.
      entry.uploadId = null;
      try {
        await this.transport.remove(upload.id);
      } catch {
        // Best effort, it expires on its own.
      }
      entry.finished = true;
      return;
    }
    entry.finished = true;
    this.emit({ type: "ready", localId, upload });
  }

  /** Find the upload to continue or create a new one; announces `started`. */
  private async open(entry: Entry): Promise<ImportUploadDto> {
    const { localId, file } = entry.input;
    const { signal } = entry.controller;
    const resumeId = entry.resumeId;

    let upload: ImportUploadDto | null = null;
    let resumed = false;
    if (resumeId) {
      try {
        const current = await this.retrying(entry, -1, () => this.transport.get(resumeId, signal));
        if (
          current.fileName === file.name &&
          current.size === file.size &&
          (current.status === "uploading" || current.status === "ready")
        ) {
          upload = current;
          resumed = true;
        }
      } catch (error) {
        const failure = classifyFailure(error, signal);
        // The upload expired or was deleted meanwhile: start over instead of failing.
        if (failure instanceof UploadAborted || failure.code !== "gone") {
          throw failure;
        }
      }
    }
    if (!upload) {
      upload = await this.retrying(entry, -1, () =>
        this.transport.create(
          {
            fileName: file.name,
            size: file.size,
            ...(this.segmentSizeHint ? { segmentSize: this.segmentSizeHint } : {}),
          },
          signal,
        ),
      );
    }

    const received = new Set(upload.receivedSegments);
    this.emit({
      type: "started",
      localId,
      uploadId: upload.id,
      segmentSize: upload.segmentSize,
      segmentCount: upload.segmentCount,
      receivedBytes:
        upload.status === "ready"
          ? file.size
          : bytesOfSegments(received, file.size, upload.segmentSize),
      receivedSegments: upload.status === "ready" ? upload.segmentCount : received.size,
      resumed,
    });
    return upload;
  }

  /**
   * Send the segments in `todo` with the shared slots. After the first failure
   * no new segment starts, but the ones in flight finish: they are progress the
   * next run does not have to repeat.
   */
  private async sendSegments(entry: Entry, upload: ImportUploadDto, todo: number[]): Promise<void> {
    if (todo.length === 0) {
      return;
    }
    const { signal } = entry.controller;
    const pending = [...todo];
    let firstError: unknown = null;

    const worker = async () => {
      while (firstError === null && !signal.aborted) {
        const index = pending.shift();
        if (index === undefined) {
          return;
        }
        const release = await this.slots.acquire(signal);
        try {
          if (firstError !== null) {
            return;
          }
          await this.putSegment(entry, upload, index, signal);
        } finally {
          release();
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, pending.length) }, () =>
        worker().catch((error: unknown) => {
          if (firstError === null && !(error instanceof UploadAborted)) {
            firstError = error;
          }
        }),
      ),
    );
    if (signal.aborted) {
      throw new UploadAborted();
    }
    if (firstError !== null) {
      throw firstError;
    }
  }

  private async putSegment(
    entry: Entry,
    upload: ImportUploadDto,
    index: number,
    signal: AbortSignal,
  ): Promise<void> {
    const { localId, file } = entry.input;
    const start = index * upload.segmentSize;
    const end = Math.min(file.size, start + upload.segmentSize);
    // One slice per segment; the browser reads it lazily while sending.
    const blob = file.slice(start, end);
    let digest: string | null;
    try {
      digest = await this.hash(blob);
    } catch (error) {
      throw classifyFailure(error, signal);
    }

    await this.retrying(
      entry,
      index,
      async () => {
        const ack = await this.transport.putSegment(upload.id, index, blob, digest, signal);
        if (
          ack.size !== blob.size ||
          (digest && ack.sha256 && ack.sha256.toLowerCase() !== digest)
        ) {
          throw new UploadFailure("corrupt", { retryable: true });
        }
      },
      signal,
    );
    this.emit({ type: "segment", localId, index, bytes: blob.size });
  }

  /** `complete`, sending segments the server reports missing once or twice. */
  private async complete(entry: Entry, upload: ImportUploadDto): Promise<ImportUploadDto> {
    const { localId } = entry.input;
    const { signal } = entry.controller;
    this.emit({ type: "completing", localId });
    for (let round = 0; ; round += 1) {
      try {
        return await this.retrying(entry, -1, () => this.transport.complete(upload.id, signal));
      } catch (error) {
        const failure = classifyFailure(error, signal);
        if (failure instanceof UploadAborted) {
          throw failure;
        }
        if (failure.code !== "conflict" || !failure.missing || round >= 2) {
          throw failure;
        }
        await this.sendSegments(entry, upload, failure.missing);
      }
    }
  }

  /**
   * Run `action`, trying again after a growing pause when the failure is worth
   * it. `index` is the segment being sent, `-1` for calls of the file itself.
   */
  private async retrying<T>(
    entry: Entry,
    index: number,
    action: () => Promise<T>,
    signal: AbortSignal = entry.controller.signal,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await action();
      } catch (error) {
        const failure = classifyFailure(error, signal);
        if (failure instanceof UploadAborted) {
          throw failure;
        }
        if (!failure.retryable || attempt >= this.maxRetries) {
          throw failure;
        }
        const delayMs = this.backoffMs(attempt);
        this.emit({
          type: "retrying",
          localId: entry.input.localId,
          index,
          attempt: attempt + 1,
          delayMs,
        });
        await this.sleep(delayMs, signal);
      }
    }
  }
}

/** Segment indices the server does not hold yet. */
function missingIndices(upload: ImportUploadDto): number[] {
  const received = new Set(upload.receivedSegments);
  const missing: number[] = [];
  for (let index = 0; index < upload.segmentCount; index += 1) {
    if (!received.has(index)) {
      missing.push(index);
    }
  }
  return missing;
}

export type { UploadErrorCode };
