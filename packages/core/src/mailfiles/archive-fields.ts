/**
 * What the archive stores next to an imported message: envelope, subject and the
 * text the full text search reads (the parse is in ./archive-fields-parse.ts, run
 * here in an isolated child process with a time and memory limit, like ./meta.ts).
 */
import { type ArchiveFields, UNAVAILABLE_ARCHIVE_FIELDS } from "./archive-fields-parse.js";
import { type IsolatedTask, IsolatedTaskError, isolatedTimeoutMs, runIsolated } from "./isolate.js";

export { ARCHIVE_BODY_TEXT_LIMIT, type ArchiveFields } from "./archive-fields-parse.js";

const TASK: IsolatedTask = {
  module: new URL("./archive-fields-parse.js", import.meta.url).href,
  exportName: "extractArchiveFieldsInProcess",
};

/**
 * Never throws for the message: whatever cannot be parsed (also in time or in memory) yields
 * empty fields marked `unavailable`; the original bytes are archived regardless. Rejects with an
 * `AbortError` when `signal` fires, and with an `Error` when no parser process can run at all.
 */
export async function extractArchiveFields(
  raw: Buffer,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ArchiveFields> {
  try {
    return await runIsolated<ArchiveFields>(TASK, raw, {
      timeoutMs: options.timeoutMs ?? isolatedTimeoutMs(raw.length),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof IsolatedTaskError) {
      if (error.kind === "unavailable" || error.kind === "busy") {
        throw new Error(`The message parser could not run: ${error.message}`);
      }
      return UNAVAILABLE_ARCHIVE_FIELDS;
    }
    throw error;
  }
}
