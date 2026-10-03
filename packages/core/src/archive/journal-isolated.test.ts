import { afterAll, describe, expect, it } from "vitest";
import { configureIsolation, shutdownIsolation } from "../mailfiles/isolate.js";
import {
  JournalParserBusyError,
  parseJournalReportIsolated,
  unparsedJournalReport,
} from "./journal-isolated.js";
import { parseJournalReport } from "./journal.js";

/**
 * The journal report parser in its isolated child process
 * (./journal-isolated.ts): an honest report reads exactly as in process, a
 * hostile one costs its own process and comes back as received, flagged, while
 * the caller's event loop keeps running; a full queue is the only refusal.
 */

const CRLF = "\r\n";
const BOUNDARY = "RESTOW-ISOLATED-BOUNDARY";

const ORIGINAL = [
  "From: alice@contoso.com",
  "To: bob@contoso.com",
  "Subject: Quarterly numbers",
  "Message-ID: <report-abc@contoso.com>",
  'Content-Type: text/plain; charset="utf-8"',
  "",
  "Here are the numbers.",
].join(CRLF);
const ORIGINAL_BYTES = Buffer.from(ORIGINAL);

function report(envelopePart: string, original: string | null = ORIGINAL): Buffer {
  const parts = [
    `From: journal@contoso.onmicrosoft.com${CRLF}`,
    `Subject: Journal Report${CRLF}`,
    `MIME-Version: 1.0${CRLF}`,
    `Content-Type: multipart/mixed; boundary="${BOUNDARY}"${CRLF}${CRLF}`,
    `--${BOUNDARY}${CRLF}`,
    envelopePart,
  ];
  if (original !== null) {
    parts.push(
      `--${BOUNDARY}${CRLF}`,
      `Content-Type: message/rfc822${CRLF}${CRLF}`,
      `${original}${CRLF}`,
    );
  }
  parts.push(`--${BOUNDARY}--${CRLF}`);
  return Buffer.from(parts.join(""), "utf8");
}

const HONEST = report(
  `Content-Type: text/plain; charset="utf-8"${CRLF}${CRLF}${[
    "Sender: alice@contoso.com",
    "Subject: Quarterly numbers",
    "Message-ID: <report-abc@contoso.com>",
    "To: bob@contoso.com",
    "Bcc: dave@fabrikam.com",
  ].join(CRLF)}${CRLF}`,
);

/**
 * A hostile report: its envelope text is 24 MB of quoted-printable made of soft
 * line breaks. mailparser up to 3.9.28 decoded this in time that grew with the
 * square of the body (the class of input fixed for imports and previews in
 * 0.1.1); later versions decode it in linear time, but still far slower than
 * the short limits below, so it always runs over them.
 */
const HOSTILE = report(
  `Content-Type: text/plain${CRLF}Content-Transfer-Encoding: quoted-printable${CRLF}${CRLF}${"=\r\n=3D".repeat(4_000_000)}${CRLF}`,
);

afterAll(async () => {
  await shutdownIsolation();
});

/** Counts timer ticks while `run` is pending: proof that the caller's event loop kept going. */
async function ticking<T>(run: () => Promise<T>): Promise<{ value: T; ticks: number; ms: number }> {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const started = Date.now();
  try {
    const value = await run();
    return { value, ticks, ms: Date.now() - started };
  } finally {
    clearInterval(timer);
  }
}

describe("parseJournalReportIsolated", { timeout: 120_000 }, () => {
  it("reads an honest report exactly as the parser does in process", async () => {
    const isolated = await parseJournalReportIsolated(HONEST);
    const inProcess = await parseJournalReport(HONEST);
    expect(isolated.parseLimit).toBeNull();
    expect(isolated.envelope).toEqual(inProcess.envelope);
    expect(isolated.flags).toEqual(inProcess.flags);
    expect(isolated.originalIsRawReport).toBe(false);
    expect(Buffer.isBuffer(isolated.original)).toBe(true);
    expect(isolated.original.equals(inProcess.original)).toBe(true);
    expect(isolated.envelope.recipients).toContainEqual({
      address: "dave@fabrikam.com",
      type: "bcc",
    });
  });

  it("hands back the raw report itself when there is no original to extract", async () => {
    const raw = report(`Content-Type: text/plain${CRLF}${CRLF}Sender: a@contoso.com${CRLF}`, null);
    const isolated = await parseJournalReportIsolated(raw);
    expect(isolated.parseLimit).toBeNull();
    expect(isolated.originalIsRawReport).toBe(true);
    expect(isolated.original).toBe(raw);
    expect(isolated.flags).toContain("original-message-missing");
  });

  it("archives a hostile report as received when its parse runs over the time limit, and the caller's event loop never waits", async () => {
    const {
      value: isolated,
      ticks,
      ms,
    } = await ticking(() => parseJournalReportIsolated(HOSTILE, { timeoutMs: 500 }));
    expect(isolated.parseLimit).toBe("timeout");
    expect(isolated.flags).toEqual(["report-parse-timeout", "original-message-missing"]);
    expect(isolated.originalIsRawReport).toBe(true);
    // Byte for byte what arrived, nothing extracted from it.
    expect(isolated.original.equals(HOSTILE)).toBe(true);
    expect(isolated.envelope).toEqual({
      sender: null,
      subject: null,
      messageId: null,
      onBehalfOf: null,
      recipients: [],
    });
    expect(ms).toBeLessThan(60_000);
    expect(ticks).toBeGreaterThan(10);
    // The next report is read as usual.
    expect((await parseJournalReportIsolated(HONEST)).parseLimit).toBeNull();
  });

  it("reads a 30 MB report built to inflate the parser's memory, without stalling the caller", async () => {
    // 30 MB of `<`: mailparser's HTML rendering of the text, which the journal never uses, took
    // a gigabyte of heap for it, and a large allocation past a heap limit aborts the process.
    const inflating = report(
      `Content-Type: text/plain${CRLF}${CRLF}${"<".repeat(30 * 1024 * 1024)}${CRLF}`,
    );
    const { value: isolated, ticks } = await ticking(() => parseJournalReportIsolated(inflating));
    expect(isolated.parseLimit).toBeNull();
    expect(isolated.flags).toContain("envelope-unparseable");
    expect(isolated.original.equals(ORIGINAL_BYTES)).toBe(true);
    expect(ticks).toBeGreaterThan(0);
  });

  it("refuses a report only when no process can take it now, before anything is parsed", async () => {
    configureIsolation({ workers: 1, maxQueued: 0 });
    try {
      // A limit the timeout test above already proves too short for HOSTILE, long enough that
      // the first report is still running (and then times out) when the second one arrives.
      const running = parseJournalReportIsolated(HOSTILE, { timeoutMs: 300 });
      const refused = await parseJournalReportIsolated(HONEST).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(JournalParserBusyError);
      expect((await running).parseLimit).toBe("timeout");
      // Once the process is free again, reports are accepted.
      expect((await parseJournalReportIsolated(HONEST)).parseLimit).toBeNull();
    } finally {
      configureIsolation({ workers: 2, maxQueued: Number.POSITIVE_INFINITY });
    }
  });
});

describe("unparsedJournalReport", () => {
  it("names the reason in the flags and keeps the bytes", () => {
    const raw = Buffer.from("anything");
    expect(unparsedJournalReport(raw, "failed")).toMatchObject({
      original: raw,
      originalIsRawReport: true,
      flags: ["report-unparseable", "original-message-missing"],
      parseLimit: "failed",
    });
    expect(unparsedJournalReport(raw, "memory").flags[0]).toBe("report-parse-memory-limit");
  });
});
