import { describe, expect, it } from "vitest";
import {
  MboxEscaper,
  asctime,
  mboxEscape,
  mboxSender,
  mboxSeparator,
  mboxUnescape,
} from "./mbox-format.js";

/** The definition, written the obvious way: on a string, line by line. */
function referenceEscape(message: Buffer): Buffer {
  return Buffer.from(message.toString("latin1").replace(/(?<=^|\n)(>*From )/g, ">$1"), "latin1");
}

/** Deterministic pseudo random numbers. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const FRAGMENTS = [
  "From ",
  ">From ",
  ">>From ",
  "From",
  "Fro",
  " From ",
  "from ",
  "FFrom ",
  ">",
  ">>",
  "\n",
  "\r\n",
  "\r",
  "text ",
  "Subject: x",
  "äöü",
  "\u0000",
];

function randomMessage(next: () => number, pieces: number): Buffer {
  let text = "";
  for (let i = 0; i < pieces; i++) {
    text += FRAGMENTS[Math.floor(next() * FRAGMENTS.length)];
  }
  return Buffer.from(text, "latin1");
}

function escapeInChunks(message: Buffer, sizes: number[]): Buffer {
  const escaper = new MboxEscaper();
  const parts: Buffer[] = [];
  let offset = 0;
  for (let i = 0; offset < message.length; i++) {
    const size = sizes[i % sizes.length] as number;
    parts.push(...escaper.push(message.subarray(offset, offset + size)));
    offset += size;
  }
  parts.push(escaper.flush());
  return Buffer.concat(parts);
}

describe("mboxrd escaping", () => {
  it("adds a quote to every line matching ^>*From and nothing else", () => {
    const input = Buffer.from(
      [
        "From a@example.test Tue Mar  5 10:20:30 2024",
        ">From quoted",
        ">>From twice",
        "not From here",
        "From",
        " From indented",
        "from lower",
        "Frame",
        "",
      ].join("\n"),
    );
    expect(mboxEscape(input).toString()).toBe(
      [
        ">From a@example.test Tue Mar  5 10:20:30 2024",
        ">>From quoted",
        ">>>From twice",
        "not From here",
        "From",
        " From indented",
        "from lower",
        "Frame",
        "",
      ].join("\n"),
    );
  });

  it("handles CRLF lines and leaves 8-bit bytes untouched", () => {
    const input = Buffer.concat([
      Buffer.from("Subject: x\r\n\r\nFrom the start\r\n"),
      Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0d, 0x0a]),
      Buffer.from(">From again\r\n"),
    ]);
    const output = mboxEscape(input);
    expect(output.toString("latin1")).toBe(
      `Subject: x\r\n\r\n>From the start\r\n${Buffer.from([0xff, 0xfe, 0x00, 0x80]).toString("latin1")}\r\n>>From again\r\n`,
    );
    expect(mboxUnescape(output).equals(input)).toBe(true);
  });

  it("gives the same result however the bytes are chunked (property test)", () => {
    const next = random(20260930);
    for (let round = 0; round < 400; round++) {
      const message = randomMessage(next, 1 + Math.floor(next() * 60));
      const expected = referenceEscape(message);
      expect(
        mboxEscape(message).equals(expected),
        `whole: ${JSON.stringify(message.toString("latin1"))}`,
      ).toBe(true);
      const sizes = Array.from({ length: 5 }, () => 1 + Math.floor(next() * 9));
      expect(
        escapeInChunks(message, sizes).equals(expected),
        `chunks ${sizes.join(",")}: ${JSON.stringify(message.toString("latin1"))}`,
      ).toBe(true);
      expect(escapeInChunks(message, [1]).equals(expected)).toBe(true);
      expect(mboxUnescape(expected).equals(message), "unescape restores the message").toBe(true);
    }
  });

  it("holds back at most the five bytes of `From `, however long a line of quotes is", () => {
    const escaper = new MboxEscaper();
    const quotes = Buffer.alloc(3 * 1024 * 1024, ">");
    const first = escaper.push(quotes);
    expect(first.reduce((sum, piece) => sum + piece.length, 0)).toBe(quotes.length);
    const rest = [...escaper.push(Buffer.from("Fro")), ...escaper.push(Buffer.from("m x\n"))];
    expect(Buffer.concat(rest).toString()).toBe(">From x\n");
  });

  it("counts the bytes it consumed", () => {
    const escaper = new MboxEscaper();
    escaper.push(Buffer.from("abc\nFrom x\n"));
    expect(escaper.bytes).toBe(11);
  });
});

describe("message trailer", () => {
  it("ends a message with one blank line, adding a line break only when it is missing", () => {
    const withBreak = new MboxEscaper();
    withBreak.push(Buffer.from("a\nb\n"));
    expect(withBreak.finish().toString()).toBe("\n");

    const without = new MboxEscaper();
    without.push(Buffer.from("a\nb"));
    expect(without.finish().toString()).toBe("\n\n");
  });

  it("completes a missing final line break in the style of the message; the blank line is always LF", () => {
    const crlf = new MboxEscaper();
    crlf.push(Buffer.from("a\r\nb\r\nlast line"));
    expect(crlf.finish().toString()).toBe("\r\n\n");

    const crlfComplete = new MboxEscaper();
    crlfComplete.push(Buffer.from("a\r\nb\r\n"));
    expect(crlfComplete.finish().toString()).toBe("\n");

    const acrossChunks = new MboxEscaper();
    acrossChunks.push(Buffer.from("a\r"));
    acrossChunks.push(Buffer.from("\nb"));
    expect(acrossChunks.finish().toString()).toBe("\r\n\n");
  });

  it("writes only the blank line for an empty message and releases a held-back look-alike", () => {
    expect(new MboxEscaper().finish().toString()).toBe("\n");
    const partial = new MboxEscaper();
    expect(partial.push(Buffer.from("x\nFro"))).toHaveLength(1);
    expect(partial.finish().toString()).toBe("Fro\n\n");
  });
});

describe("separator line", () => {
  it("formats the date like ctime in UTC", () => {
    expect(asctime(new Date(Date.UTC(2024, 2, 5, 10, 20, 30)))).toBe("Tue Mar  5 10:20:30 2024");
    expect(asctime(new Date(Date.UTC(2026, 11, 31, 23, 59, 59)))).toBe("Thu Dec 31 23:59:59 2026");
    expect(asctime(null)).toBe("Thu Jan  1 00:00:00 1970");
    expect(asctime(new Date(Number.NaN))).toBe("Thu Jan  1 00:00:00 1970");
  });

  it("takes the bare address of the sender or MAILER-DAEMON", () => {
    expect(mboxSender("Anna Example <anna@example.test>")).toBe("anna@example.test");
    expect(mboxSender('"Doe, John" <john@example.test>')).toBe("john@example.test");
    expect(mboxSender("bob@example.test")).toBe("bob@example.test");
    expect(mboxSender("<>")).toBe("MAILER-DAEMON");
    expect(mboxSender("no address at all")).toBe("MAILER-DAEMON");
    expect(mboxSender(null)).toBe("MAILER-DAEMON");
    // Whatever is in the value, the separator line stays one line.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the test looks for control characters
    expect(mboxSender("evil <a@example.test\nSubject: x>")).not.toMatch(/[\s\u0000-\u001f]/);
    expect(mboxSeparator("x\r\nFrom y@example.test", null).split("\n")).toHaveLength(1);
    expect(
      mboxSeparator("Anna <anna@example.test>", new Date(Date.UTC(2024, 2, 5, 10, 20, 30))),
    ).toBe("From anna@example.test Tue Mar  5 10:20:30 2024");
  });
});
