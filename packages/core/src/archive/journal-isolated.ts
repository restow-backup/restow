/**
 * Journal reports parsed where they cannot hurt the process that receives them
 * (docs/ARCHIVE.md, "Lesen der Reports"): the code of ./journal.ts runs in the
 * isolated child processes of ../mailfiles/isolate.ts, with a heap limit and a
 * wall-clock limit that kills the process, at most as many at a time as the
 * pool allows and with the pool's bounded queue.
 *
 * A journal report is mail from the outside world, up to the receiver's size
 * limit (150 MB by default), and mailparser is not linear for every input: a
 * quoted-printable body of soft line breaks or deeply nested HTML takes it
 * minutes, and an allocation that crosses a heap limit aborts the process it
 * happens in. On the event loop of the API that would stall or end every
 * request and every other delivery. In a child process it costs one delivery.
 *
 * What happens to a report that cannot be parsed within the limits decides
 * whether journal mail stays safe. Answering 4xx would make Exchange Online
 * retry the same report until it gives up (and then only a non-delivery report
 * to the operator's mailbox is left), because the report itself is the
 * problem. So such a report is archived anyway, byte for byte as received,
 * without the details the parser would have extracted, and flagged with the
 * reason (`report-parse-timeout`, `report-parse-memory-limit`, or
 * `report-unparseable` when the parser threw or its process crashed): the same
 * contract as a report mailparser rejects (./journal.ts). Only when no process
 * can take the report now does the caller get an error, before anything is
 * stored: {@link JournalParserBusyError} for a full queue, a plain `Error` when
 * no parser process could be started at all (an installation problem, never
 * the report's doing). The receiver answers both with 451, so Exchange
 * delivers the report again later.
 */
import {
  type IsolatedTask,
  IsolatedTaskError,
  isolatedTimeoutMs,
  runIsolated,
} from "../mailfiles/isolate.js";
import type { JournalFlag, JournalReportTransfer, ParsedJournalReport } from "./journal.js";

const TASK: IsolatedTask = {
  module: new URL("./journal.js", import.meta.url).href,
  exportName: "parseJournalReportTask",
};

/** Why a report was archived without its details. */
export type JournalParseLimit =
  /** The parse ran over its time limit; the process was killed. */
  | "timeout"
  /** The parse ran over its heap limit (or the operating system's); the process died. */
  | "memory"
  /** The parser threw outside its own handling, or its process crashed. */
  | "failed";

const LIMIT_FLAGS: Readonly<Record<JournalParseLimit, JournalFlag>> = {
  timeout: "report-parse-timeout",
  memory: "report-parse-memory-limit",
  failed: "report-unparseable",
};

export interface IsolatedJournalReport extends ParsedJournalReport {
  /** Why the report was archived as received without its details; null when it was parsed. */
  readonly parseLimit: JournalParseLimit | null;
}

export interface ParseJournalReportIsolatedOptions {
  /** Wall-clock limit of the parse (default: {@link isolatedTimeoutMs} of the report size). */
  readonly timeoutMs?: number;
  /** Heap limit of a process of its own, in MiB (default: by the size of the report). */
  readonly heapLimitMb?: number;
  readonly signal?: AbortSignal;
}

/** Every parser process is busy and the queue is full: try again later (SMTP 451). */
export class JournalParserBusyError extends Error {
  constructor() {
    super("all parser processes are busy and the queue is full");
    this.name = "JournalParserBusyError";
  }
}

/** The report as received, flagged with why it carries no details. */
export function unparsedJournalReport(
  rawReportBytes: Buffer,
  limit: JournalParseLimit,
): IsolatedJournalReport {
  return {
    envelope: { sender: null, subject: null, messageId: null, onBehalfOf: null, recipients: [] },
    original: rawReportBytes,
    originalIsRawReport: true,
    flags: [LIMIT_FLAGS[limit], "original-message-missing"],
    parseLimit: limit,
  };
}

/** A Uint8Array that crossed the process boundary, as a Buffer over the same bytes. */
function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * parseJournalReport of ./journal.ts in an isolated child process. Never loses
 * a report because of its content: one that cannot be parsed within the limits
 * comes back as received, flagged (`parseLimit` says why). Rejects, with
 * nothing parsed, with {@link JournalParserBusyError} when the queue is full,
 * with an `Error` when no parser process can be started, and with an
 * `AbortError` when `signal` fires.
 */
export async function parseJournalReportIsolated(
  rawReportBytes: Buffer,
  options: ParseJournalReportIsolatedOptions = {},
): Promise<IsolatedJournalReport> {
  let transfer: JournalReportTransfer;
  try {
    transfer = await runIsolated<JournalReportTransfer>(TASK, rawReportBytes, {
      timeoutMs: options.timeoutMs ?? isolatedTimeoutMs(rawReportBytes.length),
      ...(options.heapLimitMb !== undefined ? { heapLimitMb: options.heapLimitMb } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (!(error instanceof IsolatedTaskError)) {
      throw error;
    }
    switch (error.kind) {
      case "busy":
        throw new JournalParserBusyError();
      case "unavailable":
        throw new Error(`The journal parser could not run: ${error.message}`);
      case "timeout":
        return unparsedJournalReport(rawReportBytes, "timeout");
      case "memory":
        return unparsedJournalReport(rawReportBytes, "memory");
      default:
        return unparsedJournalReport(rawReportBytes, "failed");
    }
  }
  // The raw report never went back: the caller's bytes are the original then.
  return {
    envelope: transfer.envelope,
    original: transfer.original === null ? rawReportBytes : asBuffer(transfer.original),
    originalIsRawReport: transfer.originalIsRawReport,
    flags: transfer.flags,
    parseLimit: null,
  };
}
