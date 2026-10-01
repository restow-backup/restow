import { describe, expect, it } from "vitest";
import { buildEmlMessage } from "./mime.js";

const BASE = {
  from: { name: "Info", email: "info@example.org" },
  to: { name: "Anna Muster", email: "anna.muster@example.com" },
  subject: "Rechnung RE-2024-0001",
  date: new Date("2024-05-01T10:00:00.000Z"),
  textBody: "Hallo,\n\nanbei die Rechnung.\n\nGrüße",
  messageId: "msg-1@restow-demo.example.org",
};

describe("buildEmlMessage", () => {
  it("writes a plain-text message with CRLF line endings and no attachments", () => {
    const eml = buildEmlMessage(BASE);
    expect(eml).toContain("\r\n");
    expect(eml).toMatch(/^From: Info <info@example\.org>\r\n/);
    expect(eml).toContain("To: Anna Muster <anna.muster@example.com>");
    expect(eml).toContain('Content-Type: text/plain; charset="utf-8"');
    expect(eml).toContain("Grüße");
    expect(eml).not.toContain("multipart/mixed");
  });

  it("encodes a non-ASCII subject as RFC 2047", () => {
    const eml = buildEmlMessage({ ...BASE, subject: "Rückfrage zu Bestellung" });
    expect(eml).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
  });

  it("leaves an ASCII subject untouched", () => {
    const eml = buildEmlMessage({ ...BASE, subject: "Invoice reminder" });
    expect(eml).toContain("Subject: Invoice reminder");
  });

  it("builds a multipart/mixed message when attachments are present, each base64 and wrapped at 76 octets", () => {
    const eml = buildEmlMessage({
      ...BASE,
      attachments: [
        { filename: "invoice.pdf", contentType: "application/pdf", content: Buffer.alloc(200, 65) },
        { filename: "invite.ics", contentType: "text/calendar", content: "BEGIN:VCALENDAR\r\n" },
      ],
    });
    expect(eml).toMatch(/Content-Type: multipart\/mixed; boundary="[^"]+"/);
    expect(eml).toContain('Content-Disposition: attachment; filename="invoice.pdf"');
    expect(eml).toContain('Content-Disposition: attachment; filename="invite.ics"');
    const base64Lines = eml
      .split("\r\n")
      .filter((line) => /^[A-Za-z0-9+/=]{20,}$/.test(line) && !line.includes(" "));
    for (const line of base64Lines) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    // The message ends with the closing boundary.
    const boundary = /boundary="([^"]+)"/.exec(eml)?.[1];
    expect(eml.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
  });

  it("round-trips a binary attachment through base64", () => {
    const original = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const eml = buildEmlMessage({
      ...BASE,
      attachments: [
        { filename: "data.bin", contentType: "application/octet-stream", content: original },
      ],
    });
    const match =
      /Content-Disposition: attachment; filename="data\.bin"\r\n\r\n([\s\S]*?)\r\n--/.exec(eml);
    expect(match).not.toBeNull();
    const decoded = Buffer.from((match?.[1] ?? "").replace(/\r\n/g, ""), "base64");
    expect(decoded).toEqual(original);
  });

  it("is deterministic for the same input", () => {
    expect(buildEmlMessage(BASE)).toBe(buildEmlMessage(BASE));
  });
});
