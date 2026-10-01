import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ExportIntegrityError, JobAbortedError } from "./errors.js";
import { createMbox, createMboxZip } from "./mbox.js";
import {
  checkSha256Sums,
  collect,
  parseManifest,
  sampleEml,
  sha256Hex,
  testMessage,
  unzip,
} from "./testing.js";
import type { ExportEntry } from "./types.js";

const LF = 0x0a;

/**
 * A tiny reader for the mboxrd definition, independent of the writer: a line
 * starting with `From ` at the start of the file or after a blank line opens a
 * message, the blank line before the next one is not part of the message, and
 * one `>` is removed from lines matching `^>+From `.
 */
function referenceSplit(mbox: Buffer): { separator: string; message: Buffer }[] {
  const lines: Buffer[] = [];
  for (let start = 0; start < mbox.length; ) {
    const newline = mbox.indexOf(LF, start);
    const end = newline === -1 ? mbox.length : newline + 1;
    lines.push(mbox.subarray(start, end));
    start = end;
  }
  const isBlank = (line: Buffer): boolean =>
    line.toString("latin1") === "\n" || line.toString("latin1") === "\r\n";
  const found: { separator: string; lines: Buffer[] }[] = [];
  let previousBlank = true;
  for (const line of lines) {
    if (previousBlank && line.subarray(0, 5).toString("latin1") === "From ") {
      found.push({ separator: line.toString("utf8").replace(/\r?\n$/, ""), lines: [] });
      previousBlank = false;
      continue;
    }
    const current = found[found.length - 1];
    if (current === undefined) {
      throw new Error("bytes before the first separator line");
    }
    current.lines.push(line);
    previousBlank = isBlank(line);
  }
  return found.map(({ separator, lines: body }) => {
    const last = body[body.length - 1];
    if (last === undefined || !isBlank(last)) {
      throw new Error("a message is not followed by a blank line");
    }
    const unescaped = body.slice(0, -1).map((line) => {
      const text = line.toString("latin1");
      return /^>+From /.test(text) ? line.subarray(1) : line;
    });
    return { separator, message: Buffer.concat(unescaped) };
  });
}

const date = (day: number): Date => new Date(Date.UTC(2024, 2, day, 10, 20, 30));

/** What a reader must get back: the message, plus a line break if it had none. */
function expectedBack(message: Buffer): Buffer {
  if (message.length === 0 || message[message.length - 1] === LF) {
    return message;
  }
  const crlf = message.includes("\r\n");
  return Buffer.concat([message, Buffer.from(crlf ? "\r\n" : "\n")]);
}

const AWKWARD: Buffer[] = [
  Buffer.from(sampleEml({ subject: "plain" })),
  Buffer.from(
    sampleEml({
      subject: "unix",
      crlf: false,
      body: "From here on\n>From quoted\n>>From twice\nFrom",
    }),
  ),
  Buffer.from(sampleEml({ subject: "no final newline" }).replace(/\r\n$/, "")),
  Buffer.concat([
    Buffer.from("Subject: binary\r\n\r\n"),
    Buffer.from([0xff, 0x00, 0xfe, 0x0d, 0x0a, 0x80]),
    Buffer.from("\r\nFrom x\r\n\r\n"),
  ]),
  Buffer.from("Subject: ends with a blank line\n\nbody\n\n"),
  Buffer.alloc(0),
  Buffer.from("From "),
];

