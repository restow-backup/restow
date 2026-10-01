/**
 * Metadata of an imported message: envelope fields and body text (the code is in
 * ./meta-parse.ts, which this module runs in an isolated child process).
 *
 * mailparser and the HTML conversion do not run in linear time for every input, and
 * the message is whatever a stranger put into the file: the parse gets a time limit
 * and a memory limit, and a message that runs over either keeps its bytes but gets
 * empty metadata (`unavailable: true`), which the import report counts. The event
 * loop of the worker process never waits for it.
 */
import { type IsolatedTask, IsolatedTaskError, isolatedTimeoutMs, runIsolated } from "./isolate.js";
import { UNAVAILABLE_MESSAGE_META } from "./meta-parse.js";
import type { MessageMeta } from "./types.js";

export {
  EMPTY_MESSAGE_META,
  MAX_BODY_TEXT_CHARS,
  UNAVAILABLE_MESSAGE_META,
} from "./meta-parse.js";
export { HTML_TEXT_DEFAULT_LIMIT, htmlToPlainText } from "./html-text.js";

const TASK: IsolatedTask = {
  module: new URL("./meta-parse.js", import.meta.url).href,
  exportName: "parseMessageMetaInProcess",
};

export interface ParseMetaOptions {
  readonly signal?: AbortSignal;
  /** Wall-clock limit (default: {@link isolatedTimeoutMs} of the message size). */
  readonly timeoutMs?: number;
  /** Heap limit of the child process in MiB (default: by the size of the message). */
  readonly heapLimitMb?: number;
}

/**
 * Parse the metadata of RFC 5322 bytes. Never throws for the message: whatever cannot be
 * parsed (also in time or in memory, or because the parser process died on it) yields empty
 * metadata marked `unavailable`. Rejects with an `AbortError` when `signal` fires, and with an
 * `Error` when no parser process can run at all (an installation problem).
 */
export async function parseMessageMeta(
  raw: Buffer,
  options: ParseMetaOptions = {},
): Promise<MessageMeta> {
  try {
    return await runIsolated<MessageMeta>(TASK, raw, {
      timeoutMs: options.timeoutMs ?? isolatedTimeoutMs(raw.length),
      ...(options.heapLimitMb !== undefined ? { heapLimitMb: options.heapLimitMb } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof IsolatedTaskError) {
      if (error.kind === "unavailable" || error.kind === "busy") {
        throw new Error(`The message parser could not run: ${error.message}`);
      }
      return UNAVAILABLE_MESSAGE_META;
    }
    throw error;
  }
}
