import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { dumpFileName } from "./dumps.js";
import type { DumpInfo } from "./protocol.js";
import {
  UPLOAD_ID,
  UPLOAD_PART_BYTES,
  type UploadStart,
  type UploadView,
} from "./restore-protocol.js";

/**
 * Dumps uploaded in the setup wizard for a restore (restore.ts), in parts of at most 32 MiB
 * (the edge and the api limit a request body; a large dump needs many requests and can be
 * resumed after a broken connection). An upload is `<dumps>/.upload-<id>.part` with its
 * `.upload-<id>.json` next to it: neither matches the dump name pattern (dumps.ts), so the
 * dump list, its pruning and its downloads never see a part. Completing checks the size and the
 * SHA-256 the browser computed, then renames the part to
 * `restow-<stamp>-uploaded-to-<version>.dump`. Parts left behind are swept after a day.
 */

/** Uploads untouched this long are removed. */
export const STALE_UPLOAD_MS = 24 * 3_600_000;

export class UploadError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_request" | "blocked",
    message: string,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

interface UploadMeta {
  id: string;
  bytes: number;
  sha256: string;
  received: number;
  createdAt: string;
}

export interface DumpUploadsDeps {
  directory: string;
  /** The release the dump is restored into (part of the file name). */
  version: string | null;
  now: () => Date;
  /** Free bytes where the dumps live. */
  freeBytes: (dir: string) => Promise<number>;
}

export class DumpUploads {
  private readonly busy = new Set<string>();

  constructor(private readonly deps: DumpUploadsDeps) {}

  private partOf(id: string): string {
    if (!UPLOAD_ID.test(id)) {
      throw new UploadError("not_found", "There is no such upload.");
    }
    return path.join(this.deps.directory, `.upload-${id}.part`);
  }

  private metaOf(id: string): string {
    return path.join(this.deps.directory, `.upload-${id}.json`);
  }

  private async readMeta(id: string): Promise<UploadMeta> {
    this.partOf(id);
    try {
      return JSON.parse(await fs.readFile(this.metaOf(id), "utf8")) as UploadMeta;
    } catch {
      throw new UploadError("not_found", "There is no such upload.");
    }
  }

  private async writeMeta(meta: UploadMeta): Promise<void> {
    const temporary = `${this.metaOf(meta.id)}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(meta), { mode: 0o600 });
    await fs.rename(temporary, this.metaOf(meta.id));
  }

  /** Begin an upload: the disk must hold the dump about three times (dump, restore, copy). */
  async start(input: UploadStart): Promise<UploadView> {
    await fs.mkdir(this.deps.directory, { recursive: true, mode: 0o700 });
    await this.sweep();
    const free = await this.deps.freeBytes(this.deps.directory);
    if (free < input.bytes * 3) {
      throw new UploadError(
        "blocked",
        `Not enough free disk space for this dump: ${Math.ceil((input.bytes * 3) / 1024 ** 3)} GiB are needed (the dump about three times), ${Math.floor(free / 1024 ** 3)} GiB are free.`,
      );
    }
    const id = randomBytes(16).toString("hex");
    await fs.writeFile(this.partOf(id), "", { mode: 0o600, flag: "wx" });
    const meta: UploadMeta = {
      id,
      bytes: input.bytes,
      sha256: input.sha256,
      received: 0,
      createdAt: this.deps.now().toISOString(),
    };
    await this.writeMeta(meta);
    return { id, bytes: meta.bytes, received: 0 };
  }

  async view(id: string): Promise<UploadView> {
    const meta = await this.readMeta(id);
    return { id, bytes: meta.bytes, received: meta.received };
  }

  /**
   * Append one part at `offset`, which must be where the upload stands (a repeated part after a
   * broken connection is answered with the current state and not written twice).
   */
  async append(
    id: string,
    offset: number,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<UploadView> {
    const part = this.partOf(id);
    if (this.busy.has(id)) {
      throw new UploadError("blocked", "A part of this upload is being written.");
    }
    this.busy.add(id);
    try {
      const meta = await this.readMeta(id);
      if (offset < meta.received) {
        await body?.cancel().catch(() => undefined);
        return { id, bytes: meta.bytes, received: meta.received };
      }
      if (offset !== meta.received) {
        await body?.cancel().catch(() => undefined);
        throw new UploadError(
          "invalid_request",
          `The part starts at ${offset}, the upload stands at ${meta.received}.`,
        );
      }
      const limit = Math.min(UPLOAD_PART_BYTES, meta.bytes - meta.received);
      const chunks: Buffer[] = [];
      let size = 0;
      if (body) {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          size += value.byteLength;
          if (size > limit) {
            await reader.cancel().catch(() => undefined);
            throw new UploadError(
              "invalid_request",
              `A part may have at most ${limit} bytes here.`,
            );
          }
          chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        }
      }
      if (size === 0) {
        throw new UploadError("invalid_request", "The part is empty.");
      }
      // The file is truncated to where the upload stands first: a part cut off half way leaves nothing behind.
      const handle = await fs.open(part, "r+");
      try {
        await handle.truncate(meta.received);
        await handle.write(Buffer.concat(chunks), 0, size, meta.received);
        await handle.sync();
      } finally {
        await handle.close();
      }
      meta.received += size;
      await this.writeMeta(meta);
      return { id, bytes: meta.bytes, received: meta.received };
    } finally {
      this.busy.delete(id);
    }
  }

  /** The whole dump arrived with the right SHA-256: it becomes a dump of the store. */
  async complete(id: string): Promise<DumpInfo> {
    const part = this.partOf(id);
    const meta = await this.readMeta(id);
    if (meta.received !== meta.bytes) {
      throw new UploadError(
        "invalid_request",
        `The upload is incomplete: ${meta.received} of ${meta.bytes} bytes arrived.`,
      );
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(part)) {
      hash.update(chunk as Buffer);
    }
    if (hash.digest("hex") !== meta.sha256) {
      await this.discard(id);
      throw new UploadError(
        "invalid_request",
        "The uploaded file does not match the checksum of the file that was chosen; upload it again.",
      );
    }
    const at = this.deps.now();
    const name = dumpFileName(at, "uploaded", this.deps.version ?? "unknown");
    await fs.rename(part, path.join(this.deps.directory, name));
    await fs.rm(this.metaOf(id), { force: true });
    return { file: name, bytes: meta.bytes, createdAt: at.toISOString() };
  }

  async discard(id: string): Promise<void> {
    await fs.rm(this.partOf(id), { force: true });
    await fs.rm(this.metaOf(id), { force: true });
  }

  /** Remove uploads nobody touched for a day. */
  async sweep(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.deps.directory);
    } catch {
      return [];
    }
    const removed: string[] = [];
    const cutoff = this.deps.now().getTime() - STALE_UPLOAD_MS;
    for (const name of names) {
      const match = /^\.upload-([0-9a-f]{32})\.(part|json|json\.tmp)$/.exec(name);
      if (!match) {
        continue;
      }
      try {
        const stat = await fs.stat(path.join(this.deps.directory, name));
        if (stat.mtimeMs < cutoff) {
          await fs.rm(path.join(this.deps.directory, name), { force: true });
          removed.push(name);
        }
      } catch {
        // Gone meanwhile.
      }
    }
    return removed;
  }
}
