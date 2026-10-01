import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { type MboxItem, MboxSplitter, splitMbox } from "./mbox.js";
import { buildEml, buildMbox } from "./testing/builders.js";

const LIMIT = 10 * 1024 * 1024;

function chunked(buffer: Buffer, size: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += size) {
    chunks.push(buffer.subarray(offset, Math.min(buffer.length, offset + size)));
  }
  return chunks;
}

async function split(
  buffer: Buffer,
  options: { chunk?: number; max?: number; skip?: number } = {},
): Promise<MboxItem[]> {
  const items: MboxItem[] = [];
  const stream = Readable.from(chunked(buffer, options.chunk ?? 65536), { objectMode: false });
  for await (const item of splitMbox(stream, {
    maxMessageBytes: options.max ?? LIMIT,
    ...(options.skip !== undefined ? { skipItems: options.skip } : {}),
  })) {
    items.push(item);
  }
  return items;
}

function message(
  subject: string,
  body = "Body of the message.\r\n",
  extraHeaders: [string, string][] = [],
): Buffer {
  return buildEml({
    from: "Alice <alice@example.test>",
    to: "bob@example.test",
    subject,
    body,
    headers: extraHeaders,
  });
}

function rawOf(item: MboxItem | undefined): Buffer {
  expect(item?.kind).toBe("message");
  return (item as Extract<MboxItem, { kind: "message" }>).raw;
}

const toLf = (buffer: Buffer): Buffer =>
  Buffer.from(buffer.toString("latin1").replace(/\r\n/g, "\n"), "latin1");

