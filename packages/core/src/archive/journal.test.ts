import { describe, expect, it } from "vitest";
import { MAX_ENVELOPE_RECIPIENTS, parseJournalReport } from "./journal.js";

const CRLF = "\r\n";

function buildJournalReport(options: {
  envelopeBody: string | null;
  original: string | null;
}): Buffer {
  const boundary = "RESTOW-TEST-BOUNDARY";
  const parts: string[] = [];
  parts.push(`From: journal@contoso.onmicrosoft.com${CRLF}`);
  parts.push(`To: journal-abc123@archive.example.com${CRLF}`);
  parts.push(`Subject: Journal Report${CRLF}`);
  parts.push(`MIME-Version: 1.0${CRLF}`);
  parts.push(`Content-Type: multipart/mixed; boundary="${boundary}"${CRLF}${CRLF}`);

  if (options.envelopeBody !== null) {
    parts.push(`--${boundary}${CRLF}`);
    parts.push(`Content-Type: text/plain; charset="utf-8"${CRLF}${CRLF}`);
    // Exactly one trailing CRLF: it is the MIME boundary delimiter, not part
    // of the body, so the body content itself stays byte-exact.
    parts.push(`${options.envelopeBody}${CRLF}`);
  }

  if (options.original !== null) {
    parts.push(`--${boundary}${CRLF}`);
    parts.push(`Content-Type: message/rfc822${CRLF}`);
    parts.push(`Content-Disposition: attachment; filename="original.eml"${CRLF}${CRLF}`);
    parts.push(`${options.original}${CRLF}`);
  }

  parts.push(`--${boundary}--${CRLF}`);
  return Buffer.from(parts.join(""), "utf8");
}

const WELL_FORMED_ORIGINAL = [
  "From: alice@contoso.com",
  "To: bob@contoso.com",
  "Cc: carol@contoso.com",
  "Subject: Quarterly numbers",
  "Message-ID: <report-abc@contoso.com>",
  "Date: Sun, 1 Mar 2026 10:15:00 +0000",
  'Content-Type: text/plain; charset="utf-8"',
  "",
  "Here are the numbers.",
].join(CRLF);

// The documented Exchange Online journal envelope: one recipient per line,
// labelled with its own role (docs/IMAP.md: recipients carry To/Cc/Bcc
// labelling). Bcc is named directly, not inferred from the original message.
const WELL_FORMED_ENVELOPE = [
  "Sender: alice@contoso.com",
  "Subject: Quarterly numbers",
  "Message-ID: <report-abc@contoso.com>",
  "To: bob@contoso.com",
  "Cc: carol@contoso.com; Expanded from: sales-team@contoso.com",
  "Bcc: dave@fabrikam.com",
].join(CRLF);

