import { mailfiles } from "@restow/core";
import { config } from "../../config.js";
import { PARSER_MAX_QUEUED, configureParserPool } from "../../lib/parser-pool.js";
import type { FoundAttachment, MailPreviewDto, PreviewMode } from "./preview.js";

/**
 * The mail preview and the attachment download for stored messages, run where they cannot hurt
 * the API process: in a child process with a heap limit and a wall-clock limit that kills the
 * process (packages/core/src/mailfiles/isolate.ts, the same pool the import uses, in the API
 * shared with the journal receiver through lib/parser-pool.ts; a worker thread would not do, one
 * large allocation past its heap limit aborts the whole process), a small number of processes at
 * a time and a bounded queue, so a hostile message or a burst of
 * previews costs one request, not the event loop and the memory of every tenant's session.
 *
 * What a caller sees:
 *   - a message that runs over its time or memory is first tried once more as plain text (the
 *     linear HTML converter instead of the sanitiser, `simplified: true`); only when that fails
 *     as well does {@link PreviewUnreadableError} say the message cannot be shown;
 *   - {@link PreviewBusyError} when more requests are waiting than the queue allows;
 *   - an attachment that cannot be extracted in time is a {@link PreviewUnreadableError} too.
 */

/**
 * Time for the full view is `PREVIEW_TIMEOUT_MS` (default 10 s: generous for an honest message of
 * the size cap, finite for a bad one); the plain-text fallback, which skips the sanitiser and the
 * inline images, gets half of it.
 */
/** Previews (and journal reports, lib/parser-pool.ts) that may wait for a process; more are refused as busy. */
export const PREVIEW_MAX_QUEUED = PARSER_MAX_QUEUED;

/** The message could not be parsed in the time and memory the preview allows (or the parser gave up on it). */
export class PreviewUnreadableError extends Error {
  constructor(
    readonly kind: "timeout" | "memory" | "crashed" | "damaged",
    message: string,
  ) {
    super(message);
    this.name = "PreviewUnreadableError";
  }
}

/** Every preview process is busy and the queue is full. */
export class PreviewBusyError extends Error {
  constructor() {
    super("all preview processes are busy and the queue is full");
    this.name = "PreviewBusyError";
  }
}

const PREVIEW_MODULE = new URL("./preview.js", import.meta.url).href;
/** This file runs from its TypeScript source (tests): the process has to load the task's source as well. */
const FROM_SOURCE = import.meta.url.endsWith(".ts");
const PREVIEW_TASK = {
  module: PREVIEW_MODULE,
  exportName: "buildPreviewTask",
  typescript: FROM_SOURCE,
} as const;
const ATTACHMENT_TASK = {
  module: PREVIEW_MODULE,
  exportName: "findAttachmentTask",
  typescript: FROM_SOURCE,
} as const;

/** Failure kinds that mean "this message is the problem", as opposed to "the installation is". */
function explain(error: unknown): PreviewUnreadableError | PreviewBusyError | null {
  if (error instanceof mailfiles.IsolatedTaskError) {
    switch (error.kind) {
      case "timeout":
        return new PreviewUnreadableError("timeout", error.message);
      case "memory":
        return new PreviewUnreadableError("memory", error.message);
      case "crashed":
        return new PreviewUnreadableError("crashed", error.message);
      case "task":
        return new PreviewUnreadableError("damaged", error.message);
      case "busy":
        return new PreviewBusyError();
      default:
        return null;
    }
  }
  return null;
}

function runPreview(
  bytes: Buffer,
  mode: PreviewMode,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<MailPreviewDto> {
  return mailfiles.runIsolated<MailPreviewDto>(PREVIEW_TASK, bytes, {
    timeoutMs,
    taskOptions: { mode },
    ...(signal ? { signal } : {}),
  });
}

export interface PreviewInWorkerOptions {
  readonly signal?: AbortSignal;
  /** Wall-clock limit of the formatted view (default `config.preview.timeoutMs`). */
  readonly timeoutMs?: number;
  /**
   * Wall-clock limit of the plain-text retry that follows a formatted view that ran over its time
   * or memory (default: half of `timeoutMs`). The process that ran over its limit was killed, so
   * the retry often starts a process of its own: a caller that needs the retry to be independent
   * of the speed of the machine (a test) gives it its own, generous budget.
   */
  readonly textTimeoutMs?: number;
}

/**
 * The preview of one message's bytes. Resolves with a previewable DTO (formatted, or plain text
 * with `simplified` when the formatted view ran over its limits) or a not-previewable one for
 * protected mail; rejects with {@link PreviewUnreadableError} or {@link PreviewBusyError}.
 */
export async function previewInWorker(
  bytes: Buffer,
  options: PreviewInWorkerOptions = {},
): Promise<MailPreviewDto> {
  configureParserPool();
  const timeoutMs = options.timeoutMs ?? config.preview.timeoutMs;
  try {
    return await runPreview(bytes, "full", timeoutMs, options.signal);
  } catch (error) {
    const first = explain(error);
    if (first === null) {
      throw error;
    }
    if (first instanceof PreviewBusyError || first.kind === "damaged") {
      throw first;
    }
    // Over its limits: the text of the message is still worth showing.
    try {
      return await runPreview(
        bytes,
        "text",
        options.textTimeoutMs ?? Math.max(1, Math.floor(timeoutMs / 2)),
        options.signal,
      );
    } catch (second) {
      throw explain(second) ?? second;
    }
  }
}

/** One attachment of a message by the id its preview listed it under; null when there is none. */
export async function findAttachmentInWorker(
  bytes: Buffer,
  attachmentId: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<FoundAttachment | null> {
  configureParserPool();
  try {
    const found = await mailfiles.runIsolated<FoundAttachment | null>(ATTACHMENT_TASK, bytes, {
      timeoutMs: options.timeoutMs ?? config.preview.timeoutMs,
      taskOptions: { attachmentId },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (found === null) {
      return null;
    }
    // The content crossed a process boundary: a plain Uint8Array becomes a Buffer again.
    const content = found.content as Uint8Array;
    return {
      ...found,
      content: Buffer.from(content.buffer, content.byteOffset, content.byteLength),
    };
  } catch (error) {
    throw explain(error) ?? error;
  }
}
