import type { Readable } from "node:stream";
import type { HeadResult, PutOptions, StorageBackend } from "../backend.js";

/** An error as a write-once NFS share answers it (EPERM, "Operation not permitted"). */
export function writeOnceRefusal(syscall: string, key: string): NodeJS.ErrnoException {
  const error = new Error(
    `EPERM: operation not permitted, ${syscall} '${key}'`,
  ) as NodeJS.ErrnoException;
  error.code = "EPERM";
  error.errno = -1;
  error.syscall = syscall;
  return error;
}

/**
 * A write-once (WORM) storage for tests (docs/STORAGE.md, "Write-once storage"): new keys are
 * written, an existing key is never overwritten (a rename over it, EPERM) nor deleted (EPERM).
 * Deleting a key that does not exist succeeds, as it does everywhere.
 */
export class WriteOnceBackend implements StorageBackend {
  /** Every refused delete or overwrite, in order. */
  readonly refused: { readonly op: "delete" | "overwrite"; readonly key: string }[] = [];

  constructor(private readonly inner: StorageBackend) {}

  async put(key: string, data: Buffer | Readable, options?: PutOptions): Promise<void> {
    if ((await this.inner.head(key)) !== null) {
      if (!Buffer.isBuffer(data)) {
        data.destroy();
      }
      this.refused.push({ op: "overwrite", key });
      throw writeOnceRefusal("rename", key);
    }
    await this.inner.put(key, data, options);
  }

  get(key: string): Promise<Buffer> {
    return this.inner.get(key);
  }

  getStream(key: string): Promise<Readable> {
    return this.inner.getStream(key);
  }

  head(key: string): Promise<HeadResult | null> {
    return this.inner.head(key);
  }

  list(prefix: string): Promise<string[]> {
    return this.inner.list(prefix);
  }

  async delete(key: string): Promise<void> {
    if ((await this.inner.head(key)) === null) {
      return;
    }
    this.refused.push({ op: "delete", key });
    throw writeOnceRefusal("unlink", key);
  }
}
