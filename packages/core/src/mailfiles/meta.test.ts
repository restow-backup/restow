import { afterAll, describe, expect, it, vi } from "vitest";
import { shutdownIsolation } from "./isolate.js";
import {
  EMPTY_MESSAGE_META,
  HTML_TEXT_DEFAULT_LIMIT,
  MAX_BODY_TEXT_CHARS,
  htmlToPlainText,
  parseMessageMeta,
} from "./meta.js";
import { buildEml } from "./testing/builders.js";

describe("parseMessageMeta", () => {
  it("derives the envelope fields of a plain message", async () => {
    const meta = await parseMessageMeta(
      buildEml({
        from: "Alice Example <alice@example.test>",
        to: ["Bob <bob@example.test>", "carol@example.test"],
        cc: "Dave <dave@example.test>",
        subject: "Quarterly numbers",
        date: "Mon, 15 Jan 2024 10:00:00 +0000",
        messageId: "<abc123@example.test>",
        body: "Hello Bob,\r\nthe numbers are attached.\r\n",
      }),
    );
    expect(meta.messageId).toBe("<abc123@example.test>");
    expect(meta.subject).toBe("Quarterly numbers");
    expect(meta.from).toBe("Alice Example <alice@example.test>");
    expect(meta.to).toEqual(["Bob <bob@example.test>", "carol@example.test"]);
    expect(meta.toCount).toBe(2);
    expect(meta.cc).toEqual(["Dave <dave@example.test>"]);
    expect(meta.ccCount).toBe(1);
    expect(meta.hasAttachments).toBe(false);
    expect(meta.attachmentCount).toBe(0);
    expect(meta.sentAt?.toISOString()).toBe("2024-01-15T10:00:00.000Z");
    expect(meta.protection).toBeNull();
    expect(meta.bodyText.trim()).toBe("Hello Bob,\nthe numbers are attached.");
  });

  it("decodes non-ASCII subjects and display names", async () => {
    const meta = await parseMessageMeta(
      buildEml({
        from: "Jürgen Müller <juergen@example.test>",
        to: "Zoë <zoe@example.test>",
        subject: "Grüße aus Köln – テスト",
        body: "Größe: 5 €",
      }),
    );
    expect(meta.subject).toBe("Grüße aus Köln – テスト");
    expect(meta.from).toBe("Jürgen Müller <juergen@example.test>");
    expect(meta.to).toEqual(["Zoë <zoe@example.test>"]);
    expect(meta.bodyText.trim()).toBe("Größe: 5 €");
  });

  it("quotes display names that contain specials, like the IMAP envelope", async () => {
    const meta = await parseMessageMeta(
      buildEml({
        from: '"Flores, Lucas" <lucas@example.test>',
        to: "x@example.test",
        subject: "s",
        body: "b",
      }),
    );
    expect(meta.from).toBe('"Flores, Lucas" <lucas@example.test>');
  });

  it("counts attachments but not inline images or calendar parts", async () => {
    const meta = await parseMessageMeta(
      buildEml({
        from: "a@example.test",
        to: "b@example.test",
        subject: "files",
        body: "see attached",
        html: '<p>see <img src="cid:logo"></p>',
        attachments: [
          { filename: "report.pdf", content: "PDF" },
          { filename: "table.xlsx", content: "XLS" },
          { filename: "logo.png", content: "PNG", cid: "logo" },
        ],
      }),
    );
    expect(meta.hasAttachments).toBe(true);
    expect(meta.attachmentCount).toBe(2);
  });

  it("counts an attached message as an attachment", async () => {
    const inner = buildEml({
      from: "x@example.test",
      to: "y@example.test",
      subject: "inner",
      body: "i",
    });
    const raw = Buffer.concat([
      Buffer.from(
        [
          "From: a@example.test",
          "To: b@example.test",
          "Subject: fwd",
          "MIME-Version: 1.0",
          'Content-Type: multipart/mixed; boundary="B"',
          "",
          "--B",
          "Content-Type: text/plain",
          "",
          "look",
          "--B",
          "Content-Type: message/rfc822",
          "",
          "",
        ].join("\r\n"),
      ),
      inner,
      Buffer.from("\r\n--B--\r\n"),
    ]);
    const meta = await parseMessageMeta(raw);
    expect(meta.hasAttachments).toBe(true);
    expect(meta.attachmentCount).toBe(1);
  });

  it("caps the address lists at 20 but reports the full count", async () => {
    const many = Array.from({ length: 27 }, (_, i) => `user${i}@example.test`);
    const meta = await parseMessageMeta(
      buildEml({
        from: "a@example.test",
        to: many,
        cc: many.slice(0, 22),
        subject: "s",
        body: "b",
      }),
    );
    expect(meta.to).toHaveLength(20);
    expect(meta.toCount).toBe(27);
    expect(meta.cc).toHaveLength(20);
    expect(meta.ccCount).toBe(22);
  });

  it("flattens address groups", async () => {
    const meta = await parseMessageMeta(
      Buffer.from(
        "From: a@example.test\r\nTo: Team: x@example.test, y@example.test;\r\nSubject: g\r\n\r\nbody\r\n",
      ),
    );
    expect(meta.to).toEqual(["x@example.test", "y@example.test"]);
    expect(meta.toCount).toBe(2);
  });

  it("returns null/empty for a message without the fields", async () => {
    const meta = await parseMessageMeta(Buffer.from("X-Only: header\r\n\r\njust a body\r\n"));
    expect(meta.messageId).toBeNull();
    expect(meta.from).toBeNull();
    expect(meta.subject).toBe("");
    expect(meta.to).toEqual([]);
    expect(meta.sentAt).toBeNull();
    expect(meta.bodyText.trim()).toBe("just a body");
  });

  it("returns null for an invalid Date header", async () => {
    const meta = await parseMessageMeta(
      Buffer.from("From: a@example.test\r\nDate: not a date at all\r\n\r\nx\r\n"),
    );
    expect(meta.sentAt).toBeNull();
  });

  it("uses the plain text converted from HTML when there is no text part", async () => {
    const meta = await parseMessageMeta(
      Buffer.from(
        [
          "From: a@example.test",
          "Subject: html only",
          "MIME-Version: 1.0",
          "Content-Type: text/html; charset=utf-8",
          "",
          "<html><head><style>p{color:red}</style></head><body><p>Hello <b>World</b></p><p>Second&nbsp;line &amp; more</p></body></html>",
        ].join("\r\n"),
      ),
    );
    expect(meta.bodyText).toContain("Hello");
    expect(meta.bodyText).toContain("World");
    expect(meta.bodyText).not.toContain("<b>");
    expect(meta.bodyText).not.toContain("color:red");
  });

  it("cuts the body text at 200,000 characters", async () => {
    const meta = await parseMessageMeta(
      buildEml({
        from: "a@example.test",
        to: "b@example.test",
        subject: "big",
        body: "x".repeat(300_000),
      }),
    );
    expect(meta.bodyText).toHaveLength(MAX_BODY_TEXT_CHARS);
  });

  describe("protection", () => {
    it("flags S/MIME enveloped data", async () => {
      const meta = await parseMessageMeta(
        Buffer.from(
          [
            "From: a@example.test",
            "Subject: secret",
            "MIME-Version: 1.0",
            'Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"',
            "Content-Transfer-Encoding: base64",
            "",
            "AAAA",
            "",
          ].join("\r\n"),
        ),
      );
      expect(meta.protection).toBe("smime-encrypted");
    });

    it("flags opaque S/MIME by its conventional name when no smime-type is given", async () => {
      const meta = await parseMessageMeta(
        Buffer.from(
          [
            "From: a@example.test",
            "MIME-Version: 1.0",
            'Content-Type: application/x-pkcs7-mime; name="smime.p7m"',
            "Content-Transfer-Encoding: base64",
            "",
            "AAAA",
            "",
          ].join("\r\n"),
        ),
      );
      expect(meta.protection).toBe("smime-encrypted");
    });

    it("does not flag signed-only S/MIME", async () => {
      const opaque = await parseMessageMeta(
        Buffer.from(
          [
            "From: a@example.test",
            "MIME-Version: 1.0",
            'Content-Type: application/pkcs7-mime; smime-type=signed-data; name="smime.p7m"',
            "Content-Transfer-Encoding: base64",
            "",
            "AAAA",
            "",
          ].join("\r\n"),
        ),
      );
      expect(opaque.protection).toBeNull();
      const detached = await parseMessageMeta(
        Buffer.from(
          [
            "From: a@example.test",
            "MIME-Version: 1.0",
            'Content-Type: multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="S"',
            "",
            "--S",
            "Content-Type: text/plain",
            "",
            "hello",
            "--S",
            'Content-Type: application/pkcs7-signature; name="smime.p7s"',
            "Content-Transfer-Encoding: base64",
            "",
            "AAAA",
            "--S--",
            "",
          ].join("\r\n"),
        ),
      );
      expect(detached.protection).toBeNull();
    });

    it("flags rights-protected messages by their rpmsg part", async () => {
      const meta = await parseMessageMeta(
        Buffer.from(
          [
            "From: a@example.test",
            "Subject: protected",
            "MIME-Version: 1.0",
            'Content-Type: multipart/mixed; boundary="R"',
            "",
            "--R",
            "Content-Type: text/plain",
            "",
            "This message is protected.",
            "--R",
            'Content-Type: application/x-microsoft-rpmsg-message; name="message.rpmsg"',
            'Content-Disposition: attachment; filename="message.rpmsg"',
            "Content-Transfer-Encoding: base64",
            "",
            "AAAA",
            "--R--",
            "",
          ].join("\r\n"),
        ),
      );
      expect(meta.protection).toBe("rights-protected");
    });
  });

  describe("robustness", () => {
    it("never throws on garbage", async () => {
      for (const junk of [
        Buffer.alloc(0),
        Buffer.from("\u0000\u0001\u0002"),
        Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x80]),
        Buffer.from("Content-Type: multipart/mixed; boundary=\r\n\r\n--\r\n"),
        Buffer.from(`Content-Type: multipart/mixed; boundary="x"\r\n\r\n${"--x\r\n".repeat(1000)}`),
      ]) {
        const meta = await parseMessageMeta(junk);
        expect(meta).toBeDefined();
        expect(typeof meta.subject).toBe("string");
      }
    });

    it("returns empty metadata for an empty buffer", async () => {
      expect(await parseMessageMeta(Buffer.alloc(0))).toMatchObject({
        messageId: null,
        subject: "",
        from: null,
        toCount: 0,
      });
    });

    it("exposes an empty metadata constant", () => {
      expect(EMPTY_MESSAGE_META.bodyText).toBe("");
    });
  });
});

