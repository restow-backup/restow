import { describe, expect, it } from "vitest";
import { detectMailFormat, detectOtherArchive } from "./sniff.js";
import { buildEml, buildMbox, buildMsg, buildRawZip, buildZip } from "./testing/builders.js";

const sampleEml = buildEml({
  from: "Alice <alice@example.test>",
  to: "bob@example.test",
  subject: "Hello",
  body: "Hi Bob",
});

const detect = (text: string | Buffer) =>
  detectMailFormat(Buffer.isBuffer(text) ? text : Buffer.from(text));

describe("detectMailFormat", () => {
  describe("eml", () => {
    it("recognises a generated message", () => {
      expect(detectMailFormat(sampleEml).format).toBe("eml");
    });

    it("recognises LF and CRLF header blocks", () => {
      expect(detect("From: a@example.test\nSubject: x\n\nbody").format).toBe("eml");
      expect(detect("From: a@example.test\r\nSubject: x\r\n\r\nbody").format).toBe("eml");
    });

    it("accepts a header block that ends at the end of the head", () => {
      expect(detect("Received: from a\r\n by b\r\nFrom: a@example.test").format).toBe("eml");
    });

    it("accepts continuation lines and a single well-known field", () => {
      expect(detect("Subject: a very\r\n long subject\r\n\r\ntext").format).toBe("eml");
      expect(detect("Message-ID: <1@example.test>\r\n\r\n").format).toBe("eml");
    });

    it("accepts two unknown fields but not one", () => {
      expect(detect("X-One: 1\nX-Two: 2\n\nbody").format).toBe("eml");
      expect(detect("X-One: 1\n\nbody").format).toBe("unknown");
    });

    it("accepts a UTF-8 byte order mark", () => {
      expect(detect(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), sampleEml])).format).toBe(
        "eml",
      );
    });

    it("accepts raw 8-bit header content", () => {
      expect(
        detect(Buffer.from("From: Jürgen <j@example.test>\nSubject: Köln\n\nx", "utf8")).format,
      ).toBe("eml");
    });

    it("tolerates a head that was cut inside a header line", () => {
      const head = Buffer.alloc(64 * 1024, 0x61);
      const prefix = Buffer.from("From: a@example.test\r\nX-Long: ");
      prefix.copy(head);
      expect(detectMailFormat(head).format).toBe("eml");
    });

    it("rejects a header-like block with a bad line", () => {
      expect(detect("From: a@example.test\nthis line is not a header\n\nbody").format).toBe(
        "unknown",
      );
    });

    it("rejects field names with spaces", () => {
      expect(detect("Some text: with a space in the name\nAnother one: x\n").format).toBe(
        "unknown",
      );
    });

    it("rejects a leading blank line and a leading continuation", () => {
      expect(detect("\nFrom: a@example.test\n\n").format).toBe("unknown");
      expect(detect(" continued\nFrom: a@example.test\n").format).toBe("unknown");
    });

    it("rejects control characters and NUL bytes", () => {
      expect(detect("From: a@example.test\nSubject: a\u0000b\n\n").format).toBe("unknown");
      expect(detect("From: a@example.test\nSubject: a\u0001b\n\n").format).toBe("unknown");
    });
  });

  describe("mbox", () => {
    it("recognises a From_ line followed by a header", () => {
      expect(detectMailFormat(buildMbox([sampleEml])).format).toBe("mbox");
    });

    it("recognises Thunderbird style From - lines and CRLF", () => {
      expect(
        detect(
          "From - Thu Sep 30 12:00:00 2021\nX-Mozilla-Status: 0001\nFrom: a@example.test\n\nbody",
        ).format,
      ).toBe("mbox");
      expect(
        detect(
          "From MAILER-DAEMON Fri Jul  8 12:08:34 2011\r\nReturn-Path: <a@example.test>\r\n\r\nx",
        ).format,
      ).toBe("mbox");
    });

    it("recognises an mbox behind a byte order mark", () => {
      expect(
        detect(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buildMbox([sampleEml])])).format,
      ).toBe("mbox");
    });

    it("needs a header line after the From_ line", () => {
      expect(detect("From x\n\nbody").format).toBe("unknown");
      expect(detect("From x\nplain text\n").format).toBe("unknown");
      expect(detect("From x").format).toBe("unknown");
    });

    it("is not confused by a From: header", () => {
      expect(detect("From: a@example.test\nTo: b@example.test\n\n").format).toBe("eml");
    });

    it("needs the second line to be a header line, not prose", () => {
      expect(
        detect("From the desk of somebody\nof the company: hello\nmore text here\n").format,
      ).toBe("unknown");
      expect(detect("From the desk of somebody\nthis is plain prose\n").format).toBe("unknown");
    });
  });

  describe("containers", () => {
    it("recognises PST and OST by their magic, whatever follows", () => {
      const pst = Buffer.concat([Buffer.from("!BDN"), Buffer.alloc(600, 0)]);
      expect(detectMailFormat(pst).format).toBe("pst");
      expect(detectMailFormat(Buffer.from("!BDN")).format).toBe("pst");
    });

    it("recognises ZIP archives", async () => {
      expect(detectMailFormat(await buildZip([{ name: "a.eml", data: sampleEml }])).format).toBe(
        "zip",
      );
      expect(detectMailFormat(await buildZip([])).format).toBe("zip");
      expect(detectMailFormat(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])).format).toBe("zip");
      expect(detectMailFormat(Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0])).format).toBe("zip");
    });

    it("recognises an Office document as a ZIP (its content decides later)", () => {
      const docx = buildRawZip([
        { name: "[Content_Types].xml", data: "<Types/>" },
        { name: "word/document.xml", data: "<w/>" },
      ]);
      expect(detectMailFormat(docx).format).toBe("zip");
    });

    it("recognises OLE compound files as msg candidates", async () => {
      const msg = await buildMsg({
        from: { address: "alice@example.test" },
        to: [{ address: "bob@example.test" }],
        subject: "s",
        body: "b",
      });
      expect(detectMailFormat(msg).format).toBe("msg");
      expect(detectMailFormat(Buffer.from("d0cf11e0a1b11ae1", "hex")).format).toBe("msg");
    });

    it("does not accept a spanned-archive marker or a truncated ZIP magic as ZIP", () => {
      expect(detectMailFormat(Buffer.from([0x50, 0x4b, 0x07, 0x08])).format).not.toBe("zip");
      expect(detectMailFormat(Buffer.from([0x50, 0x4b])).format).toBe("unknown");
    });
  });

  describe("unknown", () => {
    it("says so for an empty file", () => {
      expect(detectMailFormat(Buffer.alloc(0))).toEqual({
        format: "unknown",
        detail: "The file is empty",
      });
    });

    it("says so for PDF, PNG, plain text and JSON", () => {
      expect(detect("%PDF-1.7\n%âãÏÓ\n1 0 obj\n").format).toBe("unknown");
      expect(
        detect(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])).format,
      ).toBe("unknown");
      expect(detect("just a note\nabout nothing in particular").format).toBe("unknown");
      expect(detect('{"from": "a@example.test", "to": "b"}').format).toBe("unknown");
    });

    it("says so for random binary data", () => {
      const noise = Buffer.alloc(4096);
      for (let i = 0; i < noise.length; i++) {
        noise[i] = (i * 131 + 17) & 0xff;
      }
      expect(detectMailFormat(noise).format).toBe("unknown");
    });

    it("says so for UTF-16 text", () => {
      expect(detect(Buffer.from("﻿From: a@example.test\nSubject: x\n\n", "utf16le")).format).toBe(
        "unknown",
      );
    });

    it("names other archive formats in the detail", () => {
      const gz = Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3]);
      expect(detectMailFormat(gz)).toEqual({ format: "unknown", detail: "gzip archive" });
      expect(detectOtherArchive(gz)).toBe("gzip");
      expect(detectOtherArchive(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]))).toBe(
        "7z",
      );
      expect(detectOtherArchive(Buffer.from("Rar!\x1a\x07\x01\x00", "latin1"))).toBe("rar");
      expect(detectOtherArchive(Buffer.from("BZh91AY&SY", "latin1"))).toBe("bzip2");
      expect(detectOtherArchive(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0]))).toBe("xz");
      expect(detectOtherArchive(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0]))).toBe("zstd");
      const tar = Buffer.alloc(512);
      tar.write("ustar", 257, "latin1");
      expect(detectOtherArchive(tar)).toBe("tar");
      expect(detectOtherArchive(Buffer.from("hello"))).toBeNull();
    });
  });

  it("never uses the name: the same bytes give the same verdict", () => {
    // detectMailFormat has no name parameter; this documents that a .txt full of mail is still mail.
    expect(detectMailFormat(sampleEml).format).toBe("eml");
  });
});
