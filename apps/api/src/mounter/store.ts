import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { Logger } from "../updater/logger.js";
import { writeAtomic } from "../updater/store.js";
import { type Operation, operationSchema } from "./protocol.js";

/**
 * The mounter's operation log: `mounts.json` in its state volume, written atomically
 * after every change. It holds the operations only; the shares themselves live in the
 * compose override (override.ts), which is the source of truth and survives the loss
 * of this file. A file that cannot be read is moved aside and the log starts empty.
 */

export const MOUNTER_STATE_FILE = "mounts.json";
export const MOUNTER_HISTORY_LIMIT = 20;

const stateFileSchema = z.object({
  schemaVersion: z.literal(1),
  operation: operationSchema.nullable(),
  history: z.array(operationSchema).max(MOUNTER_HISTORY_LIMIT),
});
export type MounterStateFile = z.infer<typeof stateFileSchema>;

export interface OperationStore {
  /** The operation that runs, or the last one that finished. */
  current(): Operation | null;
  /** Earlier operations, newest first (without the current one). */
  history(): Operation[];
  /** Replace the current operation (the previous one moves to the history) and persist. */
  begin(operation: Operation): Promise<void>;
  /** Persist a change to the current operation. */
  save(): Promise<void>;
}

export class FileOperationStore implements OperationStore {
  private chain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private doc: MounterStateFile,
  ) {}

  static async open(stateDir: string, logger: Logger): Promise<FileOperationStore> {
    await fs.mkdir(stateDir, { recursive: true });
    const filePath = path.join(stateDir, MOUNTER_STATE_FILE);
    let doc: MounterStateFile = { schemaVersion: 1, operation: null, history: [] };
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = stateFileSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        doc = parsed.data;
      } else {
        throw new Error(parsed.error.issues[0]?.message ?? "invalid");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const aside = `${filePath}.corrupt-${Date.now()}`;
        logger.warn(
          `${MOUNTER_STATE_FILE} could not be read (${(error as Error).message}); moved aside, starting with an empty log.`,
        );
        await fs.rename(filePath, aside).catch(() => undefined);
      }
    }
    return new FileOperationStore(filePath, doc);
  }

  current(): Operation | null {
    return this.doc.operation;
  }

  history(): Operation[] {
    return this.doc.history;
  }

  async begin(operation: Operation): Promise<void> {
    const previous = this.doc.operation;
    if (previous) {
      this.doc.history = [previous, ...this.doc.history].slice(0, MOUNTER_HISTORY_LIMIT);
    }
    this.doc.operation = operation;
    await this.save();
  }

  save(): Promise<void> {
    const payload = `${JSON.stringify(this.doc, null, 2)}\n`;
    const write = this.chain.then(() => writeAtomic(this.filePath, payload));
    this.chain = write.catch(() => undefined);
    return write;
  }
}

/** An in-memory store (tests). */
export class MemoryOperationStore implements OperationStore {
  operation: Operation | null = null;
  earlier: Operation[] = [];
  saves = 0;

  current(): Operation | null {
    return this.operation;
  }

  history(): Operation[] {
    return this.earlier;
  }

  async begin(operation: Operation): Promise<void> {
    if (this.operation) {
      this.earlier = [this.operation, ...this.earlier].slice(0, MOUNTER_HISTORY_LIMIT);
    }
    this.operation = operation;
    this.saves += 1;
  }

  async save(): Promise<void> {
    this.saves += 1;
  }
}