describe("parseJournalReport", () => {
  it("archives a well-formed report with envelope fields and the original message intact", async () => {
    const raw = buildJournalReport({
      envelopeBody: WELL_FORMED_ENVELOPE,
      original: WELL_FORMED_ORIGINAL,
    });
    const result = await parseJournalReport(raw);

    expect(result.flags).toEqual([]);
    expect(result.originalIsRawReport).toBe(false);
    expect(result.envelope.sender).toBe("alice@contoso.com");
    expect(result.envelope.subject).toBe("Quarterly numbers");
    expect(result.envelope.messageId).toBe("<report-abc@contoso.com>");
    // Byte-exact: the extracted original is exactly the attached message, no re-encoding.
    expect(result.original.toString("utf8")).toBe(WELL_FORMED_ORIGINAL);
  });

  it("recovers Bcc directly from an explicit envelope Bcc: line, with no need to compare against the original", async () => {
    const raw = buildJournalReport({
      envelopeBody: WELL_FORMED_ENVELOPE,
      original: WELL_FORMED_ORIGINAL,
    });
    const result = await parseJournalReport(raw);

    const byAddress = new Map(result.envelope.recipients.map((r) => [r.address, r]));
    expect(byAddress.get("bob@contoso.com")?.type).toBe("to");
    expect(byAddress.get("carol@contoso.com")?.type).toBe("cc");
    expect(byAddress.get("carol@contoso.com")?.expandedFrom).toBe("sales-team@contoso.com");
    // Named as Bcc by its own envelope line, not merely absent from To/Cc.
    expect(byAddress.get("dave@fabrikam.com")?.type).toBe("bcc");
  });

  it("recovers Bcc by classification when the report only carries unlabelled Recipient: lines", async () => {
    const envelope = [
      "Sender: alice@contoso.com",
      "Subject: Quarterly numbers",
      "Message-ID: <report-abc@contoso.com>",
      "Recipient: bob@contoso.com",
      "Recipient: carol@contoso.com, Expanded: sales-team@contoso.com",
      "Recipient: dave@fabrikam.com",
    ].join(CRLF);
    const raw = buildJournalReport({ envelopeBody: envelope, original: WELL_FORMED_ORIGINAL });
    const result = await parseJournalReport(raw);

    const byAddress = new Map(result.envelope.recipients.map((r) => [r.address, r]));
    expect(byAddress.get("bob@contoso.com")?.type).toBe("to");
    expect(byAddress.get("carol@contoso.com")?.type).toBe("cc");
    // The comma form of the annotation separator is accepted, same as ';'.
    expect(byAddress.get("carol@contoso.com")?.expandedFrom).toBe("sales-team@contoso.com");
    // Not in To or Cc of the original message: only the envelope reveals it, i.e. Bcc.
    expect(byAddress.get("dave@fabrikam.com")?.type).toBe("bcc");
  });

  it("keeps a labelled recipient's type even when the original message disagrees or is missing", async () => {
    const envelope = [
      "Sender: alice@contoso.com",
      "Subject: Quarterly numbers",
      "Message-ID: <report-abc@contoso.com>",
      "Bcc: dave@fabrikam.com",
    ].join(CRLF);
    const raw = buildJournalReport({ envelopeBody: envelope, original: null });
    const result = await parseJournalReport(raw);

    // The line already named the role directly, so there is nothing left to
    // classify and no original message is needed to trust it.
    expect(result.envelope.recipients).toEqual([{ address: "dave@fabrikam.com", type: "bcc" }]);
    expect(result.flags).not.toContain("recipient-classification-degraded");
  });

  it("parses an On-Behalf-Of envelope line", async () => {
    const envelope = [
      "Sender: assistant@contoso.com",
      "On-Behalf-Of: manager@contoso.com",
      "Subject: Quarterly numbers",
      "Message-ID: <report-abc@contoso.com>",
      "To: bob@contoso.com",
    ].join(CRLF);
    const raw = buildJournalReport({ envelopeBody: envelope, original: WELL_FORMED_ORIGINAL });
    const result = await parseJournalReport(raw);

    expect(result.envelope.onBehalfOf).toBe("manager@contoso.com");
  });

  it("archives a malformed report (no envelope fields, no original attachment) instead of dropping it", async () => {
    const raw = buildJournalReport({
      envelopeBody: "this is not a journal envelope",
      original: null,
    });
    const result = await parseJournalReport(raw);

    expect(result.originalIsRawReport).toBe(true);
    // The whole report is kept, byte-exact, so nothing is lost.
    expect(result.original.equals(raw)).toBe(true);
    expect(result.flags).toContain("envelope-unparseable");
    expect(result.flags).toContain("original-message-missing");
    expect(result.flags).toContain("message-id-missing");
  });

  it("archives a report with an unparseable outer envelope as raw bytes, flagged", async () => {
    const garbage = Buffer.from([0x00, 0xff, 0x10, 0x02, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef]);
    const result = await parseJournalReport(garbage);

    // mailparser is lenient with arbitrary bytes, so this mostly documents
    // that even in the worst case nothing throws and nothing is dropped.
    expect(result.original.length).toBeGreaterThan(0);
    expect(Array.isArray(result.flags)).toBe(true);
  });

  it("flags a report whose original message could not be parsed but still keeps its bytes", async () => {
    const raw = buildJournalReport({
      envelopeBody: WELL_FORMED_ENVELOPE,
      original: "not a valid MIME message at all, just text",
    });
    const result = await parseJournalReport(raw);

    expect(result.originalIsRawReport).toBe(false);
    expect(result.original.toString("utf8")).toBe("not a valid MIME message at all, just text");
    // Every recipient here is labelled (To/Cc/Bcc), so nothing needs
    // classification against a (missing) original, and nothing is degraded.
    expect(result.flags).not.toContain("recipient-classification-degraded");
    expect(result.envelope.recipients.find((r) => r.address === "dave@fabrikam.com")?.type).toBe(
      "bcc",
    );
  });

  it("flags degraded classification when an unlabelled Recipient: line has no original to compare against", async () => {
    const envelope = [
      "Sender: alice@contoso.com",
      "Subject: Quarterly numbers",
      "Message-ID: <report-abc@contoso.com>",
      "Recipient: bob@contoso.com",
    ].join(CRLF);
    const raw = buildJournalReport({
      envelopeBody: envelope,
      original: "not a valid MIME message at all, just text",
    });
    const result = await parseJournalReport(raw);

    expect(result.flags).toContain("recipient-classification-degraded");
    for (const recipient of result.envelope.recipients) {
      expect(recipient.type).toBe("bcc");
    }
  });

  it("keeps the whole raw report when the outer message has no readable envelope body at all", async () => {
    const raw = buildJournalReport({ envelopeBody: null, original: WELL_FORMED_ORIGINAL });
    const result = await parseJournalReport(raw);

    expect(result.flags).toContain("envelope-body-missing");
    // The original was still recoverable even though the envelope text was empty.
    expect(result.originalIsRawReport).toBe(false);
    expect(result.original.toString("utf8")).toBe(WELL_FORMED_ORIGINAL);
  });

  it("keeps at most the recipient limit as details and says that it stopped there", async () => {
    const lines = Array.from(
      { length: MAX_ENVELOPE_RECIPIENTS + 5 },
      (_, index) => `To: user${index}@contoso.com`,
    );
    const raw = buildJournalReport({
      envelopeBody: ["Sender: alice@contoso.com", ...lines, "Subject: After the list"].join(CRLF),
      original: WELL_FORMED_ORIGINAL,
    });
    const result = await parseJournalReport(raw);

    expect(result.envelope.recipients).toHaveLength(MAX_ENVELOPE_RECIPIENTS);
    expect(result.envelope.recipients.at(-1)?.address).toBe(
      `user${MAX_ENVELOPE_RECIPIENTS - 1}@contoso.com`,
    );
    expect(result.flags).toContain("recipients-truncated");
    // Lines after the list are still read; the bytes of the report keep every recipient.
    expect(result.envelope.subject).toBe("After the list");
    expect(result.originalIsRawReport).toBe(false);
  }, 30_000);

  it("takes the details of the original from its headers alone", async () => {
    // Soft line breaks that mailparser decodes in quadratic time: the body is not parsed a second time.
    const slowBody = `${WELL_FORMED_ORIGINAL.replace(
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable",
    )}${"=\r\n=3D".repeat(50_000)}`;
    const raw = buildJournalReport({ envelopeBody: WELL_FORMED_ENVELOPE, original: slowBody });
    const result = await parseJournalReport(raw);

    expect(result.flags).toEqual([]);
    expect(result.envelope.subject).toBe("Quarterly numbers");
    expect(result.original.toString("utf8")).toBe(slowBody);
  }, 30_000);
});
