import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import * as yauzl from "yauzl";
import {
  buildEml,
  buildMbox,
  buildMsg,
  buildRawZip,
  buildZip,
  escapeMboxrd,
  inputFileFromBuffer,
} from "./builders.js";

async function readZipNames(buffer: Buffer): Promise<string[]> {
  const zip = await yauzl.fromBufferPromise(buffer, { lazyEntries: true, decodeStrings: false });
  const names: string[] = [];
  for await (const entry of zip.eachEntry()) {
    names.push(
      yauzl.getFileNameLowLevel(
        entry.generalPurposeBitFlag,
        entry.fileNameRaw,
        entry.extraFields,
        false,
      ),
    );
  }
  return names;
}

describe("buildEml", () => {
  const options = {
    from: "Jürgen <j@example.test>",
    to: ["a@example.test", "Zoë <z@example.test>"],
    cc: "c@example.test",
    subject: "Größe",
    body: "Text\r\nmehr",
  };

  it("is byte-stable, CRLF only and parseable", async () => {
    const first = buildEml(options);
    expect(first.equals(buildEml(options))).toBe(true);
    expect(first.toString("latin1")).not.toMatch(/[^\r]\n/);
    const mail = await simpleParser(first);
    expect(mail.subject).toBe("Größe");
    expect(mail.from?.value[0]?.name).toBe("Jürgen");
    expect(first.toString()).toContain("Date: Mon, 15 Jan 2024 10:00:00 +0000\r\n");
    expect(first.toString()).toMatch(/Message-ID: <[0-9a-f]{16}@example\.test>/);
  });

  it("takes dates and ids as given, or omits them", () => {
    const given = buildEml({
      ...options,
      date: new Date("2024-02-03T04:05:06Z"),
      messageId: "<fixed@example.test>",
    });
    expect(given.toString()).toContain("Date: Sat, 03 Feb 2024 04:05:06 +0000\r\n");
    expect(given.toString()).toContain("Message-ID: <fixed@example.test>\r\n");
    const bare = buildEml({ ...options, date: null, messageId: null }).toString();
    expect(bare).not.toMatch(/^Date:/m);
    expect(bare).not.toMatch(/^Message-ID:/m);
  });

  it("builds html, inline and regular attachments and extra headers", async () => {
    const eml = buildEml({
      ...options,
      html: '<p>hi <img src="cid:x"></p>',
      attachments: [
        { filename: "a.txt", content: "abc" },
        { filename: "x.png", content: Buffer.from([1, 2, 3]), cid: "x", contentType: "image/png" },
      ],
      headers: [["X-Extra", "1"]],
    });
    const mail = await simpleParser(eml);
    expect(mail.html).toContain("<p>hi");
    expect(mail.attachments.map((a) => a.filename).sort()).toEqual(["a.txt", "x.png"]);
    expect(mail.headers.get("x-extra")).toBe("1");
  });
});

describe("buildMbox", () => {
  const a = buildEml({
    from: "a@example.test",
    to: "b@example.test",
    subject: "a",
    body: "From here\r\n",
  });

  it("keeps message bytes verbatim by default and uses each message's own line ending", () => {
    const mbox = buildMbox([a]).toString("latin1");
    expect(mbox.startsWith("From MAILER-DAEMON Mon Jan 15 10:00:00 2024\r\n")).toBe(true);
    expect(mbox.endsWith("\r\n\r\n")).toBe(true);
    const lf = buildMbox([Buffer.from("Subject: x\n\nbody\n")]).toString("latin1");
    expect(lf).toBe("From MAILER-DAEMON Mon Jan 15 10:00:00 2024\nSubject: x\n\nbody\n\n");
  });

  it("escapes with mboxrd rules and adds a missing final line break", () => {
    expect(escapeMboxrd("From a\n>From b\n>>From c\nFrom\nx From y\n")).toBe(
      ">From a\n>>From b\n>>>From c\nFrom\nx From y\n",
    );
    expect(buildMbox([Buffer.from("Subject: x\n\nFrom me")]).toString("latin1")).toContain(
      "\n\n>From me\n\n",
    );
  });

  it("converts the line endings on request and can omit the final blank line", () => {
    const converted = buildMbox([a], { eol: "\n" }).toString("latin1");
    expect(converted).not.toContain("\r");
    expect(
      buildMbox([a, a], { omitFinalBlank: true }).toString("latin1").endsWith("\r\n\r\n"),
    ).toBe(false);
  });

  it("can leave From lines unescaped and set the From line", () => {
    const raw = buildMbox([Buffer.from("Subject: x\n\nFrom me\n")], {
      noEscaping: true,
      fromLine: (i) => `test${i} x`,
    }).toString();
    expect(raw).toBe("From test0 x\nSubject: x\n\nFrom me\n\n");
  });
});

