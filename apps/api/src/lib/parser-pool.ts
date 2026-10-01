import { mailfiles } from "@restow/core";
import { config } from "../config.js";

/**
 * The parser processes of the API (packages/core mailfiles/isolate.ts, one pool per process).
 * Two users share them: the mail preview and attachment download of stored messages
 * (features/snapshots/preview-isolated.ts) and the archive's SMTP journal receiver, which parses
 * the reports it receives there (packages/core archive/journal-isolated.ts). Both read bytes
 * somebody else made; neither may stall or end the process that serves every tenant.
 *
 * `PREVIEW_PARSE_WORKERS` processes run at a time; at most {@link PARSER_MAX_QUEUED} tasks wait
 * for one. A task beyond that is refused at once instead of queued without end: the preview
 * answers 503 "Preview busy", the journal receiver 451 (Exchange Online delivers the report
 * again later).
 */
export const PARSER_MAX_QUEUED = 16;

let configured = false;

/** Apply the API's limits to the pool, once per process; every user calls it before its first task. */
export function configureParserPool(): void {
  if (!configured) {
    configured = true;
    mailfiles.configureIsolation({
      workers: config.preview.workers,
      maxQueued: PARSER_MAX_QUEUED,
    });
  }
}
