import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImportFolder } from "./folder.js";
import {
  buildEml,
  buildMbox,
  buildMsg,
  buildRawZip,
  buildZip,
  inputFileFromBuffer,
} from "./testing/builders.js";
import type {
  MailInputFile,
  MailWalkEvent,
  MailWalkMessage,
  MailWalkProblem,
  WalkOptions,
} from "./types.js";
import {
  MAIL_INDEX_REASON,
  OS_METADATA_REASON,
  PST_NOT_SUPPORTED_REASON,
  walkMailFile,
} from "./walk.js";

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./testdata/${name}`, import.meta.url));

function eml(subject: string, extra: Partial<Parameters<typeof buildEml>[0]> = {}): Buffer {
  return buildEml({
    from: "Alice <alice@example.test>",
    to: "bob@example.test",
    subject,
    body: `Body of ${subject}\r\n`,
    ...extra,
  });
}

async function walk(file: MailInputFile, options: WalkOptions = {}): Promise<MailWalkEvent[]> {
  const events: MailWalkEvent[] = [];
  for await (const event of walkMailFile(file, options)) {
    events.push(event);
  }
  return events;
}

const at = (path: string, buffer: Buffer, chunkSize?: number): MailInputFile =>
  inputFileFromBuffer(path, buffer, chunkSize ? { chunkSize } : {});

function row(event: MailWalkEvent): string {
  switch (event.type) {
    case "folder":
      return `folder:${event.path.join("/")}`;
    case "message":
      return `message#${event.index}:${event.folder.join("/")}:${event.sourceName}:${event.format}`;
    case "problem":
      return `problem#${event.index}:${event.code}:${event.ref}`;
  }
}

const rows = (events: MailWalkEvent[]): string[] => events.map(row);
const messages = (events: MailWalkEvent[]): MailWalkMessage[] =>
  events.filter((e): e is MailWalkMessage => e.type === "message");
const problems = (events: MailWalkEvent[]): MailWalkProblem[] =>
  events.filter((e): e is MailWalkProblem => e.type === "problem");

/** A comparable, printable form of an event (buffers become hashes). */
function plain(event: MailWalkEvent): unknown {
  if (event.type === "message") {
    return {
      ...event,
      raw: createHash("sha256").update(event.raw).digest("hex"),
      internalDate: event.internalDate?.toISOString() ?? null,
    };
  }
  return event;
}

/**
 * The resume contract: skipping n items and continuing yields exactly the events
 * of a full pass that come after its first n items.
 */
async function expectResumeEquivalence(
  file: MailInputFile,
  options: WalkOptions = {},
): Promise<number> {
  const full = await walk(file, options);
  const itemPositions = full.flatMap((event, position) =>
    event.type === "folder" ? [] : [position],
  );
  expect(itemPositions.length).toBeGreaterThan(1);
  // Items are numbered 0..n-1 in order.
  full
    .filter((e) => e.type !== "folder")
    .forEach((event, i) => {
      expect((event as MailWalkMessage | MailWalkProblem).index).toBe(i);
    });
  for (let n = 0; n <= itemPositions.length + 1; n++) {
    const resumed = await walk(file, { ...options, skipItems: n });
    const cut = n === 0 ? 0 : (itemPositions[Math.min(n, itemPositions.length) - 1] as number) + 1;
    expect(resumed.map(plain), `skipItems ${n}`).toEqual(full.slice(cut).map(plain));
  }
  return itemPositions.length;
}

describe("walkMailFile: single files", () => {
  it("walks an EML file: verbatim bytes, folder Imported", async () => {
    const raw = eml("plain");
    const events = await walk(at("a.eml", raw));
    expect(rows(events)).toEqual(["message#0:Imported:a.eml:eml"]);
    const message = events[0] as MailWalkMessage;
    expect(message.raw.equals(raw)).toBe(true);
    expect(message.synthesized).toBe(false);
    expect(message.ref).toBe("a.eml");
    expect(message.sourceBytes).toBe(raw.length);
    expect(message.flags).toEqual([]);
  });

  it("decides by content, not by name", async () => {
    expect(rows(await walk(at("mail.txt", eml("x"))))).toEqual(["message#0:Imported:mail.txt:eml"]);
    expect(rows(await walk(at("mail.eml", buildMbox([eml("x")]))))).toEqual([
      "folder:Imported",
      "message#0:Imported:mail.eml#1:mbox",
    ]);
    const notMail = await walk(at("mail.eml", Buffer.from("this is not an email\nat all\n")));
    expect(rows(notMail)).toEqual(["problem#0:not_mail:mail.eml"]);
  });

  it("strips a UTF-8 byte order mark from an EML file", async () => {
    const raw = eml("bom");
    const message = messages(
      await walk(at("bom.eml", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]))),
    )[0];
    expect(message?.raw.equals(raw)).toBe(true);
  });

  it("reads flags and the received date from the message headers", async () => {
    const raw = eml("flags", {
      headers: [
        ["Received", "from mx.example.test by mail.example.test; Tue, 16 Jan 2024 08:30:00 +0100"],
        ["X-Mozilla-Status", "0003"],
      ],
    });
    const message = messages(await walk(at("flags.eml", raw)))[0];
    expect(message?.flags).toEqual(["\\Seen", "\\Answered"]);
    expect(message?.internalDate?.toISOString()).toBe("2024-01-16T07:30:00.000Z");
  });

  it("falls back to the Date header for the internal date", async () => {
    const message = messages(
      await walk(at("d.eml", eml("dated", { date: "Mon, 15 Jan 2024 10:00:00 +0000" }))),
    )[0];
    expect(message?.internalDate?.toISOString()).toBe("2024-01-15T10:00:00.000Z");
  });

  it("walks an MSG file: synthesized, folder Imported, flags from the MSG", async () => {
    const msg = await buildMsg({
      from: { address: "alice@example.test", name: "Alice" },
      to: [{ address: "bob@example.test" }],
      subject: "from msg",
      body: "hello",
      read: true,
    });
    const events = await walk(at("m.msg", msg));
    expect(rows(events)).toEqual(["message#0:Imported:m.msg:msg"]);
    const message = events[0] as MailWalkMessage;
    expect(message.synthesized).toBe(true);
    expect(message.flags).toEqual(["\\Seen"]);
    expect(message.raw.toString("utf8")).toContain("Subject: from msg");
    expect(message.sourceBytes).toBe(msg.length);
  });

  it("reports an Outlook contact as not_mail", async () => {
    const events = await walk(at("contact.msg", fixture("outlook-contact.msg")));
    expect(rows(events)).toEqual(["problem#0:not_mail:contact.msg"]);
    expect(problems(events)[0]?.format).toBe("msg");
    expect(problems(events)[0]?.reason).toContain("contact");
  });

  it("reports a damaged MSG as unreadable", async () => {
    const events = await walk(
      at("bad.msg", fixture("outlook-attachment-inline.msg").subarray(0, 3000)),
    );
    expect(rows(events)).toEqual(["problem#0:unreadable:bad.msg"]);
  });
});

