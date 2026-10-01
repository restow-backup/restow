import { describe, expect, it } from "vitest";
import { asctime, buildMbox, quoteFromLines } from "./mbox.js";

describe("mbox", () => {
  it("formats the From line date in asctime form (UTC)", () => {
    expect(asctime(new Date("2026-09-01T12:05:09Z"))).toBe("Tue Sep  1 12:05:09 2026");
    expect(asctime(new Date("2024-12-24T23:59:59Z"))).toBe("Tue Dec 24 23:59:59 2024");
  });

  it("quotes From lines the mboxrd way", () => {
    expect(quoteFromLines("a\nFrom here\n>From there\n>>From far\nnot From\n")).toBe(
      "a\n>From here\n>>From there\n>>>From far\nnot From\n",
    );
  });

  it("separates messages by a blank line and uses CRLF throughout", () => {
    const mbox = buildMbox([
      {
        from: "a@example.org",
        date: new Date("2026-01-02T03:04:05Z"),
        eml: "Subject: one\n\nbody\nFrom me\n",
      },
      {
        from: "b@example.org",
        date: new Date("2026-01-03T00:00:00Z"),
        eml: "Subject: two\r\n\r\nx",
      },
    ]).toString("utf8");
    expect(mbox).toBe(
      "From a@example.org Fri Jan  2 03:04:05 2026\r\nSubject: one\r\n\r\nbody\r\n>From me\r\n\r\n" +
        "From b@example.org Sat Jan  3 00:00:00 2026\r\nSubject: two\r\n\r\nx\r\n\r\n",
    );
    expect(mbox).not.toMatch(/[^\r]\n/);
  });
});