describe("createMbox", () => {
  it("writes mboxrd: separator line, verbatim escaped bytes, one blank line, and reads back exactly", async () => {
    const messages = AWKWARD.map((bytes, index) =>
      testMessage(bytes, {
        date: date(1 + index),
        from: `Sender ${index} <s${index}@example.test>`,
        chunkSize: 5,
      }),
    );
    const { stream, completed } = createMbox(messages);
    const [mbox, summary] = await Promise.all([collect(stream), completed]);

    const split = referenceSplit(mbox);
    expect(split).toHaveLength(AWKWARD.length);
    split.forEach((item, index) => {
      expect(item.message.equals(expectedBack(AWKWARD[index] as Buffer)), `message ${index}`).toBe(
        true,
      );
    });
    expect(split[0]?.separator).toBe("From s0@example.test Fri Mar  1 10:20:30 2024");
    expect(split[6]?.separator).toBe("From s6@example.test Thu Mar  7 10:20:30 2024");

    expect(summary.messages).toBe(AWKWARD.length);
    expect(summary.failed).toBe(0);
    expect(summary.entries.map((entry) => entry.name)).toEqual(AWKWARD.map((_, i) => `#${i + 1}`));
    summary.entries.forEach((entry, index) => {
      expect(entry.sha256).toBe(sha256Hex(AWKWARD[index] as Buffer));
      expect(entry.bytes).toBe((AWKWARD[index] as Buffer).length);
    });
  });

  it("keeps a message that quotes a whole mbox intact", async () => {
    const inner = Buffer.from(
      "From a@example.test Tue Mar  5 10:20:30 2024\nSubject: inner\n\nbody\n\n",
    );
    const outer = Buffer.concat([Buffer.from("Subject: outer\n\n"), inner]);
    const { stream } = createMbox([testMessage(outer), testMessage(outer)]);
    const split = referenceSplit(await collect(stream));
    expect(split).toHaveLength(2);
    for (const item of split) {
      expect(item.message.equals(outer)).toBe(true);
    }
  });

  it("leaves the bytes of the message unchanged apart from the escaping and the final break", async () => {
    const message = Buffer.from("Subject: x\r\n\r\nFrom the top\r\nline\r\n");
    const { stream } = createMbox([testMessage(message, { from: "a@example.test" })]);
    const mbox = await collect(stream);
    expect(mbox.toString("latin1")).toBe(
      "From a@example.test Tue Mar  5 10:20:30 2024\nSubject: x\r\n\r\n>From the top\r\nline\r\n\n",
    );
  });

  it("uses MAILER-DAEMON and the epoch for a message without sender and date", async () => {
    const { stream } = createMbox([
      testMessage("Subject: x\n\nbody\n", { from: null, date: null }),
    ]);
    const mbox = (await collect(stream)).toString();
    expect(mbox.split("\n")[0]).toBe("From MAILER-DAEMON Thu Jan  1 00:00:00 1970");
  });

  it("ignores folders and yields an empty stream for no messages", async () => {
    const empty = createMbox([]);
    const [bytes, summary] = await Promise.all([collect(empty.stream), empty.completed]);
    expect(bytes.length).toBe(0);
    expect(summary).toMatchObject({ messages: 0, failed: 0, bytes: 0 });

    const two = createMbox([
      testMessage("Subject: a\n\nx\n", { folder: ["Inbox"] }),
      testMessage("Subject: b\n\ny\n", { folder: ["Sent", "2019"] }),
    ]);
    expect(referenceSplit(await collect(two.stream))).toHaveLength(2);
  });

  it("skips a message that cannot be opened without leaving a trace in the stream", async () => {
    const seen: ExportEntry[] = [];
    const { stream, completed } = createMbox(
      [
        testMessage("Subject: a\n\nx\n"),
        testMessage("Subject: broken\n\n", {
          open: () => {
            throw new Error("pack file is unreachable");
          },
        }),
        testMessage("Subject: c\n\nz\n"),
      ],
      { onEntry: (entry) => seen.push(entry) },
    );
    const [mbox, summary] = await Promise.all([collect(stream), completed]);
    expect(referenceSplit(mbox).map((item) => item.message.toString())).toEqual([
      "Subject: a\n\nx\n",
      "Subject: c\n\nz\n",
    ]);
    expect(summary).toMatchObject({ messages: 2, failed: 1 });
    expect(seen.map((entry) => `${entry.name}:${entry.status}`)).toEqual([
      "#1:added",
      "#2:failed",
      "#3:added",
    ]);
    expect(seen[1]?.note).toBe("pack file is unreachable");
  });

  it("aborts on a hash mismatch", async () => {
    const { stream, completed } = createMbox([
      testMessage("Subject: a\n\nx\n"),
      testMessage("Subject: b\n\ny\n", { sha256: "f".repeat(64) }),
      testMessage("Subject: c\n\nz\n"),
    ]);
    const drained = collect(stream).catch((error: Error) => error);
    await expect(completed).rejects.toBeInstanceOf(ExportIntegrityError);
    expect(await drained).toBeInstanceOf(Error);
  });

  it("aborts when a message breaks after it has been started", async () => {
    let step = 0;
    const { stream, completed } = createMbox([
      testMessage("x", {
        open: () =>
          new Readable({
            read() {
              if (step++ === 0) {
                this.push(Buffer.from("Subject: a\n"));
              } else {
                this.destroy(new Error("disk vanished"));
              }
            },
          }),
      }),
    ]);
    const drained = collect(stream).catch((error: Error) => error);
    await expect(completed).rejects.toThrow("disk vanished");
    expect(await drained).toBeInstanceOf(Error);
  });

  it("stops on the abort signal, also while the consumer is not reading", async () => {
    const controller = new AbortController();
    const big = Buffer.alloc(4 * 1024 * 1024, "a");
    const { stream, completed } = createMbox(
      Array.from({ length: 10 }, () => testMessage(big, { chunkSize: 65536, withHash: false })),
      { signal: controller.signal },
    );
    // Nobody reads `stream`: the writer must sit in backpressure, then obey the signal.
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await expect(completed).rejects.toBeInstanceOf(JobAbortedError);
    await new Promise((resolve) => setImmediate(resolve));
    expect(stream.destroyed).toBe(true);
  });

  it("rejects when the consumer goes away", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, "a");
    const { stream, completed } = createMbox(
      Array.from({ length: 10 }, () => testMessage(big, { chunkSize: 65536, withHash: false })),
    );
    stream.once("data", () => stream.destroy());
    await expect(completed).rejects.toThrow();
  });

  it("does not hold on to more than the backpressure window while nobody reads", async () => {
    let opened = 0;
    const big = Buffer.alloc(1024 * 1024, "a");
    const many = Array.from({ length: 50 }, () =>
      testMessage(big, {
        withHash: false,
        chunkSize: 65536,
        open: () => {
          opened++;
          return Readable.from([big], { objectMode: false });
        },
      }),
    );
    const { stream, completed } = createMbox(many);
    completed.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(opened).toBeLessThanOrEqual(2);
    stream.destroy();
  });
});

