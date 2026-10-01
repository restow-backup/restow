import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import {
  encodeHeaderText,
  filePart,
  formatMailbox,
  headerSafe,
  messagePart,
  mimeTypeForFile,
  multipart,
  parameterizedValue,
  serializeMessage,
  textPart,
} from "./mime-writer.js";

describe("header helpers", () => {
  it("removes line breaks and control characters", () => {
    expect(headerSafe("a\r\nBcc: x@example.test")).toBe("a Bcc: x@example.test");
    expect(headerSafe("a\u0000b\u0007c")).toBe("abc");
  });

  it("leaves ASCII text alone and encodes the rest as short RFC 2047 words", () => {
    expect(encodeHeaderText("Plain subject")).toBe("Plain subject");
    const encoded = encodeHeaderText("Grüße aus Köln – テスト ".repeat(6));
    for (const word of encoded.split(" ")) {
      expect(word.length).toBeLessThanOrEqual(75);
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    }
  });

  it("formats mailboxes", () => {
    expect(formatMailbox("Alice", "alice@example.test")).toBe("Alice <alice@example.test>");
    expect(formatMailbox(null, "alice@example.test")).toBe("alice@example.test");
    expect(formatMailbox("alice@example.test", "alice@example.test")).toBe("alice@example.test");
    expect(formatMailbox("Flores, Lucas", "l@example.test")).toBe(
      '"Flores, Lucas" <l@example.test>',
    );
    expect(formatMailbox('Q "the" Q', "q@example.test")).toBe('"Q \\"the\\" Q" <q@example.test>');
    expect(formatMailbox("Nur Name", "")).toBe("Nur Name <>");
    expect(formatMailbox("", "")).toBe("<>");
    expect(formatMailbox("Zoë", "z@example.test")).toMatch(
      /^=\?UTF-8\?B\?.+\?= <z@example\.test>$/,
    );
  });

  it("writes parameters, using RFC 2231 for non-ASCII names", () => {
    expect(parameterizedValue("attachment", { filename: "plain name.pdf" })).toBe(
      'attachment; filename="plain name.pdf"',
    );
    expect(parameterizedValue("attachment", { filename: "Köln.pdf" })).toBe(
      "attachment; filename*=utf-8''K%C3%B6ln.pdf",
    );
    expect(parameterizedValue("attachment", { filename: "" })).toBe("attachment");
    expect(parameterizedValue("attachment", { filename: null })).toBe("attachment");
    expect(parameterizedValue("attachment", { filename: 'a"b;c' })).not.toContain("\r");
  });

  it("guesses a MIME type from a file name", () => {
    expect(mimeTypeForFile("report.PDF")).toBe("application/pdf");
    expect(mimeTypeForFile("noextension")).toBe("application/octet-stream");
    expect(mimeTypeForFile("archive.unknownext")).toBe("application/octet-stream");
  });
});

describe("parts and messages", () => {
  it("chooses 7bit for plain text and quoted-printable for the rest, always with CRLF", () => {
    const ascii = textPart("plain", "one\ntwo\rthree\r\nfour");
    expect(ascii.headers).toContainEqual(["Content-Transfer-Encoding", "7bit"]);
    expect(ascii.body.toString()).toBe("one\r\ntwo\r\nthree\r\nfour");
    const umlaut = textPart("plain", "Grüße");
    expect(umlaut.headers).toContainEqual(["Content-Transfer-Encoding", "quoted-printable"]);
    expect(umlaut.body.toString()).toBe("Gr=C3=BC=C3=9Fe");
    const long = textPart("html", `${"x".repeat(2000)}`);
    expect(long.headers).toContainEqual(["Content-Transfer-Encoding", "quoted-printable"]);
    for (const line of long.body.toString().split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    expect(textPart("plain", "a\u0000b").headers).toContainEqual([
      "Content-Transfer-Encoding",
      "quoted-printable",
    ]);
  });

  it("is deterministic: the same input gives the same bytes and boundary", () => {
    const build = () =>
      serializeMessage(
        [["Subject", "x"]],
        multipart("mixed", [
          textPart("plain", "hello"),
          filePart({
            contentType: "text/csv",
            fileName: "a.csv",
            disposition: "attachment",
            data: Buffer.from("1,2"),
          }),
        ]),
      );
    expect(build().equals(build())).toBe(true);
    const other = serializeMessage(
      [["Subject", "x"]],
      multipart("mixed", [
        textPart("plain", "hello!"),
        filePart({
          contentType: "text/csv",
          fileName: "a.csv",
          disposition: "attachment",
          data: Buffer.from("1,2"),
        }),
      ]),
    );
    expect(other.equals(build())).toBe(false);
  });

  it("round-trips through a real MIME parser: nested structure, umlauts, cid, embedded message", async () => {
    const inner = serializeMessage(
      [
        ["Subject", "inner"],
        ["From", "i@example.test"],
      ],
      textPart("plain", "inner body"),
    );
    const raw = serializeMessage(
      [
        ["From", formatMailbox("Jürgen", "j@example.test")],
        ["Subject", encodeHeaderText("Grüße テスト")],
      ],
      multipart("mixed", [
        multipart("alternative", [
          textPart("plain", "Text €"),
          multipart("related", [
            textPart("html", '<p>ä <img src="cid:pic"></p>'),
            filePart({
              contentType: "image/png",
              fileName: "pic.png",
              disposition: "inline",
              contentId: "pic",
              data: Buffer.from([1, 2, 3]),
            }),
          ]),
        ]),
        filePart({
          contentType: "application/pdf",
          fileName: "Grüße für alle mit einem sehr langen Namen der umgebrochen werden muss.pdf",
          disposition: "attachment",
          data: Buffer.from("%PDF"),
        }),
        messagePart("inner.eml", inner),
      ]),
    );
    const mail = await simpleParser(raw);
    expect(mail.subject).toBe("Grüße テスト");
    expect(mail.from?.value[0]).toMatchObject({ name: "Jürgen", address: "j@example.test" });
    expect(mail.text).toBe("Text €");
    expect(mail.html).toContain("ä");
    const names = mail.attachments.map((a) => a.filename);
    expect(names).toContain("pic.png");
    expect(names).toContain(
      "Grüße für alle mit einem sehr langen Namen der umgebrochen werden muss.pdf",
    );
    expect(names).toContain("inner.eml");
    expect(mail.attachments.find((a) => a.filename === "inner.eml")?.contentType).toBe(
      "message/rfc822",
    );
  });

  it("marks an 8-bit embedded message as 8bit", () => {
    expect(messagePart("m.eml", Buffer.from("Subject: x\r\n\r\ncafé")).headers).toContainEqual([
      "Content-Transfer-Encoding",
      "8bit",
    ]);
    expect(messagePart("m.eml", Buffer.from("Subject: x\r\n\r\ncafe")).headers).toContainEqual([
      "Content-Transfer-Encoding",
      "7bit",
    ]);
  });

  it("writes MIME-Version after the given headers and folds long ones", () => {
    const raw = serializeMessage(
      [["To", Array.from({ length: 30 }, (_, i) => `user${i}@example.test`).join(", ")]],
      textPart("plain", "x"),
    ).toString();
    const lines = raw.split("\r\n");
    expect(lines.every((line) => line.length <= 78)).toBe(true);
    expect(raw.indexOf("MIME-Version: 1.0")).toBeGreaterThan(raw.indexOf("To:"));
  });
});
