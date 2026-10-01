/**
 * EML in a ZIP: one `.eml` per message at its folder path, the bytes exactly as
 * stored, plus `MANIFEST.csv` and `SHA256SUMS`.
 *
 * Messages are streamed through `archiver` one at a time. The SHA-256 of every
 * message is computed while it streams and compared with the recorded value;
 * a mismatch, like a cancellation, ends the whole export (see errors.ts). A
 * message that cannot be opened at all is listed as failed and skipped.
 */
import { Readable } from "node:stream";
import { openVerified } from "./source.js";
import type { ExportMessage, ExportOptions, ExportResult } from "./types.js";
import { runMessageZip } from "./zip-writer.js";

export function createEmlZip(
  messages: AsyncIterable<ExportMessage> | Iterable<ExportMessage>,
  options: ExportOptions = {},
): ExportResult {
  return runMessageZip(messages, options, {
    extension: ".eml",
    async prepare(message, scope) {
      const opened = await openVerified(message, scope);
      const stream = Readable.from(opened.chunks, { objectMode: false });
      scope.track(opened.source, stream);
      return { kind: "stream", source: stream, result: () => opened.result() };
    },
  });
}