afterAll(async () => {
  await shutdownIsolation();
});

describe("htmlToPlainText", () => {
  it("strips tags, styles and entities", () => {
    expect(htmlToPlainText("<style>a{}</style><p>One &amp; two</p><p>three&nbsp;four</p>")).toBe(
      "One & two\nthree four",
    );
  });

  it("removes script, style and head blocks but keeps words that only start like them", () => {
    expect(
      htmlToPlainText(
        "<HEAD><title>t</title></HEAD><header>Top</header><script type=x>var a = '<b>';</script>Body <style>p{}</style>end",
      ),
    ).toBe("Top Body end");
  });

  it("decodes numeric and common named entities once", () => {
    expect(htmlToPlainText("M&uuml;ller &amp; S&#246;hne &#x20AC;5 &amp;lt; &unknown; &#0;")).toBe(
      "Müller & Söhne €5 &lt; &unknown; &#0;",
    );
  });

  it("leaves a block that is never closed to the tag stripper, and a stray < as text", () => {
    expect(htmlToPlainText("a <script>never closed <b>bold</b>")).toBe("a never closed bold");
    expect(htmlToPlainText("1 < 2 and no tag end")).toBe("1 < 2 and no tag end");
  });

  it("reads at most the given number of characters, all of them when told so", () => {
    const html = `<p>${"word ".repeat(300_000)}</p>`;
    expect(htmlToPlainText(html).length).toBeLessThanOrEqual(HTML_TEXT_DEFAULT_LIMIT);
    const cut = htmlToPlainText(html, 100);
    expect(cut.length).toBeLessThanOrEqual(100);
    expect(cut.startsWith("word word")).toBe(true);
    expect(htmlToPlainText(html, Number.POSITIVE_INFINITY).length).toBe(300_000 * 5 - 1);
  });

  it("is linear: a body made of nothing but openers takes no time (it was quadratic)", () => {
    const started = Date.now();
    for (const filler of [
      "<",
      "<script>",
      "<style ",
      "<head",
      "<b <i ",
      "<br ",
      "</p ",
      "\r",
      "\u2003",
    ]) {
      const text = htmlToPlainText(filler.repeat(Math.ceil(900_000 / filler.length)));
      expect(typeof text).toBe("string");
    }
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

// The first message that needs a parser process starts it, which takes longer on a busy machine.
vi.setConfig({ testTimeout: 60_000 });

describe("parseMessageMeta in a child process", () => {
  it("gives a message whose parse runs over its time limit empty metadata, marked, and carries on", async () => {
    // Quoted-printable soft line breaks: mailparser decodes them in time that grows with the square
    // of the body (18 MB took 48 seconds), a message made of nothing else is a way to stall a worker.
    const bomb = Buffer.from(
      `From: a@example.test\r\nSubject: slow\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${"=\r\n=3D".repeat(700_000)}`,
    );
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const started = Date.now();
    const meta = await parseMessageMeta(bomb, { timeoutMs: 400 });
    clearInterval(timer);
    expect(meta.unavailable).toBe(true);
    expect(meta.subject).toBe("");
    expect(Date.now() - started).toBeLessThan(10_000);
    // The event loop of the caller kept running while the parse was going on.
    expect(ticks).toBeGreaterThan(10);
    // The next message is parsed as usual.
    const next = await parseMessageMeta(
      buildEml({ from: "a@example.test", to: "b@example.test", subject: "after", body: "ok" }),
    );
    expect(next.subject).toBe("after");
    expect(next.unavailable).toBeUndefined();
  });

  it("survives a 30 MB text of '<' (mailparser turns it into a 120 MB string when asked for HTML) without a stall", async () => {
    const hostile = Buffer.from(
      `From: a@example.test\r\nSubject: report\r\nContent-Type: text/plain\r\n\r\n${"<".repeat(30 * 1024 * 1024)}`,
    );
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const meta = await parseMessageMeta(hostile);
    clearInterval(timer);
    // Nothing is asked of mailparser that is not used, so this is an ordinary parse: the subject is
    // read and the search text is cut at its limit.
    expect(meta.unavailable).toBeUndefined();
    expect(meta.subject).toBe("report");
    expect(meta.bodyText.length).toBe(MAX_BODY_TEXT_CHARS);
    expect(ticks).toBeGreaterThan(0);
  });

  it("does not wait a minute for a date header of parentheses", async () => {
    const started = Date.now();
    const meta = await parseMessageMeta(
      Buffer.from(
        `From: a@example.test\r\nSubject: dated\r\nDate: ${"(".repeat(500_000)}\r\n\r\nbody`,
      ),
    );
    expect(meta.subject).toBe("dated");
    expect(meta.sentAt).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reads the search text of an HTML-only message too large for mailparser's conversion", async () => {
    const html = "<p>row</p>".repeat(70_000);
    const meta = await parseMessageMeta(
      Buffer.from(
        `From: a@example.test\r\nSubject: html\r\nContent-Type: text/html\r\n\r\n${html}`,
      ),
    );
    expect(meta.subject).toBe("html");
    expect(meta.bodyText.startsWith("row\nrow")).toBe(true);
  });
});
