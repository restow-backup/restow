import { describe, expect, it } from "vitest";
import {
  ExportNames,
  MAX_NAME_BYTES,
  messageNameBase,
  sanitizeFolderComponent,
  sanitizeName,
  truncateUtf8,
} from "./names.js";

const RLO = String.fromCodePoint(0x202e);
const ZERO_WIDTH = String.fromCodePoint(0x200b);
const COMBINING_ACUTE = String.fromCodePoint(0x301);
const NBSP = String.fromCodePoint(0xa0);

describe("sanitizeName", () => {
  it("replaces the characters Windows refuses and both separators", () => {
    expect(sanitizeName('a<b>c:d"e/f\\g|h?i*j')).toBe("a_b_c_d_e_f_g_h_i_j");
    expect(sanitizeName("Re: Quarterly / Q3?")).toBe("Re_ Quarterly _ Q3_");
  });

  it("removes control characters and folds white space", () => {
    expect(sanitizeName("line one\r\nline\ttwo\u0000\u0007end")).toBe("line one line twoend");
    expect(sanitizeName(`a${NBSP}${NBSP}b`)).toBe("a b");
  });

  it("removes bidirectional overrides and zero-width characters", () => {
    expect(sanitizeName(`invoice${RLO}fdp.exe`)).toBe("invoicefdp.exe");
    expect(sanitizeName(`a${ZERO_WIDTH}b`)).toBe("ab");
  });

  it("drops trailing dots and spaces and leading spaces", () => {
    expect(sanitizeName("report. . ")).toBe("report");
    expect(sanitizeName("   padded name   ")).toBe("padded name");
    expect(sanitizeName("...")).toBe("");
    expect(sanitizeName(".")).toBe("");
    expect(sanitizeName("..")).toBe("");
    expect(sanitizeName("")).toBe("");
    expect(sanitizeName(".hidden")).toBe(".hidden");
  });

  it("prefixes Windows device names, with or without an extension", () => {
    expect(sanitizeName("CON")).toBe("_CON");
    expect(sanitizeName("nul")).toBe("_nul");
    expect(sanitizeName("Com1.txt")).toBe("_Com1.txt");
    expect(sanitizeName("LPT9")).toBe("_LPT9");
    expect(sanitizeName("Console")).toBe("Console");
    expect(sanitizeName("COM10")).toBe("COM10");
  });

  it("composes decomposed letters", () => {
    const decomposed = `e${COMBINING_ACUTE}`;
    expect(sanitizeName(`caf${decomposed}`)).toBe("caf\u00e9");
  });

  it("replaces a lone surrogate", () => {
    const cleaned = sanitizeName("x\ud800y");
    expect(cleaned).not.toMatch(/[\ud800-\udfff]/);
    expect(cleaned.length).toBe(3);
  });

  it("cuts long names at a code point boundary within the byte limit", () => {
    const long = "\u00e4".repeat(200);
    const cut = sanitizeName(long);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(cut).toBe("\u00e4".repeat(MAX_NAME_BYTES / 2));

    const emoji = "\u{1f389}".repeat(50);
    const cutEmoji = sanitizeName(emoji);
    expect(Buffer.byteLength(cutEmoji)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect([...cutEmoji].every((char) => char === "\u{1f389}")).toBe(true);
    expect(cutEmoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("keeps German umlauts, emoji and CJK", () => {
    expect(sanitizeName("Gr\u00fc\u00dfe aus K\u00f6ln \u{1f389}")).toBe(
      "Gr\u00fc\u00dfe aus K\u00f6ln \u{1f389}",
    );
    expect(sanitizeName("\u65e5\u672c\u8a9e\u306e\u4ef6\u540d")).toBe(
      "\u65e5\u672c\u8a9e\u306e\u4ef6\u540d",
    );
  });
});

describe("truncateUtf8", () => {
  it("never splits a code point", () => {
    expect(truncateUtf8("abc", 10)).toBe("abc");
    expect(truncateUtf8("ab\u00e4c", 3)).toBe("ab");
    expect(truncateUtf8("ab\u{1f389}", 5)).toBe("ab");
    expect(truncateUtf8("ab\u{1f389}", 6)).toBe("ab\u{1f389}");
    expect(truncateUtf8("abc", 0)).toBe("");
  });
});

describe("sanitizeFolderComponent", () => {
  it("never returns something a file system would read as a path", () => {
    expect(sanitizeFolderComponent("..")).toBe("_");
    expect(sanitizeFolderComponent(".")).toBe("_");
    expect(sanitizeFolderComponent("")).toBe("_");
    expect(sanitizeFolderComponent("   ")).toBe("_");
    expect(sanitizeFolderComponent("a/b")).toBe("a_b");
    expect(sanitizeFolderComponent("..\\..\\etc")).toBe(".._.._etc");
  });
});

describe("messageNameBase", () => {
  it("is `<yyyy-mm-dd> <subject>` in UTC", () => {
    expect(
      messageNameBase({ date: new Date(Date.UTC(2024, 2, 5, 23, 59)), subject: "Hello" }),
    ).toBe("2024-03-05 Hello");
    expect(messageNameBase({ date: new Date("2024-03-05T00:00:00+02:00"), subject: "Hello" })).toBe(
      "2024-03-04 Hello",
    );
  });

  it("marks missing dates and subjects", () => {
    expect(messageNameBase({ date: null, subject: "Hello" })).toBe("undated Hello");
    expect(messageNameBase({ date: new Date(Number.NaN), subject: "Hello" })).toBe("undated Hello");
    expect(messageNameBase({ date: new Date(Date.UTC(2024, 0, 1)), subject: null })).toBe(
      "2024-01-01 (no subject)",
    );
    expect(messageNameBase({ date: new Date(Date.UTC(2024, 0, 1)), subject: " / " })).toBe(
      "2024-01-01 _",
    );
    expect(messageNameBase({ date: new Date(Date.UTC(2024, 0, 1)), subject: "..." })).toBe(
      "2024-01-01 (no subject)",
    );
  });

  it("stays within the byte limit for any subject", () => {
    const base = messageNameBase({
      date: new Date(Date.UTC(2024, 0, 1)),
      subject: "\u{1f389}x".repeat(500),
    });
    expect(Buffer.byteLength(base)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(base.startsWith("2024-01-01 ")).toBe(true);
  });
});

describe("ExportNames", () => {
  const message = { date: new Date(Date.UTC(2024, 2, 5)), subject: "Hello" };

  it("numbers repeated names, case- and normalisation-insensitively", () => {
    const names = new ExportNames();
    const inbox = names.folder(["Inbox"]);
    expect(names.messageEntry(inbox, message)).toBe("Inbox/2024-03-05 Hello.eml");
    expect(names.messageEntry(inbox, message)).toBe("Inbox/2024-03-05 Hello (2).eml");
    expect(names.messageEntry(inbox, { ...message, subject: "HELLO" })).toBe(
      "Inbox/2024-03-05 HELLO (3).eml",
    );
    // The same subject in another folder starts again.
    expect(names.messageEntry(names.folder(["Sent"]), message)).toBe("Sent/2024-03-05 Hello.eml");

    const composed = { ...message, subject: "caf\u00e9" };
    const decomposed = { ...message, subject: `cafe${COMBINING_ACUTE}` };
    expect(names.messageEntry(inbox, composed)).toBe("Inbox/2024-03-05 caf\u00e9.eml");
    expect(names.messageEntry(inbox, decomposed)).toBe("Inbox/2024-03-05 caf\u00e9 (2).eml");
  });

  it("puts root messages at the top", () => {
    const names = new ExportNames();
    expect(names.messageEntry(names.folder([]), message)).toBe("2024-03-05 Hello.eml");
  });

  it("maps a folder to the same components every time and keeps different folders apart", () => {
    const names = new ExportNames();
    expect(names.folder(["Inbox", "Projects"])).toEqual(["Inbox", "Projects"]);
    expect(names.folder(["Inbox", "Projects"])).toEqual(["Inbox", "Projects"]);
    expect(names.folder(["INBOX"])).toEqual(["INBOX (2)"]);
    expect(names.folder(["INBOX", "Projects"])).toEqual(["INBOX (2)", "Projects"]);
    expect(names.folder(["a:b"])).toEqual(["a_b"]);
    expect(names.folder(["a?b"])).toEqual(["a_b (2)"]);
    expect(names.folder(["a/b", "c"])).toEqual(["a_b (3)", "c"]);
  });

  it("neutralises `..`, empty and separator-carrying components", () => {
    const names = new ExportNames();
    const path = names.folder(["..", "", "../../etc", "C:\\Windows", "  "]);
    expect(path.join("/")).not.toMatch(/(^|\/)\.\.(\/|$)/);
    expect(path.every((part) => part.length > 0 && !/[/\\]/.test(part))).toBe(true);
    expect(path[0]).toBe("_");
    expect(path[1]).toBe("_");
    expect(path[2]).toBe(".._.._etc");
  });

  it("does not let a folder or message take the names of MANIFEST.csv and SHA256SUMS", () => {
    const names = new ExportNames();
    expect(names.folder(["manifest.csv"])).toEqual(["manifest.csv (2)"]);
    expect(names.folder(["SHA256SUMS"])).toEqual(["SHA256SUMS (2)"]);
  });

  it("names the MBOX file of a folder next to its subfolders", () => {
    const names = new ExportNames();
    expect(names.mboxEntry(["Inbox"])).toBe("Inbox.mbox");
    expect(names.mboxEntry(["Inbox", "2019"])).toBe("Inbox/2019.mbox");
    expect(names.mboxEntry(["Inbox", "2019"])).toBe("Inbox/2019 (2).mbox");
    expect(names.mboxEntry([])).toBe("Messages.mbox");
    // A folder called `Inbox.mbox` cannot collide with the file of `Inbox`.
    expect(names.mboxEntry(["Inbox.mbox"])).toBe("Inbox.mbox (2).mbox");
    expect(names.mboxEntry(["Windows", "CON"])).toBe("Windows/_CON.mbox");
  });

  it("is deterministic", () => {
    const run = () => {
      const names = new ExportNames();
      const folder = names.folder(["Inbox"]);
      return [1, 2, 3].map(() => names.messageEntry(folder, message));
    };
    expect(run()).toEqual(run());
  });
});
