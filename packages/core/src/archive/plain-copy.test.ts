import { afterAll, describe, expect, it } from "vitest";
import { shutdownIsolation } from "../mailfiles/isolate.js";
import { parsePlainCopyIsolated, unparsedPlainCopy } from "./journal-isolated.js";
import {
  deliveredToAddresses,
  headerBlock,
  isJournalReport,
  parsePlainCopy,
} from "./plain-copy.js";

/**
 * Plain copies at the archive receiver: told apart from journal reports by their header,
 * read for the archive (envelope from the headers, delivered-to headers) in process and in
 * the isolated parser processes.
 */

const CRLF = "\r\n";

const COPY = Buffer.from(
  [
    "Delivered-To: archive+abc@archive.example.com",
    "X-Original-To: alice@example.net",
    "Return-Path: <SRS0=x=y@example.org>",
    "From: Bob <bob@example.org>",
    "To: alice@example.net, Carol <carol@example.net>",
    "Cc: dave@example.net",
    "Subject: Plans",
    "Date: Tue, 03 Nov 2026 09:00:00 +0000",
    "Message-ID: <plans-1@example.org>",
    "",
    "See you there.",
  ].join(CRLF),
);

afterAll(async () => {
  await shutdownIsolation();
});

describe("plain copies", () => {
  it("tells journal reports and plain copies apart by the header block only", () => {
    expect(isJournalReport(COPY)).toBe(false);
    const report = Buffer.from(
      `From: journal@contoso.onmicrosoft.com${CRLF}X-MS-Journal-Report:${CRLF}Subject: x${CRLF}${CRLF}body`,
    );
    expect(isJournalReport(report)).toBe(true);
    // A report relayed without the header is recognized by its envelope part.
    const relayed = Buffer.from(
      [
        'Content-Type: multipart/mixed; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain",
        "",
        "Sender: alice@contoso.com",
        "Message-ID: <m@contoso.com>",
        "Recipient: bob@contoso.com",
        "--b1",
        "Content-Type: message/rfc822",
        "",
        "Subject: original",
        "",
        "body",
        "--b1--",
      ].join(CRLF),
    );
    expect(isJournalReport(relayed)).toBe(true);
    // A multipart plain copy is not.
    const multipart = Buffer.from(
      [
        'Content-Type: multipart/alternative; boundary="b2"',
        "",
        "--b2",
        "Content-Type: text/plain",
        "",
        "Hello Bob,",
        "--b2--",
      ].join(CRLF),
    );
    expect(isJournalReport(multipart)).toBe(false);
    // The header named in the body is not a journal report.
    expect(isJournalReport(Buffer.from(`Subject: x${CRLF}${CRLF}X-MS-Journal-Report: no`))).toBe(
      false,
    );
  });

  it("unfolds headers and reads every delivered-to address once", () => {
    const headers = headerBlock(
      Buffer.from(
        `Delivered-To: A@Example.net${CRLF}Envelope-To:${CRLF} b@example.net, a@example.net${CRLF}${CRLF}Delivered-To: body@x`,
      ),
    );
    expect(deliveredToAddresses(headers)).toEqual(["a@example.net", "b@example.net"]);
  });

  it("reads the envelope from the copy's own headers", async () => {
    const parsed = await parsePlainCopy(COPY);
    expect(parsed.messageId).toBe("<plans-1@example.org>");
    expect(parsed.envelope.sender).toBe("bob@example.org");
    expect(parsed.envelope.recipients.map((r) => [r.address, r.type])).toEqual([
      ["alice@example.net", "to"],
      ["carol@example.net", "to"],
      ["dave@example.net", "cc"],
    ]);
    expect(parsed.deliveredTo).toEqual(["archive+abc@archive.example.com", "alice@example.net"]);
    expect(parsed.bodyText).toContain("See you there.");
  });

  it("parses in the isolated processes the same way, the date intact", async () => {
    const parsed = await parsePlainCopyIsolated(COPY);
    expect(parsed.parseLimit).toBeNull();
    expect(parsed.flags).toEqual([]);
    expect(parsed.sentAt).toEqual(new Date("2026-11-03T09:00:00Z"));
    expect(parsed.deliveredTo).toContain("alice@example.net");
  });

  it("archives a copy beyond the limits without details, flagged", () => {
    expect(unparsedPlainCopy("timeout")).toMatchObject({
      flags: ["report-parse-timeout"],
      parseLimit: "timeout",
      unavailable: true,
    });
  });
});
