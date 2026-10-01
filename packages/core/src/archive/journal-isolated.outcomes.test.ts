import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What ./journal-isolated.ts makes of each way a parser process can fail
 * (../mailfiles/isolate.ts): the outcomes that are the report's doing archive
 * it as received with the reason as its flag; the ones that are not (a full
 * queue, no process at all) refuse it before anything is stored, so the
 * receiver answers 451 and Exchange delivers again. The pool is replaced at
 * its module boundary; ./journal-isolated.test.ts runs the real one.
 */

const runIsolated = vi.hoisted(() => vi.fn());
vi.mock("../mailfiles/isolate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mailfiles/isolate.js")>()),
  runIsolated,
}));

const { IsolatedTaskError } = await import("../mailfiles/isolate.js");
const { JournalParserBusyError, parseJournalReportIsolated } = await import(
  "./journal-isolated.js"
);

const RAW = Buffer.from("From: journal@contoso.example\r\n\r\nreport");

beforeEach(() => {
  runIsolated.mockReset();
});

describe("a parser process that did not return a value", () => {
  for (const [kind, flag, limit] of [
    ["timeout", "report-parse-timeout", "timeout"],
    ["memory", "report-parse-memory-limit", "memory"],
    ["crashed", "report-unparseable", "failed"],
    ["task", "report-unparseable", "failed"],
  ] as const) {
    it(`${kind}: archives the report as received, flagged ${flag}`, async () => {
      runIsolated.mockRejectedValue(new IsolatedTaskError(kind, "the parser gave up"));
      const report = await parseJournalReportIsolated(RAW);
      expect(report).toMatchObject({
        parseLimit: limit,
        flags: [flag, "original-message-missing"],
        originalIsRawReport: true,
        envelope: { sender: null, subject: null, messageId: null, recipients: [] },
      });
      expect(report.original).toBe(RAW);
    });
  }

  it("busy: refuses with JournalParserBusyError, nothing parsed", async () => {
    runIsolated.mockRejectedValue(new IsolatedTaskError("busy", "queue full"));
    await expect(parseJournalReportIsolated(RAW)).rejects.toBeInstanceOf(JournalParserBusyError);
  });

  it("unavailable: refuses with an error that is not the report's doing", async () => {
    runIsolated.mockRejectedValue(
      new IsolatedTaskError("unavailable", "the parser process did not start"),
    );
    const failure = await parseJournalReportIsolated(RAW).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(JournalParserBusyError);
    expect((failure as Error).message).toContain("could not run");
  });

  it("an abort is passed on as it is", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    runIsolated.mockRejectedValue(abort);
    await expect(parseJournalReportIsolated(RAW)).rejects.toBe(abort);
  });
});

describe("a parser process that returned", () => {
  it("turns the original that crossed the process boundary back into a Buffer", async () => {
    const original = new Uint8Array(Buffer.from("From: a@contoso.example\r\n\r\nbody"));
    runIsolated.mockResolvedValue({
      envelope: {
        sender: "a@contoso.example",
        subject: null,
        messageId: null,
        onBehalfOf: null,
        recipients: [],
      },
      original,
      originalIsRawReport: false,
      flags: [],
    });
    const report = await parseJournalReportIsolated(RAW);
    expect(report.parseLimit).toBeNull();
    expect(Buffer.isBuffer(report.original)).toBe(true);
    expect(report.original.toString()).toBe("From: a@contoso.example\r\n\r\nbody");
  });
});
