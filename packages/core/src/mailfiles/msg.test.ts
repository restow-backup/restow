import { readFileSync } from "node:fs";
import { CFB } from "@tutao/oxmsg";
import { type ParsedMail, simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { parseMessageMeta } from "./meta.js";
import { type MsgReadResult, msgParseTimeoutMs, readMsg } from "./msg.js";
import { buildMsg } from "./testing/builders.js";

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./testdata/${name}`, import.meta.url));

function ok(result: MsgReadResult): Extract<MsgReadResult, { ok: true }> {
  expect(result.ok).toBe(true);
  return result as Extract<MsgReadResult, { ok: true }>;
}

async function parse(result: MsgReadResult): Promise<ParsedMail> {
  return simpleParser(ok(result).raw);
}

const addressesOf = (field: ParsedMail["to"] | ParsedMail["cc"] | ParsedMail["bcc"]): string[] => {
  const lists = field === undefined ? [] : Array.isArray(field) ? field : [field];
  return lists.flatMap((list) => list.value.map((v) => v.address ?? ""));
};

describe(
  "readMsg with MSG files made by Outlook (msgreader test data)",
  { timeout: 60_000 },
  () => {
    it("rebuilds a received message with its transport headers and attachments", async () => {
      const result = await readMsg(fixture("outlook-attachments-headers.msg"));
      const built = ok(result);
      const raw = built.raw.toString("utf8");
      // Original transport headers are kept verbatim ...
      expect(raw).toContain("Return-Path: hmailuser@hmailserver.test\r\n");
      expect(raw).toContain(
        "Received: from H270 (kubernetes.docker.internal [127.0.0.1])\r\n\tby H270 with ESMTPA\r\n\t; Wed, 1 Nov 2023 09:48:31 +0900\r\n",
      );
      expect(raw).toContain("Message-ID: <000001da0c5d$22ab1460$68013d20$@hmailserver.test>\r\n");
      expect(raw).toContain("X-Mailer: Microsoft Outlook 15.0\r\n");
      // ... the original boundary is gone with the structure it belonged to, exactly one MIME-Version is written.
      expect(raw).not.toContain("_NextPart_000_0001_01DA0CA8");
      expect(raw.match(/^MIME-Version:/gim)).toHaveLength(1);
      expect(raw.match(/^Content-Type: multipart\/mixed/gim)).toHaveLength(1);

      const mail = await parse(result);
      expect(mail.subject).toBe("attachmentFiles");
      expect(mail.from?.value[0]?.address).toBe("hmailuser@hmailserver.test");
      expect(addressesOf(mail.to)).toEqual(["hmailuser@hmailserver.test"]);
      expect(mail.text?.trim()).toBe("attachmentFiles");
      expect(mail.attachments.map((a) => a.filename)).toEqual(["jpg.jpg", "png.png", "tif.tif"]);
      expect(mail.attachments.map((a) => a.contentType)).toEqual([
        "image/jpeg",
        "image/png",
        "image/tiff",
      ]);
      expect(mail.attachments.map((a) => a.size)).toEqual([726, 134, 664]);
      expect(mail.attachments[0]?.content.subarray(0, 4).toString("hex")).toBe("ffd8ffe0");
      expect(mail.attachments[1]?.content.subarray(0, 4).toString("hex")).toBe("89504e47");
      expect(mail.messageId).toBe("<000001da0c5d$22ab1460$68013d20$@hmailserver.test>");
      expect(mail.date?.toISOString()).toBe("2023-11-01T00:48:31.000Z");

      expect(built.attachmentCount).toBe(3);
      expect(built.internalDate?.toISOString()).toBe("2023-11-01T00:48:31.000Z");
      expect(built.flags).toEqual([]);
    });

    it("rebuilds an embedded message as message/rfc822 next to a regular attachment", async () => {
      const result = await readMsg(fixture("outlook-embedded-message.msg"));
      const built = ok(result);
      expect(built.flags).toEqual(["\\Seen", "\\Draft"]);
      const mail = await parse(result);
      expect(mail.subject).toBe("I have attachments!");
      expect(mail.text?.trim()).toBe("I have attachments!");
      const names = mail.attachments.map((a) => a.filename);
      expect(names).toEqual(["Microsoft Outlook テスト メッセージ.eml", "green.png"]);
      const embedded = mail.attachments[0];
      expect(embedded?.contentType).toBe("message/rfc822");
      const inner = await simpleParser(embedded?.content as Buffer);
      expect(inner.subject).toBe("Microsoft Outlook テスト メッセージ");
      expect(inner.from?.value[0]?.address).toBe("xmailuser@xmailserver.test");
      expect(inner.text).toContain("Microsoft Outlook");
      expect(mail.attachments[1]?.size).toBe(134);
      // The embedded message keeps its own transport headers.
      expect(embedded?.content.toString("utf8")).toContain(
        "Received: from H270 ([127.0.0.1]:56695)",
      );
    });

    it("keeps an inline image (Content-ID) and an ordinary attachment of a rich text message", async () => {
      const result = await readMsg(fixture("outlook-attachment-inline.msg"));
      const mail = await parse(result);
      expect(mail.subject).toBe("Attach and inline");
      expect(addressesOf(mail.to)).toEqual(["xmailuser@xmailserver.test"]);
      expect(mail.attachments.map((a) => a.filename)).toEqual(["attach.png", "image001.png"]);
      expect(mail.attachments[1]?.contentId).toBe("<image001.png@01D78380.EF6DC500>");
      expect(mail.attachments.map((a) => a.size)).toEqual([1558, 809]);
      expect(mail.date?.toISOString()).toBe("2021-07-27T22:19:50.000Z");
    });

    it("decodes 8-bit Japanese text using the message's code page", async () => {
      const result = await readMsg(fixture("outlook-ansi-japanese.msg"));
      const mail = await parse(result);
      expect(mail.subject).toBe("日本語 Non Unicode タイトル");
      expect(mail.text?.trim()).toBe("日本語 Non Unicode 本文");
    });

    it("refuses contacts and notes as not mail", async () => {
      const contact = await readMsg(fixture("outlook-contact.msg"));
      expect(contact).toMatchObject({ ok: false, code: "not_mail" });
      expect((contact as { reason: string }).reason).toContain("contact");
      const note = await readMsg(fixture("outlook-sticky-note.msg"));
      expect(note).toMatchObject({ ok: false, code: "not_mail" });
      expect((note as { reason: string }).reason).toContain("note");
    });

    it("is deterministic: the same MSG bytes give the same EML bytes", async () => {
      for (const name of [
        "outlook-attachments-headers.msg",
        "outlook-embedded-message.msg",
        "outlook-attachment-inline.msg",
        "outlook-ansi-japanese.msg",
      ]) {
        const bytes = fixture(name);
        const first = ok(await readMsg(bytes)).raw;
        const second = ok(await readMsg(Buffer.from(bytes))).raw;
        expect(first.equals(second)).toBe(true);
      }
    });

    it("does not invent a Message-ID or a Date it does not know", async () => {
      const raw = ok(await readMsg(fixture("outlook-ansi-japanese.msg"))).raw.toString("utf8");
      expect(raw).not.toMatch(/^Message-ID:/im);
      const embedded = ok(await readMsg(fixture("outlook-embedded-message.msg"))).raw.toString(
        "utf8",
      );
      expect(embedded).not.toMatch(/^Message-ID:/im);
    });
  },
);

describe("readMsg with MSG files made by @tutao/oxmsg", { timeout: 60_000 }, () => {
  const sent = new Date("2024-01-15T10:00:00Z");
  const received = new Date("2024-01-15T10:00:05Z");

  it("rebuilds addresses, non-ASCII text, HTML with an inline image and attachments", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const pdf = Buffer.from("%PDF-1.4 fake pdf content\n");
    const msg = await buildMsg({
      from: { address: "alice@example.test", name: "Alice Ünal" },
      to: [
        { address: "bob@example.test", name: "Bob" },
        { address: "zoe@example.test", name: "Zoë, the Second" },
      ],
      cc: [{ address: "carol@example.test" }],
      bcc: [{ address: "dave@example.test", name: "Dave" }],
      subject: "Grüße aus Köln – テスト",
      body: "Hallo Welt\r\nZeile 2 äöü €",
      html: '<html><body><p>Hallo <b>Welt</b></p><img src="cid:img1"></body></html>',
      sentOn: sent,
      receivedOn: received,
      attachments: [
        { filename: "Bericht äöü.pdf", content: pdf },
        { filename: "img1.png", content: png, cid: "img1" },
      ],
    });
    const result = await readMsg(msg);
    const built = ok(result);
    const mail = await parse(result);
    expect(mail.subject).toBe("Grüße aus Köln – テスト");
    expect(mail.from?.value[0]).toMatchObject({
      address: "alice@example.test",
      name: "Alice Ünal",
    });
    expect(addressesOf(mail.to)).toEqual(["bob@example.test", "zoe@example.test"]);
    expect(mail.to && !Array.isArray(mail.to) ? mail.to.value[1]?.name : null).toBe(
      "Zoë, the Second",
    );
    expect(addressesOf(mail.cc)).toEqual(["carol@example.test"]);
    expect(addressesOf(mail.bcc)).toEqual(["dave@example.test"]);
    expect(mail.date?.toISOString()).toBe("2024-01-15T10:00:00.000Z");
    expect(mail.text).toBe("Hallo Welt\nZeile 2 äöü €");
    expect(mail.html).toContain("Hallo <b>Welt</b>");
    const [report, image] = [
      mail.attachments.find((a) => a.filename === "Bericht äöü.pdf"),
      mail.attachments.find((a) => a.filename === "img1.png"),
    ];
    expect(report?.content.equals(pdf)).toBe(true);
    expect(image?.content.equals(png)).toBe(true);
    expect(image?.related).toBe(true);
    expect(image?.contentId).toBe("<img1>");
    expect(built.attachmentCount).toBe(2);
    expect(built.internalDate?.toISOString()).toBe("2024-01-15T10:00:05.000Z");
    // No transport headers: no Message-ID is made up.
    expect(built.raw.toString("utf8")).not.toMatch(/^Message-ID:/im);
    const meta = await parseMessageMeta(built.raw);
    expect(meta.attachmentCount).toBe(1);
    expect(meta.toCount).toBe(2);
  });

  it("treats exactly the referenced Content-IDs as inline parts, however the HTML names them", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const msg = await buildMsg({
      from: { address: "alice@example.test" },
      to: [{ address: "bob@example.test" }],
      subject: "cid",
      body: "text",
      html: '<html><body style="background:url(cid:bg.png)"><img src="CID:Logo.PNG" alt=x><img srcset="cid:a.png 1x, cid:b.png 2x"></body></html>',
      attachments: [
        { filename: "bg.png", content: png, cid: "bg.png" },
        { filename: "logo.png", content: png, cid: "logo.png" },
        { filename: "a.png", content: png, cid: "a.png" },
        { filename: "b.png", content: png, cid: "b.png" },
        { filename: "unused.png", content: png, cid: "unused.png" },
        { filename: "prefix.png", content: png, cid: "bg" },
      ],
    });
    const mail = await parse(await readMsg(msg));
    const related = (name: string) => mail.attachments.find((a) => a.filename === name)?.related;
    expect(related("bg.png")).toBe(true);
    expect(related("logo.png")).toBe(true);
    expect(related("a.png")).toBe(true);
    expect(related("b.png")).toBe(true);
    // Not named by the HTML, also not when its id is the start of a name that is.
    expect(related("unused.png")).toBeFalsy();
    expect(related("prefix.png")).toBeFalsy();
  });

  it("reads a message with many inline images and a large body in reasonable time", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const count = 100;
    const html = `<html><body>${Array.from({ length: count }, (_, i) => `<img src="cid:i${i}">`).join("")}${"<p>filler filler filler</p>".repeat(30_000)}</body></html>`;
    const msg = await buildMsg({
      from: { address: "alice@example.test" },
      to: [{ address: "bob@example.test" }],
      subject: "many",
      body: "text",
      html,
      attachments: Array.from({ length: count }, (_, i) => ({
        filename: `i${i}.png`,
        content: png,
        cid: `i${i}`,
      })),
    });
    const started = Date.now();
    const built = ok(await readMsg(msg));
    expect(built.attachmentCount).toBe(count);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("is deterministic for a generated MSG", async () => {
    const msg = await buildMsg({
      from: { address: "alice@example.test" },
      to: [{ address: "bob@example.test" }],
      subject: "same",
      body: "same",
      html: "<p>same</p>",
      sentOn: sent,
      attachments: [{ filename: "a.txt", content: "abc" }],
    });
    expect(ok(await readMsg(msg)).raw.equals(ok(await readMsg(Buffer.from(msg))).raw)).toBe(true);
  });

  it("maps the read flag to \\Seen and an unsent message to \\Draft", async () => {
    const base = {
      from: { address: "alice@example.test" },
      to: [{ address: "bob@example.test" }],
      subject: "flags",
      body: "b",
    };
    expect(ok(await readMsg(await buildMsg({ ...base, read: true }))).flags).toEqual(["\\Seen"]);
    expect(ok(await readMsg(await buildMsg({ ...base }))).flags).toEqual([]);
    expect(ok(await readMsg(await buildMsg({ ...base, draft: true }))).flags).toEqual(["\\Draft"]);
    expect(ok(await readMsg(await buildMsg({ ...base, draft: true, read: true }))).flags).toEqual([
      "\\Seen",
      "\\Draft",
    ]);
  });

  it("writes no Date header when the MSG has no time", async () => {
    const msg = await buildMsg({
      from: { address: "alice@example.test" },
      to: [{ address: "bob@example.test" }],
      subject: "undated",
      body: "b",
      noTimes: true,
    });
    const built = ok(await readMsg(msg));
    expect(built.raw.toString("utf8")).not.toMatch(/^Date:/im);
    expect(built.internalDate).toBeNull();
  });

  it("keeps the given transport headers and replaces the structure headers", async () => {
    const msg = await buildMsg({
      from: { address: "alice@example.test", name: "Alice" },
      to: [{ address: "bob@example.test" }],
      subject: "Changed in Outlook",
      body: "text",
      html: "<p>html</p>",
      transportHeaders: [
        "Received: from mx.example.test by mail.example.test; Mon, 15 Jan 2024 10:00:00 +0000",
        "From: Alice <alice@example.test>",
        "To: bob@example.test",
        "Subject: Original subject",
        "Date: Mon, 15 Jan 2024 09:59:00 +0000",
        "Message-ID: <original@example.test>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/alternative; boundary="orig"',
        "X-Custom: kept",
        "",
        "",
      ].join("\r\n"),
    });
    const built = ok(await readMsg(msg));
    const raw = built.raw.toString("utf8");
    expect(raw).toContain(
      "Received: from mx.example.test by mail.example.test; Mon, 15 Jan 2024 10:00:00 +0000\r\n",
    );
    expect(raw).toContain("X-Custom: kept\r\n");
    expect(raw).not.toContain('boundary="orig"');
    expect(raw.match(/^Subject:/gim)).toHaveLength(1);
    expect(raw.match(/^Message-ID:/gim)).toHaveLength(1);
    const mail = await parse(await readMsg(msg));
    expect(mail.subject).toBe("Original subject");
    expect(mail.messageId).toBe("<original@example.test>");
    expect(mail.html).toContain("<p>html</p>");
    expect(mail.text).toBe("text");
  });

  it("neutralises line breaks in header values", async () => {
    const msg = await buildMsg({
      from: { address: "alice@example.test", name: "Alice\r\nBcc: evil@example.test" },
      to: [{ address: "bob@example.test" }],
      subject: "hello\r\nBcc: evil@example.test",
      body: "b",
    });
    const raw = ok(await readMsg(msg)).raw.toString("utf8");
    expect(raw).not.toMatch(/^Bcc:/im);
    const mail = await parse(await readMsg(msg));
    expect(mail.bcc).toBeUndefined();
  });

  it("reports Outlook items that are not mail", async () => {
    for (const [messageClass, word] of [
      ["IPM.Contact", "contact"],
      ["IPM.Appointment", "appointment"],
      ["IPM.Task", "task"],
      ["IPM.StickyNote", "note"],
      ["IPM.Activity", "journal"],
      ["IPM.DistList", "distribution list"],
    ] as const) {
      const msg = await buildMsg({
        from: { address: "alice@example.test" },
        to: [{ address: "bob@example.test" }],
        subject: "not mail",
        body: "b",
        messageClass,
      });
      const result = await readMsg(msg);
      expect(result, messageClass).toMatchObject({ ok: false, code: "not_mail" });
      expect((result as { reason: string }).reason).toContain(word);
    }
  });

  it("treats meeting requests, task requests and reports as mail", async () => {
    for (const messageClass of [
      "IPM.Note",
      "IPM.Schedule.Meeting.Request",
      "IPM.TaskRequest",
      "REPORT.IPM.Note.NDR",
      "IPM.Note.SMIME",
    ]) {
      const msg = await buildMsg({
        from: { address: "alice@example.test" },
        to: [{ address: "bob@example.test" }],
        subject: "mail",
        body: "b",
        messageClass,
      });
      expect((await readMsg(msg)).ok, messageClass).toBe(true);
    }
  });
});

describe("readMsg with unusable input", { timeout: 60_000 }, () => {
  it("reports an OLE file that is not an Outlook message as not mail", async () => {
    const cfb = CFB.utils.cfb_new();
    CFB.utils.cfb_add(cfb, "/WordDocument", Buffer.from("hello world"));
    CFB.utils.cfb_add(cfb, "/1Table", Buffer.from("x".repeat(100)));
    const bytes = Buffer.from(CFB.write(cfb, { type: "buffer" }) as Uint8Array);
    const result = await readMsg(bytes);
    expect(result).toMatchObject({ ok: false, code: "not_mail" });
    expect((result as { reason: string }).reason).toContain("not an Outlook message");
  });

  it("reports damaged files as unreadable, never throws", async () => {
    const real = fixture("outlook-attachment-inline.msg");
    const magic = Buffer.from("d0cf11e0a1b11ae1", "hex");
    const cases: Buffer[] = [
      Buffer.alloc(0),
      magic,
      Buffer.concat([magic, Buffer.alloc(1000, 7)]),
      Buffer.concat([magic, Buffer.alloc(4096, 0)]),
      real.subarray(0, 100),
      real.subarray(0, 1024),
      real.subarray(0, 5000),
      Buffer.from("this is not a compound file at all"),
    ];
    for (const bytes of cases) {
      const result = await readMsg(bytes);
      expect(result.ok).toBe(false);
      expect((result as { code: string }).code).toMatch(/unreadable|not_mail/);
    }
    const flipped = Buffer.from(real);
    for (let i = 0; i < flipped.length; i += 7) {
      flipped[i] = (flipped[i] as number) ^ 0xa5;
    }
    await expect(readMsg(flipped)).resolves.toBeDefined();
  });

  it("refuses the file that sent msgreader into an endless loop before it parses it", async () => {
    // A copy of outlook-attachments-headers.msg with a few bytes of the compound file damaged:
    // msgreader never returns from getFileData() for it.
    const started = Date.now();
    const result = await readMsg(fixture("corrupt-endless-loop.msg"));
    expect(result).toMatchObject({ ok: false, code: "unreadable" });
    expect((result as { reason: string }).reason).toContain("is damaged (");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("stops msgreader in its child process when the structure check is out of the way", async () => {
    // Same file, structure check off: the reader loops until the process is killed.
    const started = Date.now();
    const result = await readMsg(fixture("corrupt-endless-loop.msg"), {
      timeoutMs: 400,
      structureCheck: false,
    });
    expect(result).toMatchObject({ ok: false, code: "unreadable" });
    expect((result as { reason: string }).reason).toContain("reasonable time");
    expect(Date.now() - started).toBeLessThan(10_000);
    // The reader is usable afterwards.
    expect((await readMsg(fixture("outlook-attachments-headers.msg"))).ok).toBe(true);
  });

  it("grows the time limit with the file size but keeps it bounded", async () => {
    expect(msgParseTimeoutMs(1000)).toBe(15_500);
    expect(msgParseTimeoutMs(100 * 1024 * 1024)).toBeGreaterThan(60_000);
    expect(msgParseTimeoutMs(10 * 1024 ** 3)).toBe(120_000);
  });

  it("uses reasons without em dashes or spaced en dashes", async () => {
    const reasons = [
      await readMsg(Buffer.alloc(0)),
      await readMsg(fixture("outlook-contact.msg")),
      await readMsg(fixture("outlook-sticky-note.msg")),
    ].map((r) => (r as { reason: string }).reason);
    for (const reason of reasons) {
      expect(reason).not.toContain("—");
      expect(reason).not.toContain(" – ");
    }
  });
});