describe("walkMailFile: problems", () => {
  it("gives a PST file exactly one pst_not_supported problem, whatever follows the magic", async () => {
    const pst = Buffer.concat([Buffer.from("!BDN"), Buffer.alloc(100_000, 0x11)]);
    const events = await walk(at("Outlook Data.pst", pst));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "problem",
      ref: "Outlook Data.pst",
      index: 0,
      code: "pst_not_supported",
      reason: PST_NOT_SUPPORTED_REASON,
      format: "pst",
    });
    expect(PST_NOT_SUPPORTED_REASON).toBe(
      "PST and OST import is planned for a later release. Export the mailbox from Outlook as .msg or .eml files (or convert it to MBOX) and import those.",
    );
    // The name is irrelevant.
    expect(rows(await walk(at("archive.eml", pst)))).toEqual([
      "problem#0:pst_not_supported:archive.eml",
    ]);
  });

  it("never reads a PST beyond its head", async () => {
    let bytesRead = 0;
    const file: MailInputFile = {
      path: "big.ost",
      size: 40 * 1024 ** 3,
      open() {
        throw new Error("a PST must not be streamed");
      },
      async read(_offset, length) {
        bytesRead += length;
        return Buffer.concat([Buffer.from("!BDN"), Buffer.alloc(Math.min(length, 100_000) - 4)]);
      },
    };
    expect(rows(await walk(file))).toEqual(["problem#0:pst_not_supported:big.ost"]);
    expect(bytesRead).toBeLessThanOrEqual(64 * 1024);
  });

  it("reports unknown content as not_mail and empty files as empty", async () => {
    expect(rows(await walk(at("notes.txt", Buffer.from("just some notes\n"))))).toEqual([
      "problem#0:not_mail:notes.txt",
    ]);
    expect(
      rows(
        await walk(
          at("image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])),
        ),
      ),
    ).toEqual(["problem#0:not_mail:image.png"]);
    const empty = await walk(at("empty.eml", Buffer.alloc(0)));
    expect(rows(empty)).toEqual(["problem#0:empty:empty.eml"]);
  });

  it("names other archive formats and Apple Mail emlx files as unsupported", async () => {
    const gz = await walk(
      at("mail.tar.gz", Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3, 1, 2])),
    );
    expect(rows(gz)).toEqual(["problem#0:unsupported:mail.tar.gz"]);
    expect(problems(gz)[0]?.reason).toContain("gzip");
    const emlx = await walk(
      at("1234.emlx", Buffer.from("1234\nFrom: a@example.test\nSubject: x\n\nbody\n")),
    );
    expect(rows(emlx)).toEqual(["problem#0:unsupported:1234.emlx"]);
    expect(problems(emlx)[0]?.reason).toContain("emlx");
  });

  it("reports a message above the size limit as too_large without reading it", async () => {
    const big = eml("big", { body: `${"x".repeat(5000)}\r\n` });
    let opened = 0;
    const file = at("big.eml", big);
    const counting: MailInputFile = {
      ...file,
      open: () => {
        opened++;
        return file.open();
      },
    };
    const events = await walk(counting, { limits: { maxMessageBytes: 1000 } });
    expect(rows(events)).toEqual(["problem#0:too_large:big.eml"]);
    expect(opened).toBe(0);
    const msg = await walk(at("big.msg", fixture("outlook-attachments-headers.msg")), {
      limits: { maxMessageBytes: 1000 },
    });
    expect(rows(msg)).toEqual(["problem#0:too_large:big.msg"]);
  });

  it("reports an EML that ends earlier than the file says as unreadable", async () => {
    const raw = eml("short");
    const file = at("short.eml", raw);
    const lying: MailInputFile = { ...file, size: raw.length + 100 };
    expect(rows(await walk(lying))).toEqual(["problem#0:unreadable:short.eml"]);
  });

  it("turns read errors into unreadable problems without leaking the error", async () => {
    const raw = eml("x");
    const failingRead: MailInputFile = {
      path: "a.eml",
      size: raw.length,
      open: () => Readable.from([raw]),
      async read() {
        throw new Error("segment 4 is missing from s3://internal-bucket/key");
      },
    };
    const events = await walk(failingRead);
    expect(rows(events)).toEqual(["problem#0:unreadable:a.eml"]);
    expect(problems(events)[0]?.reason).not.toContain("internal-bucket");
    const failingOpen: MailInputFile = {
      ...at("b.eml", raw),
      open: () =>
        new Readable({
          read() {
            this.destroy(new Error("boom internal-bucket"));
          },
        }),
    };
    const opened = await walk(failingOpen);
    expect(rows(opened)).toEqual(["problem#0:unreadable:b.eml"]);
    expect(problems(opened)[0]?.reason).not.toContain("internal-bucket");
  });

  it("uses reasons without em dashes or spaced en dashes", async () => {
    const samples = [
      ...(await walk(at("a.pst", Buffer.from("!BDN....")))),
      ...(await walk(at("a.txt", Buffer.from("text\n")))),
      ...(await walk(at("a.eml", Buffer.alloc(0)))),
      ...(await walk(at("a.gz", Buffer.from([0x1f, 0x8b, 0x08, 0, 0])))),
      ...(await walk(at("c.msg", fixture("outlook-contact.msg")))),
      ...(await walk(at("z.zip", buildRawZip([{ name: "e.eml", data: "x", encrypted: true }])))),
    ];
    expect(problems(samples).length).toBeGreaterThanOrEqual(6);
    for (const p of problems(samples)) {
      expect(p.reason).not.toContain("—");
      expect(p.reason).not.toContain(" – ");
    }
  });

  it("throws an AbortError when aborted, and only then", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(walk(at("a.eml", eml("x")), { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
      message: "aborted",
    });
    const zip = await buildZip([
      { name: "a.eml", data: eml("1") },
      { name: "b.eml", data: eml("2") },
    ]);
    const mid = new AbortController();
    const iterator = walkMailFile(at("a.zip", zip), { signal: mid.signal });
    await iterator.next();
    mid.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("walkMailFile: MBOX", () => {
  const mails = [eml("one"), eml("two", { body: "From here\r\n" }), eml("three")];

  it("maps files to folders: x.mbox, extensionless names, directories", async () => {
    const file = buildMbox(mails, { eol: "\n" });
    const firstFolder = async (path: string): Promise<string> =>
      (rows(await walk(at(path, file)))[0] as string).replace(/^folder:/, "");
    expect(await firstFolder("x.mbox")).toBe("x");
    expect(await firstFolder("Inbox")).toBe("Inbox");
    expect(await firstFolder("Sent Items.MBOX")).toBe("Sent Items");
    expect(await firstFolder("old.mbx")).toBe("old");
    expect(await firstFolder("dir/x.mbox")).toBe("dir/x");
    expect(await firstFolder("a/b/Inbox")).toBe("a/b/Inbox");
    expect(await firstFolder("Archive/2019/inbox.mbox")).toBe("Archive/2019/inbox");
  });

  it("strips .sbd from Thunderbird directories", async () => {
    const file = buildMbox([mails[0] as Buffer]);
    const folderOf = async (path: string): Promise<string> =>
      (rows(await walk(at(path, file)))[0] as string).replace(/^folder:/, "");
    expect(await folderOf("Mail/Local Folders/Inbox.sbd/Projects")).toBe(
      "Mail/Local Folders/Inbox/Projects",
    );
    expect(await folderOf("Inbox.sbd/Sub.sbd/Deep")).toBe("Inbox/Sub/Deep");
    expect(await folderOf("Inbox.SBD/Sub")).toBe("Inbox/Sub");
    expect(await folderOf("Inbox")).toBe("Inbox");
  });

  it("maps Apple Mail's X.mbox/mbox to the folder X", async () => {
    const file = buildMbox([mails[0] as Buffer]);
    const folderOf = async (path: string): Promise<string> =>
      (rows(await walk(at(path, file)))[0] as string).replace(/^folder:/, "");
    expect(await folderOf("Work.mbox/mbox")).toBe("Work");
    expect(await folderOf("On My Mac.mbox/Clients.mbox/mbox")).toBe("On My Mac/Clients");
    expect(await folderOf("Export/Work.mbox/mbox")).toBe("Export/Work");
    // A file that is merely called "mbox" in an ordinary directory keeps its name.
    expect(await folderOf("dir/mbox")).toBe("dir/mbox");
    expect(await folderOf("mbox")).toBe("mbox");
  });

  it("gives a folder event first, then one message per mbox message with refs and numbering", async () => {
    const events = await walk(at("Inbox.mbox", buildMbox(mails, { eol: "\r\n" })));
    expect(rows(events)).toEqual([
      "folder:Inbox",
      "message#0:Inbox:Inbox.mbox#1:mbox",
      "message#1:Inbox:Inbox.mbox#2:mbox",
      "message#2:Inbox:Inbox.mbox#3:mbox",
    ]);
    const list = messages(events);
    expect(list.map((m) => m.ref)).toEqual(["Inbox.mbox#1", "Inbox.mbox#2", "Inbox.mbox#3"]);
    list.forEach((m, i) => {
      expect(m.raw.equals(mails[i] as Buffer)).toBe(true);
      expect(m.synthesized).toBe(false);
    });
    expect(list.reduce((sum, m) => sum + m.sourceBytes, 0)).toBe(
      buildMbox(mails, { eol: "\r\n" }).length,
    );
  });

  it("keeps an empty mailbox as an (empty) folder", async () => {
    // A From_ line with an empty message: one problem, the folder still exists.
    const events = await walk(
      at("Sent.mbox", Buffer.from("From x Mon Jan  1 00:00:00 2024\nSubject: only header\n\n")),
    );
    expect(rows(events)[0]).toBe("folder:Sent");
  });

  it("mixes messages and problems in file order with contiguous numbering", async () => {
    const big = eml("big", { body: `${"y".repeat(3000)}\r\n` });
    const file = Buffer.concat([
      buildMbox([mails[0] as Buffer], { eol: "\n" }),
      Buffer.from("From nobody Mon Jan  1 00:00:00 2024\n\n"),
      buildMbox([big, mails[2] as Buffer], { eol: "\n" }),
    ]);
    const events = await walk(at("m.mbox", file, 50), { limits: { maxMessageBytes: 1500 } });
    expect(rows(events)).toEqual([
      "folder:m",
      "message#0:m:m.mbox#1:mbox",
      "problem#1:empty:m.mbox#2",
      "problem#2:too_large:m.mbox#3",
      "message#3:m:m.mbox#4:mbox",
    ]);
  });

  it("treats a Thunderbird single message saved as .eml (From - line) like an EML", async () => {
    const raw = Buffer.from(
      `From - Thu Sep 30 12:00:00 2021\r\nX-Mozilla-Status: 0001\r\n${eml("saved").toString("latin1")}`,
      "latin1",
    );
    const events = await walk(at("Projects/saved.eml", raw));
    expect(rows(events)).toEqual(["folder:Projects", "message#0:Projects:saved.eml#1:mbox"]);
    expect(messages(events)[0]?.flags).toEqual(["\\Seen"]);
    expect(messages(events)[0]?.internalDate?.toISOString()).toBe("2021-09-30T12:00:00.000Z");
  });

  it("takes flags and dates from the mbox headers and From_ lines", async () => {
    const withStatus = eml("st", {
      headers: [
        ["Status", "RO"],
        ["X-Status", "AF"],
      ],
    });
    const file = buildMbox([withStatus], {
      fromLine: () => "MAILER-DAEMON Fri Jul  8 12:08:34 2011",
    });
    const message = messages(await walk(at("Inbox", file)))[0];
    expect(message?.flags).toEqual(["\\Seen", "\\Answered", "\\Flagged"]);
    expect(message?.internalDate?.toISOString()).toBe("2011-07-08T12:08:34.000Z");
  });

  it("reports a stream that breaks in the middle once, at the place where it broke", async () => {
    const file = buildMbox(mails, { eol: "\n" });
    let delivered = 0;
    const breaking: MailInputFile = {
      ...at("broken.mbox", file),
      open: () =>
        new Readable({
          read() {
            if (delivered === 0) {
              delivered = 1;
              this.push(file.subarray(0, Math.floor(file.length * 0.6)));
            } else {
              this.destroy(new Error("storage exploded internal-detail"));
            }
          },
        }),
    };
    const events = await walk(breaking);
    const last = problems(events).at(-1);
    expect(last?.code).toBe("unreadable");
    expect(last?.reason).not.toContain("internal-detail");
    expect(problems(events)).toHaveLength(1);
    expect(messages(events).length).toBeGreaterThanOrEqual(1);
  });

  it("streams: a huge mbox is never read with read() beyond its head", async () => {
    const message = eml("bulk");
    const one = buildMbox([message], { eol: "\n" });
    const count = 20_000;
    let reads = 0;
    let readBytes = 0;
    const file: MailInputFile = {
      path: "huge.mbox",
      size: one.length * count,
      open: () =>
        Readable.from(
          (function* () {
            for (let i = 0; i < count; i++) {
              yield one;
            }
          })(),
          { objectMode: false },
        ),
      async read(_offset, length) {
        reads++;
        readBytes += length;
        return one.subarray(0, Math.min(length, one.length));
      },
    };
    let seen = 0;
    for await (const event of walkMailFile(file)) {
      if (event.type === "message") {
        seen++;
      }
    }
    expect(seen).toBe(count);
    expect(reads).toBe(1);
    expect(readBytes).toBeLessThanOrEqual(64 * 1024);
  }, 60_000);

  it("resumes: a full pass equals the first n items plus a resumed pass", async () => {
    const big = eml("big", { body: `${"y".repeat(3000)}\r\n` });
    const file = Buffer.concat([
      buildMbox([mails[0] as Buffer, mails[1] as Buffer], { eol: "\n" }),
      Buffer.from("From nobody Mon Jan  1 00:00:00 2024\n\n"),
      buildMbox([big, mails[2] as Buffer, eml("five", { headers: [["Status", "RO"]] })], {
        eol: "\n",
      }),
    ]);
    const count = await expectResumeEquivalence(at("r.mbox", file, 33), {
      limits: { maxMessageBytes: 1500 },
    });
    expect(count).toBe(6);
  }, 60_000);
});

describe("walkMailFile: ZIP", () => {
  const a = eml("a");
  const b = eml("b");
  const c = eml("c");

  it("maps entry paths to folders and root-level entries to the zip's base name", async () => {
    const zip = await buildZip([
      { name: "Inbox/a.eml", data: a },
      { name: "Inbox/2019/b.eml", data: b },
      { name: "root.eml", data: c },
    ]);
    const events = await walk(at("export.zip", zip));
    expect(rows(events)).toEqual([
      "message#0:Inbox:a.eml:eml",
      "message#1:Inbox/2019:b.eml:eml",
      "message#2:export:root.eml:eml",
    ]);
    expect(messages(events).map((m) => m.ref)).toEqual([
      "export.zip!Inbox/a.eml",
      "export.zip!Inbox/2019/b.eml",
      "export.zip!root.eml",
    ]);
    expect(messages(events)[0]?.raw.equals(a)).toBe(true);
    expect(messages(events)[0]?.sourceBytes).toBe(a.length);
  });

  it("puts the directories of the zip file's own path in front", async () => {
    const zip = await buildZip([
      { name: "Inbox/a.eml", data: a },
      { name: "root.eml", data: c },
      { name: "Empty/" },
    ]);
    const events = await walk(at("Archive/2019/export.zip", zip));
    expect(rows(events)).toEqual([
      "message#0:Archive/2019/Inbox:a.eml:eml",
      "message#1:Archive/2019/export:root.eml:eml",
      "folder:Archive/2019/Empty",
    ]);
  });

  it("keeps empty directories as folder events and applies the .sbd and .mbox rules", async () => {
    const zip = await buildZip([
      { name: "Empty/" },
      { name: "Inbox.sbd/" },
      { name: "Inbox.sbd/Sub" + "/" },
      { name: "Work.mbox/" },
      { name: "Inbox.sbd/x.eml", data: a },
    ]);
    const events = await walk(at("t.zip", zip));
    expect(rows(events)).toEqual([
      "folder:Empty",
      "folder:Inbox",
      "folder:Inbox/Sub",
      "folder:Work",
      "message#0:Inbox:x.eml:eml",
    ]);
  });

  it("reads MBOX, MSG and EML entries in central directory order with contiguous numbering", async () => {
    const msg = await buildMsg({
      from: { address: "alice@example.test" },
      to: [{ address: "bob@example.test" }],
      subject: "msg in zip",
      body: "b",
    });
    const zip = await buildZip([
      { name: "z.eml", data: a },
      { name: "Thunderbird/Inbox", data: buildMbox([b, c], { eol: "\n" }) },
      { name: "Outlook/one.msg", data: msg },
      { name: "Apple/Work.mbox/mbox", data: buildMbox([a], { eol: "\n" }) },
    ]);
    const events = await walk(at("mixed.zip", zip));
    expect(rows(events)).toEqual([
      "message#0:mixed:z.eml:eml",
      "folder:Thunderbird/Inbox",
      "message#1:Thunderbird/Inbox:Inbox#1:mbox",
      "message#2:Thunderbird/Inbox:Inbox#2:mbox",
      "message#3:Outlook:one.msg:msg",
      "folder:Apple/Work",
      "message#4:Apple/Work:mbox#1:mbox",
    ]);
    expect(messages(events).map((m) => m.ref)).toEqual([
      "mixed.zip!z.eml",
      "mixed.zip!Thunderbird/Inbox#1",
      "mixed.zip!Thunderbird/Inbox#2",
      "mixed.zip!Outlook/one.msg",
      "mixed.zip!Apple/Work.mbox/mbox#1",
    ]);
    expect(messages(events)[3]?.synthesized).toBe(true);
  });

  it("sanitises hostile entry names into safe folders", async () => {
    const zip = buildRawZip([
      { name: "../../evil.eml", data: a },
      { name: "/abs/dir/x.eml", data: b },
      { name: "win\\dir\\y.eml", data: c },
    ]);
    const events = await walk(at("hostile.zip", zip));
    expect(rows(events)).toEqual([
      "message#0:hostile:evil.eml:eml",
      "message#1:abs/dir:x.eml:eml",
      "message#2:win/dir:y.eml:eml",
    ]);
    for (const message of messages(events)) {
      expect(
        message.folder.some((part) => part === ".." || part.includes("/") || part.includes("\\")),
      ).toBe(false);
    }
  });

  it("reports nested archives as unsupported, PST and unknown entries by their own codes", async () => {
    const inner = await buildZip([{ name: "in.eml", data: a }]);
    const zip = await buildZip([
      { name: "inner.zip", data: inner },
      { name: "Outlook/data.pst", data: Buffer.concat([Buffer.from("!BDN"), Buffer.alloc(200)]) },
      { name: "readme.txt", data: "hello\n" },
      {
        name: "photo.png",
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
      },
      { name: "empty.eml", data: "" },
      { name: "backup.tar.gz", data: Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3, 1]) },
      { name: "ok.eml", data: b },
    ]);
    const events = await walk(at("all.zip", zip));
    expect(rows(events)).toEqual([
      "problem#0:unsupported:all.zip!inner.zip",
      "problem#1:pst_not_supported:all.zip!Outlook/data.pst",
      "problem#2:not_mail:all.zip!readme.txt",
      "problem#3:not_mail:all.zip!photo.png",
      "problem#4:empty:all.zip!empty.eml",
      "problem#5:unsupported:all.zip!backup.tar.gz",
      "message#6:all:ok.eml:eml",
    ]);
    expect(problems(events)[0]?.reason).toContain("Nested ZIP");
    expect(problems(events)[1]?.reason).toBe(PST_NOT_SUPPORTED_REASON);
    expect(problems(events)[0]?.format).toBe("zip");
  });

  it("reports operating system and mail program leftovers as not_mail, never silently", async () => {
    const zip = await buildZip([
      { name: "__MACOSX/" },
      {
        name: "__MACOSX/._a.eml",
        data: Buffer.from([0x00, 0x05, 0x16, 0x07, 0, 2, 0, 0, 0x4d, 0x61, 0x63]),
      },
      { name: ".DS_Store", data: Buffer.from([0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31]) },
      { name: "Thumbs.db", data: Buffer.from(`d0cf11e0a1b11ae1${"00".repeat(100)}`, "hex") },
      { name: "desktop.ini", data: "[.ShellClassInfo]\r\n" },
      { name: "Inbox/._b.eml", data: Buffer.from([0x00, 0x05, 0x16, 0x07, 0, 2, 0, 0]) },
      { name: "Inbox/Inbox.msf", data: '// <!-- <mdb:mork:z v="1.4"/> -->\n' },
      { name: "Inbox/b.eml", data: b },
    ]);
    const events = await walk(at("junk.zip", zip));
    expect(rows(events)).toEqual([
      "problem#0:not_mail:junk.zip!__MACOSX/._a.eml",
      "problem#1:not_mail:junk.zip!.DS_Store",
      "problem#2:not_mail:junk.zip!Thumbs.db",
      "problem#3:not_mail:junk.zip!desktop.ini",
      "problem#4:not_mail:junk.zip!Inbox/._b.eml",
      "problem#5:not_mail:junk.zip!Inbox/Inbox.msf",
      "message#6:Inbox:b.eml:eml",
    ]);
    expect(
      problems(events)
        .slice(0, 5)
        .map((p) => p.reason),
    ).toEqual(Array(5).fill(OS_METADATA_REASON));
    expect(problems(events)[5]?.reason).toBe(MAIL_INDEX_REASON);
    // The empty __MACOSX directory makes no folder.
    expect(events.some((e) => e.type === "folder")).toBe(false);
    // ._x that is not an AppleDouble file is just an unknown file.
    const other = await walk(
      at("j.zip", await buildZip([{ name: "._real.txt", data: "not apple double\n" }])),
    );
    expect(rows(other)).toEqual(["problem#0:not_mail:j.zip!._real.txt"]);
    expect(problems(other)[0]?.reason).not.toBe(OS_METADATA_REASON);
    // Top-level files get the same treatment.
    expect(rows(await walk(at("Photos/.DS_Store", Buffer.from("Bud1"))))).toEqual([
      "problem#0:not_mail:.DS_Store",
    ]);
  });

  it("reports encrypted entries and carries on", async () => {
    const zip = buildRawZip([
      { name: "secret.eml", data: "cipher", encrypted: true },
      { name: "plain.eml", data: a },
    ]);
    const events = await walk(at("enc.zip", zip));
    expect(rows(events)).toEqual([
      "problem#0:unsupported:enc.zip!secret.eml",
      "message#1:enc:plain.eml:eml",
    ]);
    expect(problems(events)[0]?.reason).toMatch(/password/);
  });

  it("applies the zip limits", async () => {
    const zip = await buildZip([
      { name: "a.eml", data: a },
      { name: "b.eml", data: b },
      { name: "c.eml", data: c },
    ]);
    expect(rows(await walk(at("many.zip", zip), { limits: { maxZipEntries: 2 } }))).toEqual([
      "problem#0:limit:many.zip",
    ]);
    const expanded = await walk(at("big.zip", zip), {
      limits: { maxZipExpandedBytes: a.length + b.length + 10 },
    });
    expect(rows(expanded)).toEqual([
      "message#0:big:a.eml:eml",
      "message#1:big:b.eml:eml",
      "problem#2:limit:big.zip!c.eml",
    ]);
    const bomb = buildRawZip([
      { name: "bomb.eml", data: "x", declaredSize: 4_000_000_000 },
      { name: "ok.eml", data: a },
    ]);
    expect(rows(await walk(at("bomb.zip", bomb)))).toEqual([
      "problem#0:limit:bomb.zip!bomb.eml",
      "message#1:bomb:ok.eml:eml",
    ]);
  });

  it("applies the per-message limit to EML and MSG entries but not to a mailbox entry", async () => {
    const big = eml("big", { body: `${"z".repeat(4000)}\r\n` });
    const bigMbox = buildMbox([a, b, c], { eol: "\n" });
    const zip = await buildZip([
      { name: "big.eml", data: big, store: true },
      { name: "Inbox", data: bigMbox, store: true },
    ]);
    const events = await walk(at("lim.zip", zip), { limits: { maxMessageBytes: 1500 } });
    expect(rows(events)).toEqual([
      "problem#0:too_large:lim.zip!big.eml",
      "folder:Inbox",
      "message#1:Inbox:Inbox#1:mbox",
      "message#2:Inbox:Inbox#2:mbox",
      "message#3:Inbox:Inbox#3:mbox",
    ]);
  });

  it("reports damaged archives as unreadable, never throws", async () => {
    const zip = await buildZip([
      { name: "a.eml", data: a },
      { name: "b.eml", data: "y".repeat(3000) },
    ]);
    for (const cut of [8, 60, zip.length - 20]) {
      const events = await walk(at("cut.zip", zip.subarray(0, cut)));
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.type === "problem" && e.code === "unreadable")).toBe(true);
    }
    const garbage = await walk(
      at("g.zip", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(500, 3)])),
    );
    expect(rows(garbage)).toEqual(["problem#0:unreadable:g.zip"]);
    expect(problems(garbage)[0]?.format).toBe("zip");
  });

  it("reads an Office document as a ZIP without mail as many not_mail problems, not as a crash", async () => {
    const docx = await buildZip([
      { name: "[Content_Types].xml", data: "<?xml version='1.0'?><Types/>" },
      { name: "word/document.xml", data: "<w:document/>" },
    ]);
    const events = await walk(at("letter.docx", docx));
    expect(rows(events)).toEqual([
      "problem#0:not_mail:letter.docx![Content_Types].xml",
      "problem#1:not_mail:letter.docx!word/document.xml",
    ]);
  });

  it("resumes: a full pass equals the first n items plus a resumed pass", async () => {
    const msg = await buildMsg({
      from: { address: "alice@example.test" },
      to: [{ address: "bob@example.test" }],
      subject: "resume",
      body: "b",
      sentOn: new Date("2024-01-15T10:00:00Z"),
    });
    const zip = await buildZip([
      { name: "First/" },
      { name: "First/a.eml", data: a },
      { name: "Empty/" },
      { name: "Box/Inbox", data: buildMbox([a, b, c], { eol: "\n" }) },
      { name: "readme.txt", data: "no mail\n" },
      { name: "Outlook/" },
      { name: "Outlook/x.msg", data: msg },
      { name: "Trailing/" },
      { name: "z.eml", data: c },
    ]);
    const count = await expectResumeEquivalence(at("resume.zip", zip));
    expect(count).toBe(7);
    // The full pass contains folders between and after the items.
    const full = await walk(at("resume.zip", zip));
    expect(full.filter((e) => e.type === "folder").length).toBeGreaterThanOrEqual(5);
  }, 60_000);

  it("resumes without reading skipped MSG or EML entries beyond their head", async () => {
    const msg = await buildMsg({
      from: { address: "alice@example.test" },
      to: [{ address: "bob@example.test" }],
      subject: "skip me",
      body: "b",
    });
    const zip = await buildZip([
      { name: "1.msg", data: msg },
      { name: "2.eml", data: a },
      { name: "3.eml", data: b },
    ]);
    const source = at("skip.zip", zip);
    let reads = 0;
    const counting: MailInputFile = {
      ...source,
      read: async (offset, length) => {
        reads++;
        return source.read(offset, length);
      },
    };
    const skipped = await walk(counting, { skipItems: 2 });
    expect(rows(skipped)).toEqual(["message#2:skip:3.eml:eml"]);
    // A parsed MSG would be read whole; skipping it costs a header read only.
    const full = reads;
    reads = 0;
    await walk(counting);
    expect(full).toBeLessThanOrEqual(reads);
  });
});