describe("buildZip and buildRawZip", () => {
  it("builds a byte-stable archive with directory entries", async () => {
    const entries = [
      { name: "dir/" },
      { name: "dir/a.txt", data: "a" },
      { name: "b.txt", data: Buffer.from("b"), store: true },
    ];
    const first = await buildZip(entries);
    expect(first.equals(await buildZip(entries))).toBe(true);
    expect(await readZipNames(first)).toEqual(["dir/", "dir/a.txt", "b.txt"]);
  });

  it("writes hostile names as they are, which archiver would not", async () => {
    const raw = buildRawZip([{ name: "../x" }, { name: "/abs" }, { name: "a\\b" }]);
    expect(await readZipNames(raw)).toEqual(["../x", "/abs", "a/b"]);
  });

  it("sets the flags it is told to", async () => {
    const zip = await yauzl.fromBufferPromise(
      buildRawZip([
        { name: "e", encrypted: true, data: "x" },
        { name: "s", method: 0, data: "yy" },
      ]),
      {
        lazyEntries: true,
      },
    );
    const entries = [];
    for await (const entry of zip.eachEntry()) {
      entries.push({
        encrypted: entry.isEncrypted(),
        method: entry.compressionMethod,
        size: entry.uncompressedSize,
      });
    }
    expect(entries).toEqual([
      { encrypted: true, method: 8, size: 1 },
      { encrypted: false, method: 0, size: 2 },
    ]);
  });
});

describe("buildMsg", () => {
  it("makes a compound file that can be patched (read flag, class)", async () => {
    const msg = await buildMsg({
      from: { address: "a@example.test" },
      to: [{ address: "b@example.test" }],
      subject: "s",
      body: "b",
      read: true,
      messageClass: "IPM.Contact",
    });
    expect(msg.subarray(0, 8).toString("hex")).toBe("d0cf11e0a1b11ae1");
  });
});

describe("inputFileFromBuffer", () => {
  const buffer = Buffer.from("0123456789");

  it("streams in the requested chunk size and reads ranges", async () => {
    const file = inputFileFromBuffer("dir/a.bin", buffer, { chunkSize: 3 });
    expect(file.path).toBe("dir/a.bin");
    expect(file.size).toBe(10);
    const chunks: string[] = [];
    for await (const chunk of file.open()) {
      chunks.push((chunk as Buffer).toString());
    }
    expect(chunks).toEqual(["012", "345", "678", "9"]);
    expect((await file.read(4, 3)).toString()).toBe("456");
    expect((await file.read(8, 10)).toString()).toBe("89");
    expect((await file.read(20, 10)).length).toBe(0);
    await expect(file.read(-1, 1)).rejects.toThrow(RangeError);
  });

  it("hands out copies, so a reader cannot change the source", async () => {
    const file = inputFileFromBuffer("a", Buffer.from("abc"));
    (await file.read(0, 3))[0] = 0x7a;
    expect((await file.read(0, 3)).toString()).toBe("abc");
  });
});