describe("splitMbox", () => {
  describe("messages and separators", () => {
    const messages = [message("one"), message("two"), message("three")];

    it("splits a CRLF file into byte-identical messages", async () => {
      const items = await split(buildMbox(messages, { eol: "\r\n" }));
      expect(items.map((i) => i.kind)).toEqual(["message", "message", "message"]);
      items.forEach((item, i) => {
        expect(item.index).toBe(i);
        expect(rawOf(item).equals(messages[i] as Buffer)).toBe(true);
      });
    });

    it("splits an LF file", async () => {
      const items = await split(buildMbox(messages, { eol: "\n" }));
      expect(items).toHaveLength(3);
      items.forEach((item, i) => {
        expect(rawOf(item).equals(toLf(messages[i] as Buffer))).toBe(true);
      });
    });

    it("drops the blank separator before the next From line and the trailing blank at the end", async () => {
      const file = Buffer.from(
        "From a Mon Jan  1 00:00:00 2024\nSubject: a\n\nbody a\n\nFrom b Mon Jan  1 00:00:00 2024\nSubject: b\n\nbody b\n\n",
      );
      const items = await split(file);
      expect(rawOf(items[0]).toString()).toBe("Subject: a\n\nbody a\n");
      expect(rawOf(items[1]).toString()).toBe("Subject: b\n\nbody b\n");
    });

    it("also works without a blank line after the last message", async () => {
      const file = buildMbox([message("a"), message("b")], { omitFinalBlank: true, eol: "\r\n" });
      const items = await split(file);
      expect(rawOf(items[1]).equals(message("b"))).toBe(true);
    });

    it("keeps a last message without any final line break as it is", async () => {
      const items = await split(
        Buffer.from("From a Mon Jan  1 00:00:00 2024\nSubject: a\n\nno newline at the end"),
      );
      expect(rawOf(items[0]).toString()).toBe("Subject: a\n\nno newline at the end");
    });

    it("keeps blank lines inside the message and only removes one trailing blank line", async () => {
      const file = Buffer.from(
        "From a Mon Jan  1 00:00:00 2024\nSubject: a\n\nline\n\n\nline2\n\n\nFrom b Mon Jan  1 00:00:00 2024\nSubject: b\n\nx\n",
      );
      const items = await split(file);
      expect(rawOf(items[0]).toString()).toBe("Subject: a\n\nline\n\n\nline2\n\n");
    });

    it("does not split at a From line that does not follow a blank line", async () => {
      const file = Buffer.from(
        "From a Mon Jan  1 00:00:00 2024\nSubject: a\n\nsome text\nFrom nobody in particular\nmore text\n\nFrom b Mon Jan  1 00:00:00 2024\nSubject: b\n\nx\n",
      );
      const items = await split(file);
      expect(items).toHaveLength(2);
      expect(rawOf(items[0]).toString()).toBe(
        "Subject: a\n\nsome text\nFrom nobody in particular\nmore text\n",
      );
    });

    it("handles a single message and a message per tiny file", async () => {
      expect(await split(buildMbox([message("solo")], { eol: "\r\n" }))).toHaveLength(1);
    });

    it("reports the source bytes so that they add up to the file size", async () => {
      const file = buildMbox(messages, { eol: "\n" });
      const items = await split(file, { chunk: 100 });
      expect(items.reduce((sum, i) => sum + i.sourceBytes, 0)).toBe(file.length);
    });
  });

  describe("mboxrd escaping", () => {
    it("round-trips lines that look like From_ lines", async () => {
      const body = [
        "Intro line",
        "",
        "From here on it gets interesting",
        ">From a quoted line",
        ">>From twice quoted",
        "> From with a space",
        ">plain quote",
        "Frozen from ice",
        "From",
        "",
      ].join("\r\n");
      const original = message("escaping", body);
      for (const eol of ["\n", "\r\n"] as const) {
        const file = buildMbox([original, original], { eol });
        expect(file.toString("latin1")).toContain(`${eol}>From here on it gets interesting${eol}`);
        expect(file.toString("latin1")).toContain(`${eol}>>From a quoted line${eol}`);
        const items = await split(file);
        expect(items).toHaveLength(2);
        const expected = eol === "\n" ? toLf(original) : original;
        expect(rawOf(items[0]).equals(expected)).toBe(true);
        expect(rawOf(items[1]).equals(expected)).toBe(true);
      }
    });

    it("only un-escapes lines that match >+From followed by a space", async () => {
      const file = Buffer.from(
        "From a Mon Jan  1 00:00:00 2024\nSubject: x\n\n>From x\n>>From y\n>Fromage\n>>>Fro\n> From z\n",
      );
      const items = await split(file);
      expect(rawOf(items[0]).toString()).toBe(
        "Subject: x\n\nFrom x\n>From y\n>Fromage\n>>>Fro\n> From z\n",
      );
    });
  });

  describe("streaming", () => {
    const file = buildMbox(
      [
        message("first", "From here\r\n\r\nFrom there\r\nend\r\n"),
        message("second", "äöü\r\n"),
        message("third"),
      ],
      { eol: "\r\n" },
    );

    it("gives the same result for every chunk size, down to single bytes", async () => {
      const reference = await split(file, { chunk: 1 << 20 });
      expect(reference).toHaveLength(3);
      for (const chunk of [1, 2, 3, 5, 7, 16, 63, 64, 1000]) {
        const items = await split(file, { chunk });
        expect(items.map((i) => i.kind)).toEqual(reference.map((i) => i.kind));
        items.forEach((item, i) => {
          expect(rawOf(item).equals(rawOf(reference[i]))).toBe(true);
          expect(item.sourceBytes).toBe((reference[i] as MboxItem).sourceBytes);
        });
      }
    });

    it("accepts string and Uint8Array chunks", async () => {
      const items: MboxItem[] = [];
      const text = file.toString("latin1");
      for await (const item of splitMbox(
        Readable.from([text.slice(0, 50), new Uint8Array(Buffer.from(text.slice(50), "latin1"))], {
          objectMode: true,
        }),
        { maxMessageBytes: LIMIT },
      )) {
        items.push(item);
      }
      expect(items).toHaveLength(3);
    });

    it("keeps memory bounded by the message limit however large the message is", () => {
      const limit = 64 * 1024;
      const splitter = new MboxSplitter({ maxMessageBytes: limit });
      const head = Buffer.from("From a Mon Jan  1 00:00:00 2024\nSubject: huge\n\n");
      let peak = 0;
      const items: MboxItem[] = [];
      items.push(...splitter.push(head));
      const line = Buffer.alloc(1024, 0x61);
      line[1023] = 0x0a;
      for (let i = 0; i < 20_000; i++) {
        items.push(...splitter.push(Buffer.from(line)));
        peak = Math.max(peak, splitter.bufferedBytes());
      }
      // A single 5 MB line without a newline, fed in pieces, is bounded as well.
      const piece = Buffer.alloc(100_000, 0x62);
      for (let i = 0; i < 50; i++) {
        items.push(...splitter.push(Buffer.from(piece)));
        peak = Math.max(peak, splitter.bufferedBytes());
      }
      items.push(
        ...splitter.push(Buffer.from("\n\nFrom b Mon Jan  1 00:00:00 2024\nSubject: small\n\nx\n")),
      );
      items.push(...splitter.end());
      expect(peak).toBeLessThanOrEqual(limit + 1024 * 1024 + 100_000);
      expect(items.map((i) => i.kind)).toEqual(["problem", "message"]);
    });

    it("keeps the number of buffered pieces bounded when every line needs un-escaping", () => {
      // Lines that alternate between "unescape this" and "keep this" cannot be merged into one
      // run, and a Buffer view per line costs about 100 bytes of heap: 64 MiB of eight-byte
      // lines took a gigabyte before the loose pieces were merged.
      const splitter = new MboxSplitter({ maxMessageBytes: 256 * 1024 * 1024 });
      splitter.push(Buffer.from("From a Mon Jan  1 00:00:00 2024\nSubject: x\n\n"));
      const chunk = Buffer.from(">>From x\n".repeat(100_000));
      let widest = 0;
      for (let i = 0; i < 10; i++) {
        splitter.push(Buffer.from(chunk));
        const parts = (splitter as unknown as { current: { parts: Buffer[] } }).current.parts;
        widest = Math.max(widest, parts.length);
      }
      expect(widest).toBeLessThan(10_000);
      const items = splitter.end();
      expect(items).toHaveLength(1);
      const raw = (items[0] as { raw: Buffer }).raw.toString("latin1");
      // Every ">>From" lost one ">" and nothing else changed.
      expect(raw).toBe(`Subject: x\n\n${">From x\n".repeat(1_000_000)}`);
    });

    it("throws an AbortError when the signal is aborted", async () => {
      const controller = new AbortController();
      const iterator = splitMbox(Readable.from(chunked(file, 10), { objectMode: false }), {
        maxMessageBytes: LIMIT,
        signal: controller.signal,
      });
      controller.abort();
      await expect(iterator.next()).rejects.toMatchObject({
        name: "AbortError",
        message: "aborted",
      });
    });
  });

  describe("limits and problems", () => {
    it("reports a message above the limit as too_large and carries on", async () => {
      const big = message("big", `${"x".repeat(5000)}\r\n`);
      const file = buildMbox([message("a"), big, message("c")], { eol: "\r\n" });
      const items = await split(file, { max: 2000, chunk: 97 });
      expect(items.map((i) => i.kind)).toEqual(["message", "problem", "message"]);
      const problem = items[1] as Extract<MboxItem, { kind: "problem" }>;
      expect(problem.code).toBe("too_large");
      expect(problem.index).toBe(1);
      expect(problem.reason).toMatch(/more than the limit/);
      expect(problem.reason).not.toContain("—");
      expect(rawOf(items[2]).equals(message("c"))).toBe(true);
    });

    it("keeps a message that is exactly at the limit", async () => {
      const one = message("exact");
      const file = buildMbox([one], { eol: "\r\n" });
      const fits = await split(file, { max: one.length });
      expect(fits[0]?.kind).toBe("message");
      const tooSmall = await split(file, { max: one.length - 1 });
      expect(tooSmall[0]).toMatchObject({ kind: "problem", code: "too_large" });
    });

    it("reports an empty message and one without headers", async () => {
      const file = Buffer.from(
        [
          "From a Mon Jan  1 00:00:00 2024",
          "",
          "From b Mon Jan  1 00:00:00 2024",
          "just text without any header",
          "",
          "From c Mon Jan  1 00:00:00 2024",
          "Subject: fine",
          "",
          "body",
          "",
        ].join("\n"),
      );
      const items = await split(file);
      expect(items.map((i) => (i.kind === "problem" ? i.code : "message"))).toEqual([
        "empty",
        "empty",
        "message",
      ]);
      expect((items[0] as { reason: string }).reason).toBe("The MBOX message has no content.");
      expect((items[1] as { reason: string }).reason).toBe("The MBOX message has no headers.");
    });

    it("reports content in front of the first message", async () => {
      const file = Buffer.from("garbage line\nFrom x Mon Jan  1 00:00:00 2024\nSubject: a\n\nx\n");
      // The preamble is only a problem when it is followed by a From line after a blank line.
      const items = await split(
        Buffer.from("garbage line\n\nFrom x Mon Jan  1 00:00:00 2024\nSubject: a\n\nx\n"),
      );
      expect(items.map((i) => i.kind)).toEqual(["problem", "message"]);
      expect((items[0] as { code: string }).code).toBe("unreadable");
      expect(items[1]?.index).toBe(1);
      // Without the blank line the From line is just more of the preamble.
      const none = await split(file);
      expect(none.map((i) => i.kind)).toEqual(["problem"]);
    });

    it("ignores blank lines in front of the first message", async () => {
      const items = await split(
        Buffer.from("\n\nFrom x Mon Jan  1 00:00:00 2024\nSubject: a\n\nx\n"),
      );
      expect(items.map((i) => i.kind)).toEqual(["message"]);
    });

    it("yields nothing for an empty stream", async () => {
      expect(await split(Buffer.alloc(0))).toEqual([]);
    });

    it("strips a UTF-8 byte order mark, also when split across chunks", async () => {
      const file = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        buildMbox([message("bom")], { eol: "\r\n" }),
      ]);
      for (const chunk of [1, 2, 3, 100]) {
        const items = await split(file, { chunk });
        expect(items).toHaveLength(1);
        expect(rawOf(items[0]).equals(message("bom"))).toBe(true);
      }
    });
  });

  describe("flags and dates", () => {
    const one = async (headers: [string, string][], fromLine?: string) => {
      const items = await split(
        buildMbox([message("f", "b\r\n", headers)], {
          eol: "\n",
          ...(fromLine ? { fromLine: () => fromLine } : {}),
        }),
      );
      expect(items[0]?.kind).toBe("message");
      return items[0] as Extract<MboxItem, { kind: "message" }>;
    };
    const flags = async (headers: [string, string][]) => (await one(headers)).flags;

    it("reads Status and X-Status", async () => {
      expect(await flags([["Status", "RO"]])).toEqual(["\\Seen"]);
      expect(await flags([["Status", "O"]])).toEqual([]);
      expect(
        await flags([
          ["Status", "RO"],
          ["X-Status", "AFD"],
        ]),
      ).toEqual(["\\Seen", "\\Answered", "\\Flagged"]);
      expect(await flags([["X-Status", "T"]])).toEqual(["\\Draft"]);
    });

    it("never carries \\Deleted over", async () => {
      expect(
        await flags([
          ["Status", "D"],
          ["X-Status", "D"],
        ]),
      ).toEqual([]);
    });

    it("reads Thunderbird's X-Mozilla-Status bit field", async () => {
      const bits = (value: string) => flags([["X-Mozilla-Status", value]]);
      expect(await bits("0001")).toEqual(["\\Seen"]);
      expect(await bits("0000")).toEqual([]);
      expect(await bits("0003")).toEqual(["\\Seen", "\\Answered"]);
      expect(await bits("0005")).toEqual(["\\Seen", "\\Flagged"]);
      expect(await bits("0009")).toEqual(["\\Seen"]);
      expect(await bits("1001")).toEqual(["\\Seen"]);
      expect(await bits("zzzz")).toEqual([]);
    });

    it("takes the internal date from the From line", async () => {
      const date = async (line: string) =>
        (await one([], line)).internalDate?.toISOString() ?? null;
      expect(await date("MAILER-DAEMON Fri Jul  8 12:08:34 2011")).toBe("2011-07-08T12:08:34.000Z");
      expect(await date("- Thu Sep 30 12:00:00 2021")).toBe("2021-09-30T12:00:00.000Z");
      expect(await date("alice@example.test Sat Jan  3 01:05:34 1996")).toBe(
        "1996-01-03T01:05:34.000Z",
      );
      expect(await date("alice@example.test Sat Jan  3 01:05:34 -0500 1996")).toBe(
        "1996-01-03T06:05:34.000Z",
      );
      expect(await date("alice@example.test Sat Jan  3 01:05:34 1996 +0100")).toBe(
        "1996-01-03T00:05:34.000Z",
      );
      expect(await date("alice@example.test")).toBeNull();
      expect(await date("alice@example.test Xyz Foo 99 99:99:99 1996")).toBeNull();
    });
  });

  describe("resume", () => {
    const messages = [
      message("m0"),
      message("m1", "From x\r\n"),
      message("huge", `${"y".repeat(4000)}\r\n`),
      message("m3"),
      message("m4"),
    ];
    const withProblems = Buffer.concat([
      Buffer.from("junk before\n\n"),
      buildMbox(messages.slice(0, 2), { eol: "\n" }),
      Buffer.from("From nobody Mon Jan  1 00:00:00 2024\n\n"),
      buildMbox(messages.slice(2), { eol: "\n" }),
    ]);

    it("a full pass equals the first n items plus a resumed pass, for every n", async () => {
      const full = await split(withProblems, { max: 3000, chunk: 41 });
      expect(full.map((i) => i.index)).toEqual(full.map((_, i) => i));
      expect(full.some((i) => i.kind === "problem" && i.code === "too_large")).toBe(true);
      expect(full.some((i) => i.kind === "problem" && i.code === "empty")).toBe(true);
      expect(full.some((i) => i.kind === "problem" && i.code === "unreadable")).toBe(true);
      for (let n = 0; n <= full.length + 1; n++) {
        const resumed = await split(withProblems, { max: 3000, chunk: 41, skip: n });
        const expected = full.slice(n);
        expect(resumed).toHaveLength(expected.length);
        resumed.forEach((item, i) => {
          const other = expected[i] as MboxItem;
          expect(item.kind).toBe(other.kind);
          expect(item.index).toBe(other.index);
          expect(item.sourceBytes).toBe(other.sourceBytes);
          if (item.kind === "message" && other.kind === "message") {
            expect(item.raw.equals(other.raw)).toBe(true);
            expect(item.flags).toEqual(other.flags);
            expect(item.internalDate?.getTime()).toBe(other.internalDate?.getTime());
          }
        });
      }
    });

    it("does not buffer the skipped items", () => {
      const splitter = new MboxSplitter({ maxMessageBytes: LIMIT, skipItems: 1 });
      splitter.push(Buffer.from("From a Mon Jan  1 00:00:00 2024\nSubject: a\n\n"));
      const line = Buffer.alloc(1024, 0x61);
      line[1023] = 0x0a;
      for (let i = 0; i < 1000; i++) {
        splitter.push(Buffer.from(line));
      }
      expect(splitter.bufferedBytes()).toBe(0);
    });
  });
});