describe("createMboxZip", () => {
  it("writes one .mbox per folder with MANIFEST.csv and SHA256SUMS", async () => {
    const inbox = [
      Buffer.from(sampleEml({ subject: "one" })),
      Buffer.from("Subject: two\n\nFrom a line\nend"),
    ];
    const nested = [Buffer.from(sampleEml({ subject: "nested" }))];
    const root = [Buffer.from(sampleEml({ subject: "root" }))];
    const { stream, completed } = createMboxZip(
      [
        testMessage(inbox[0] as Buffer, { folder: ["Inbox"], date: date(1) }),
        testMessage(inbox[1] as Buffer, { folder: ["Inbox"], date: date(2) }),
        testMessage(nested[0] as Buffer, { folder: ["Inbox", "Projects"], date: date(3) }),
        testMessage(root[0] as Buffer, { folder: [], date: date(4) }),
      ],
      { extraFolders: [["Archive", "2019"], ["Inbox"]], now: () => date(9) },
    );
    const [archive, summary] = await Promise.all([collect(stream), completed]);
    const entries = await unzip(archive);
    expect(entries.map((entry) => entry.name)).toEqual([
      "Inbox.mbox",
      "Inbox/",
      "Inbox/Projects.mbox",
      "Messages.mbox",
      "Archive/",
      "Archive/2019.mbox",
      "MANIFEST.csv",
      "SHA256SUMS",
    ]);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));

    const inboxBack = referenceSplit((byName.get("Inbox.mbox") as { data: Buffer }).data);
    expect(inboxBack.map((item) => item.message.toString())).toEqual(
      inbox.map((bytes) => expectedBack(bytes).toString()),
    );
    expect(
      referenceSplit((byName.get("Inbox/Projects.mbox") as { data: Buffer }).data),
    ).toHaveLength(1);
    expect(referenceSplit((byName.get("Messages.mbox") as { data: Buffer }).data)).toHaveLength(1);
    expect((byName.get("Archive/2019.mbox") as { data: Buffer }).data.length).toBe(0);

    const manifest = parseManifest(
      (byName.get("MANIFEST.csv") as { data: Buffer }).data.toString(),
    );
    expect(manifest.map((row) => [row.entry, row.status, row.note])).toEqual([
      ["Inbox.mbox", "added", "2 messages"],
      ["Inbox/Projects.mbox", "added", "1 message"],
      ["Messages.mbox", "added", "1 message"],
      ["Archive/2019.mbox", "added", "0 messages"],
    ]);
    for (const row of manifest) {
      const file = byName.get(row.entry) as { data: Buffer };
      expect(row.sha256).toBe(sha256Hex(file.data));
      expect(Number(row.size)).toBe(file.data.length);
    }
    const sums = (byName.get("SHA256SUMS") as { data: Buffer }).data.toString();
    expect(checkSha256Sums(sums, entries)).toEqual([
      "Inbox.mbox",
      "Inbox/Projects.mbox",
      "Messages.mbox",
      "Archive/2019.mbox",
      "MANIFEST.csv",
    ]);

    expect(summary.messages).toBe(4);
    expect(summary.failed).toBe(0);
    expect(summary.entries.map((entry) => entry.name)).toEqual([
      "Inbox.mbox#1",
      "Inbox.mbox#2",
      "Inbox/Projects.mbox#1",
      "Messages.mbox#1",
    ]);
  });

  it("continues a folder whose messages are not consecutive in a second file and says so", async () => {
    const { stream, completed } = createMboxZip([
      testMessage("Subject: a\n\n1\n", { folder: ["Inbox"] }),
      testMessage("Subject: b\n\n2\n", { folder: ["Sent"] }),
      testMessage("Subject: c\n\n3\n", { folder: ["Inbox"] }),
    ]);
    const [archive] = await Promise.all([collect(stream), completed]);
    const entries = await unzip(archive);
    expect(entries.map((entry) => entry.name)).toEqual([
      "Inbox.mbox",
      "Sent.mbox",
      "Inbox (2).mbox",
      "MANIFEST.csv",
      "SHA256SUMS",
    ]);
    const manifest = parseManifest(
      (entries.find((e) => e.name === "MANIFEST.csv") as { data: Buffer }).data.toString(),
    );
    expect(manifest[2]?.note).toContain(
      "1 message; the messages of this folder were not consecutive",
    );
  });

  it("lists failed messages in the manifest and continues", async () => {
    const { stream, completed } = createMboxZip([
      testMessage("Subject: a\n\n1\n", { folder: ["Inbox"], subject: "fine" }),
      testMessage("x", {
        folder: ["Inbox"],
        subject: "broken one",
        messageId: "<broken@example.test>",
        open: () => {
          throw new Error("chunk is gone");
        },
      }),
      testMessage("Subject: c\n\n3\n", { folder: ["Inbox"], subject: "fine too" }),
    ]);
    const [archive, summary] = await Promise.all([collect(stream), completed]);
    const entries = await unzip(archive);
    const manifest = parseManifest(
      (entries.find((e) => e.name === "MANIFEST.csv") as { data: Buffer }).data.toString(),
    );
    expect(manifest.map((row) => [row.entry, row.status])).toEqual([
      ["Inbox.mbox", "added"],
      ["Inbox.mbox#2", "failed"],
    ]);
    expect(manifest[0]?.note).toBe("2 messages");
    expect(manifest[1]).toMatchObject({
      subject: "broken one",
      message_id: "<broken@example.test>",
      note: "chunk is gone",
    });
    expect(
      referenceSplit((entries.find((e) => e.name === "Inbox.mbox") as { data: Buffer }).data),
    ).toHaveLength(2);
    expect(summary).toMatchObject({ messages: 2, failed: 1 });
  });

  it("aborts on a hash mismatch and on cancellation", async () => {
    const corrupt = createMboxZip([
      testMessage("Subject: a\n\n1\n"),
      testMessage("Subject: b\n\n2\n", { sha256: "a".repeat(64) }),
    ]);
    const drained = collect(corrupt.stream).catch((error: Error) => error);
    await expect(corrupt.completed).rejects.toBeInstanceOf(ExportIntegrityError);
    expect(await drained).toBeInstanceOf(Error);

    const controller = new AbortController();
    controller.abort();
    const cancelled = createMboxZip([testMessage("Subject: a\n\n1\n")], {
      signal: controller.signal,
    });
    const drained2 = collect(cancelled.stream).catch((error: Error) => error);
    await expect(cancelled.completed).rejects.toBeInstanceOf(JobAbortedError);
    expect(await drained2).toBeInstanceOf(Error);
  });

  it("produces a ZIP that a strict reader accepts (ZIP64 headers, UTF-8 names)", async () => {
    const { stream } = createMboxZip([testMessage("Subject: a\n\n1\n", { folder: ["Entwürfe"] })]);
    const entries = await unzip(await collect(stream));
    expect(entries[0]?.name).toBe("Entwürfe.mbox");
    expect(entries[0]?.utf8Name).toBe(true);
  });
});
