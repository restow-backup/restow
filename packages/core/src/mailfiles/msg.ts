/**
 * Outlook MSG reader (docs/IMPORT.md): reads an MSG file and rebuilds the RFC 5322
 * message from its properties. The conversion itself is in ./msg-convert.ts; this
 * module runs it where it cannot hurt the worker process.
 *
 * An MSG file is hostile input: its compound file structure and the sizes inside it
 * are whatever the sender wrote. The conversion therefore runs in a child process
 * (./isolate.ts) with a heap limit and a wall-clock timeout, and a process that runs
 * over either is killed and reported as an unreadable item, while the parent, its
 * event loop and every other tenant's job carry on. Before the reader parses
 * anything, ./cfb-guard.ts has refused files whose structure no honest writer
 * produces (looping chains, cross-linked sectors, sizes beyond the file).
 */
import { type IsolatedTask, IsolatedTaskError, isolatedTimeoutMs, runIsolated } from "./isolate.js";
import type { MsgReadResult } from "./msg-convert.js";

export type { MsgReadResult } from "./msg-convert.js";

const TASK: IsolatedTask = {
  module: new URL("./msg-convert.js", import.meta.url).href,
  exportName: "convertMsg",
};

/** Generous for an honest file, finite for a bad one (the limit of {@link isolatedTimeoutMs}). */
export function msgParseTimeoutMs(bytes: number): number {
  return isolatedTimeoutMs(bytes);
}

export interface ReadMsgOptions {
  /** Wall-clock limit of the conversion (default: {@link msgParseTimeoutMs}). */
  readonly timeoutMs?: number;
  /** Heap limit of the child process in MiB (default: by the size of the file). */
  readonly heapLimitMb?: number;
  /** Stops the conversion; `readMsg` then rejects with an `AbortError`. */
  readonly signal?: AbortSignal;
  /** Tests only: skip the structure check to show that the child process contains the damage. */
  readonly structureCheck?: boolean;
}

const REASON_DAMAGED = "The MSG file is damaged or incomplete and could not be read.";
const REASON_TIMEOUT =
  "The MSG file could not be read in a reasonable time, it is probably damaged.";
const REASON_MEMORY =
  "The MSG file needs more memory than the import allows, it is probably damaged.";
const REASON_CRASHED =
  "The MSG reader stopped unexpectedly while it read this file, it is probably damaged.";

/**
 * Read an Outlook MSG and rebuild the RFC 5322 message. A file that is damaged, not
 * an Outlook message, or not mail (contact, appointment, task, note) is reported
 * through the result, and so is one that takes too long or too much memory to read, or
 * that stops the reader (it is unreadable). Rejects only with an `AbortError` when
 * `signal` fires, or with an `Error` when no parser process can run at all (an
 * installation problem, not a property of the file).
 */
export async function readMsg(bytes: Buffer, options: ReadMsgOptions = {}): Promise<MsgReadResult> {
  try {
    const result = await runIsolated<MsgReadResult>(TASK, bytes, {
      timeoutMs: options.timeoutMs ?? msgParseTimeoutMs(bytes.length),
      ...(options.heapLimitMb !== undefined ? { heapLimitMb: options.heapLimitMb } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      taskOptions:
        options.structureCheck === undefined
          ? undefined
          : { structureCheck: options.structureCheck },
    });
    if (!result.ok) {
      return result;
    }
    // The result crossed a process boundary: the bytes may arrive as a plain Uint8Array.
    const raw = result.raw as Uint8Array;
    return { ...result, raw: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength) };
  } catch (error) {
    if (error instanceof IsolatedTaskError) {
      switch (error.kind) {
        case "timeout":
          return { ok: false, code: "unreadable", reason: REASON_TIMEOUT };
        case "memory":
          return { ok: false, code: "unreadable", reason: REASON_MEMORY };
        case "crashed":
          return { ok: false, code: "unreadable", reason: REASON_CRASHED };
        case "task":
          return { ok: false, code: "unreadable", reason: REASON_DAMAGED };
        default:
          throw new Error(`The MSG reader could not run: ${error.message}`);
      }
    }
    throw error;
  }
}
