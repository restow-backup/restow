import { describe, expect, it } from "vitest";
import {
  flagsFromHeaders,
  headerValues,
  parseFromLineDate,
  parseHeaderDate,
  readHeaderBlock,
  receivedOrSentDate,
} from "./headers.js";

describe("readHeaderBlock", () => {
  it("reads names in lower case, unfolds continuation lines and stops at the blank line", () => {
    const raw = Buffer.from(
      "Subject: a long\r\n subject line\r\nFrom: Alice <a@example.test>\r\nX-Tab:\tvalue\r\n\tcontinued\r\n\r\nNot-A-Header: body\r\n",
    );
    expect(readHeaderBlock(raw)).toEqual([
      { name: "subject", value: "a long subject line" },
      { name: "from", value: "Alice <a@example.test>" },
      { name: "x-tab", value: "value continued" },
    ]);
  });

  it("works with LF only and keeps repeated fields", () => {
    const headers = readHeaderBlock(Buffer.from("Received: one\nReceived: two\n\nbody"));
    expect(headerValues(headers, "received")).toEqual(["one", "two"]);
  });

  it("stops at a line that is not a header and never throws", () => {
    expect(readHeaderBlock(Buffer.from("A: 1\nnot a header\nB: 2\n"))).toEqual([
      { name: "a", value: "1" },
    ]);
    expect(readHeaderBlock(Buffer.alloc(0))).toEqual([]);
    expect(readHeaderBlock(Buffer.from([0xff, 0xfe, 0x00]))).toEqual([]);
  });

  it("does not read past the size cap", () => {
    const raw = Buffer.from(`A: 1\n${"B: 2\n".repeat(1000)}`);
    expect(readHeaderBlock(raw, 20).length).toBeLessThan(6);
  });
});

describe("flagsFromHeaders", () => {
  const flags = (text: string) => flagsFromHeaders(readHeaderBlock(Buffer.from(`${text}\n\n`)));

  it("maps Status, X-Status and X-Mozilla-Status and orders the result", () => {
    expect(flags("Status: RO")).toEqual(["\\Seen"]);
    expect(flags("X-Status: TFA")).toEqual(["\\Answered", "\\Flagged", "\\Draft"]);
    expect(flags("X-Mozilla-Status: 0007")).toEqual(["\\Seen", "\\Answered", "\\Flagged"]);
    expect(flags("Status: R\nX-Mozilla-Status: 0001")).toEqual(["\\Seen"]);
  });

  it("does not carry deleted or expunged messages' flag and ignores junk values", () => {
    expect(flags("Status: D\nX-Status: D\nX-Mozilla-Status: 0008")).toEqual([]);
    expect(flags("X-Mozilla-Status: hello")).toEqual([]);
    expect(flags("X-Mozilla-Status: 123456789")).toEqual([]);
  });

  it("marks Outlook drafts saved as EML", () => {
    expect(flags("X-Unsent: 1")).toEqual(["\\Draft"]);
    expect(flags("X-Unsent: 0")).toEqual([]);
  });
});

describe("dates", () => {
  it("parses ctime From lines, with and without zones", () => {
    expect(parseFromLineDate("MAILER-DAEMON Fri Jul  8 12:08:34 2011")?.toISOString()).toBe(
      "2011-07-08T12:08:34.000Z",
    );
    expect(parseFromLineDate("- Thu Sep 30 12:00:00 2021")?.toISOString()).toBe(
      "2021-09-30T12:00:00.000Z",
    );
    expect(parseFromLineDate("a@example.test Sat Jan  3 01:05:34 CET 1996")?.toISOString()).toBe(
      "1996-01-03T01:05:34.000Z",
    );
    expect(parseFromLineDate("a@example.test Sat Jan  3 01:05:34 +0200 1996")?.toISOString()).toBe(
      "1996-01-02T23:05:34.000Z",
    );
    expect(parseFromLineDate("a@example.test Sat Jan  3 01:05 1996")?.toISOString()).toBe(
      "1996-01-03T01:05:00.000Z",
    );
  });

  it("rejects nonsense", () => {
    expect(parseFromLineDate("")).toBeNull();
    expect(parseFromLineDate("a@example.test")).toBeNull();
    expect(parseFromLineDate("a@example.test Sat Jan 40 01:05:34 1996")).toBeNull();
    expect(parseFromLineDate("a@example.test Sat Jan  3 25:05:34 1996")).toBeNull();
    expect(parseFromLineDate("a@example.test Sat Jan  3 01:05:34 1901")).toBeNull();
  });

  it("parses RFC 5322 dates including comments", () => {
    expect(parseHeaderDate("Mon, 15 Jan 2024 10:00:00 +0100 (CET)")?.toISOString()).toBe(
      "2024-01-15T09:00:00.000Z",
    );
    expect(parseHeaderDate("15 Jan 2024 10:00:00 GMT")?.toISOString()).toBe(
      "2024-01-15T10:00:00.000Z",
    );
    expect(parseHeaderDate("not a date")).toBeNull();
    expect(parseHeaderDate("   ")).toBeNull();
  });

  it("handles nested comments and takes unbalanced parentheses as junk", () => {
    expect(parseHeaderDate("Mon, 15 Jan (a (b) c) 2024 10:00:00 +0000")?.toISOString()).toBe(
      "2024-01-15T10:00:00.000Z",
    );
    expect(parseHeaderDate("Mon, 15 Jan 2024 10:00:00 +0000 (unclosed")?.toISOString()).toBe(
      "2024-01-15T10:00:00.000Z",
    );
    expect(parseHeaderDate(")))) Mon, 15 Jan 2024 10:00:00 +0000")?.toISOString()).toBe(
      "2024-01-15T10:00:00.000Z",
    );
  });

  it("refuses a date value a megabyte long in no time (it was quadratic in the parentheses)", () => {
    const started = Date.now();
    for (const filler of ["(", ")(", "( ", "(a"]) {
      expect(parseHeaderDate(filler.repeat(600_000))).toBeNull();
    }
    const received = readHeaderBlock(
      Buffer.from(
        `Received: from a by b; ${"(".repeat(900_000)}\nDate: Mon, 15 Jan 2024 10:00:00 +0000\n\n`,
      ),
    );
    expect(receivedOrSentDate(received)?.toISOString()).toBe("2024-01-15T10:00:00.000Z");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("prefers the topmost Received date, then Date", () => {
    const headers = readHeaderBlock(
      Buffer.from(
        "Received: from b by c; Tue, 16 Jan 2024 08:30:00 +0000\nReceived: from a by b; Mon, 15 Jan 2024 08:30:00 +0000\nDate: Sun, 14 Jan 2024 08:30:00 +0000\n\n",
      ),
    );
    expect(receivedOrSentDate(headers)?.toISOString()).toBe("2024-01-16T08:30:00.000Z");
    expect(
      receivedOrSentDate(
        readHeaderBlock(Buffer.from("Date: Sun, 14 Jan 2024 08:30:00 +0000\n\n")),
      )?.toISOString(),
    ).toBe("2024-01-14T08:30:00.000Z");
    expect(
      receivedOrSentDate(readHeaderBlock(Buffer.from("Received: nothing to see\n\n"))),
    ).toBeNull();
  });
});