describe("walkMailFile: folder-like inputs", () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "restow-walk-"));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  /** What the import engine does with a directory: walk it, then every file with its relative path. */
  async function walkTree(
    root: string,
    relative: string,
    skipPerFile?: Map<string, number>,
  ): Promise<string[]> {
    const folder = new ImportFolder(root);
    const result: string[] = [];
    for await (const entry of folder.walk(relative)) {
      if (entry.kind === "dir") {
        result.push(`dir:${entry.path}`);
        continue;
      }
      for await (const event of walkMailFile(entry.file, {
        skipItems: skipPerFile?.get(entry.file.path) ?? 0,
      })) {
        result.push(`${entry.file.path} -> ${row(event)}`);
      }
    }
    return result;
  }

  it("walks a MailStore style export tree, a Thunderbird profile and stray files", async () => {
    const root = join(base, "import");
    await mkdir(join(root, "Export", "Inbox", "2019"), { recursive: true });
    await mkdir(join(root, "Export", "Empty"), { recursive: true });
    await mkdir(join(root, "Profile", "Mail", "Inbox.sbd"), { recursive: true });
    await writeFile(join(root, "Export", "Inbox", "1.eml"), eml("1"));
    await writeFile(join(root, "Export", "Inbox", "2019", "2.eml"), eml("2"));
    await writeFile(join(root, "Export", "top.eml"), eml("top"));
    await writeFile(
      join(root, "Profile", "Mail", "Inbox"),
      buildMbox([eml("t1"), eml("t2")], { eol: "\n" }),
    );
    await writeFile(
      join(root, "Profile", "Mail", "Inbox.msf"),
      '// <!-- <mdb:mork:z v="1.4"/> -->\n',
    );
    await writeFile(
      join(root, "Profile", "Mail", "Inbox.sbd", "Projects"),
      buildMbox([eml("p1")], { eol: "\n" }),
    );
    await writeFile(
      join(root, "Profile", "Mail", "Inbox.sbd", "Projects.msf"),
      '// <!-- <mdb:mork:z v="1.4"/> -->\n',
    );
    await writeFile(join(root, "notes.txt"), "hello\n");
    const lines = await walkTree(root, "");
    expect(lines).toEqual([
      "dir:Export",
      "dir:Export/Empty",
      "dir:Export/Inbox",
      "Export/Inbox/1.eml -> message#0:Export/Inbox:1.eml:eml",
      "dir:Export/Inbox/2019",
      "Export/Inbox/2019/2.eml -> message#0:Export/Inbox/2019:2.eml:eml",
      "Export/top.eml -> message#0:Export:top.eml:eml",
      "dir:Profile",
      "dir:Profile/Mail",
      "Profile/Mail/Inbox -> folder:Profile/Mail/Inbox",
      "Profile/Mail/Inbox -> message#0:Profile/Mail/Inbox:Inbox#1:mbox",
      "Profile/Mail/Inbox -> message#1:Profile/Mail/Inbox:Inbox#2:mbox",
      "Profile/Mail/Inbox.msf -> problem#0:not_mail:Inbox.msf",
      "dir:Profile/Mail/Inbox.sbd",
      "Profile/Mail/Inbox.sbd/Projects -> folder:Profile/Mail/Inbox/Projects",
      "Profile/Mail/Inbox.sbd/Projects -> message#0:Profile/Mail/Inbox/Projects:Projects#1:mbox",
      "Profile/Mail/Inbox.sbd/Projects.msf -> problem#0:not_mail:Projects.msf",
      "notes.txt -> problem#0:not_mail:notes.txt",
    ]);
  });

  it("makes paths relative to the chosen directory", async () => {
    const root = join(base, "import");
    await mkdir(join(root, "Mail", "Inbox"), { recursive: true });
    await writeFile(join(root, "Mail", "Inbox", "1.eml"), eml("1"));
    await writeFile(join(root, "Mail", "0.eml"), eml("0"));
    expect(await walkTree(root, "Mail")).toEqual([
      "0.eml -> message#0:Imported:0.eml:eml",
      "dir:Inbox",
      "Inbox/1.eml -> message#0:Inbox:1.eml:eml",
    ]);
  });

  it("resumes file by file: full pass equals the first n items plus a resumed pass", async () => {
    const root = join(base, "import");
    await mkdir(join(root, "A"), { recursive: true });
    await writeFile(
      join(root, "A", "one.mbox"),
      buildMbox([eml("1"), eml("2"), eml("3")], { eol: "\n" }),
    );
    await writeFile(join(root, "A", "two.eml"), eml("two"));
    await writeFile(join(root, "B.mbox"), buildMbox([eml("4"), eml("5")], { eol: "\n" }));
    // Engine style resume: n items done overall; whole files before are skipped, the partial file resumes by item.
    const files = ["A/one.mbox", "A/two.eml", "B.mbox"];
    const itemCounts = [3, 1, 2];
    const total = itemCounts.reduce((a, b) => a + b, 0);
    const folder = new ImportFolder(root);
    const walkFrom = async (skip: number): Promise<string[]> => {
      const out: string[] = [];
      let remaining = skip;
      for (const [i, path] of files.entries()) {
        const count = itemCounts[i] as number;
        if (remaining >= count) {
          remaining -= count;
          continue;
        }
        const file = await folder.file(path);
        for await (const event of walkMailFile(file, { skipItems: remaining })) {
          out.push(`${path} -> ${row(event)}`);
        }
        remaining = 0;
      }
      return out;
    };
    const full = await walkFrom(0);
    for (let n = 0; n <= total; n++) {
      const resumed = await walkFrom(n);
      const messagesInFull = full.filter((line) => /-> (message|problem)#/.test(line));
      // Everything from item n on, plus the folder events that follow item n-1 in the same file.
      const expected: string[] = [];
      let seen = 0;
      for (const line of full) {
        const isItem = /-> (message|problem)#/.test(line);
        if (isItem) {
          seen++;
        }
        if (seen > n || (seen === n && !isItem)) {
          expected.push(line);
        }
      }
      expect(messagesInFull).toHaveLength(total);
      // A folder event that starts a file the resume does not enter is not repeated.
      expect(resumed.filter((l) => /-> (message|problem)#/.test(l))).toEqual(
        expected.filter((l) => /-> (message|problem)#/.test(l)),
      );
    }
  });

  it("does not walk links that leave the folder", async () => {
    const root = join(base, "import");
    const outside = join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "secret.eml"), eml("secret"));
    await symlink(outside, join(root, "escape"));
    await writeFile(join(root, "ok.eml"), eml("ok"));
    expect(await walkTree(root, "")).toEqual(["ok.eml -> message#0:Imported:ok.eml:eml"]);
  });
});
