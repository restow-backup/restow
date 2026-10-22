import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type ArchiveMatchCandidate,
  bodyHash,
  type CaptureIdentity,
  captureRank,
  decideDuplicate,
  messageKey,
} from "./identity.js";
import type { ArchiveSource } from "./types.js";

describe("messageKey", () => {
  it("normalizes like lower(btrim(message_id, '<> '))", () => {
    expect(messageKey("<ABC@Example.COM>")).toBe("abc@example.com");
    expect(messageKey("  <abc@example.com> ")).toBe("abc@example.com");
    expect(messageKey("abc@example.com")).toBe("abc@example.com");
    // Only the ends: inner brackets stay.
    expect(messageKey("<a<b>c>")).toBe("a<b>c");
  });

  it("is null for nothing", () => {
    expect(messageKey(null)).toBeNull();
    expect(messageKey(undefined)).toBeNull();
    expect(messageKey("")).toBeNull();
    expect(messageKey("<>")).toBeNull();
    expect(messageKey("  ")).toBeNull();
  });
});

describe("bodyHash", () => {
  const sha = (text: string) =>
    createHash("sha256").update(Buffer.from(text, "latin1")).digest("hex");

  it("hashes only the body, not the headers", () => {
    const journal = Buffer.from("Received: from a\r\nSubject: Hi\r\n\r\nHello\r\nWorld\r\n");
    const mailbox = Buffer.from("Subject: Hi\r\nX-MS-Exchange: 1\r\n\r\nHello\r\nWorld\r\n");
    expect(bodyHash(journal)).toBe(bodyHash(mailbox));
    expect(bodyHash(journal)).toBe(sha("Hello\r\nWorld"));
  });

  it("normalizes line ends, trailing whitespace and trailing empty lines", () => {
    const crlf = Buffer.from("A: b\r\n\r\nline one  \r\nline two\t\r\n\r\n\r\n");
    const lf = Buffer.from("A: b\n\nline one\nline two\n");
    expect(bodyHash(crlf)).toBe(bodyHash(lf));
    expect(bodyHash(lf)).toBe(sha("line one\r\nline two"));
  });

  it("keeps differences inside the body", () => {
    const one = Buffer.from("A: b\r\n\r\nHello world\r\n");
    const other = Buffer.from("A: b\r\n\r\nHello  world\r\n");
    expect(bodyHash(one)).not.toBe(bodyHash(other));
  });

  it("works on bytes, whatever the charset", () => {
    const latin = Buffer.from([0x41, 0x0d, 0x0a, 0x0d, 0x0a, 0xe4, 0xff, 0x00, 0x0d, 0x0a]);
    expect(bodyHash(latin)).toBe(
      createHash("sha256")
        .update(Buffer.from([0xe4, 0xff, 0x00]))
        .digest("hex"),
    );
  });

  it("hashes an empty body for a message without one", () => {
    expect(bodyHash(Buffer.from("Subject: only headers\r\n"))).toBe(sha(""));
  });
});

describe("captureRank", () => {
  it("ranks transport over mailbox over import", () => {
    expect(captureRank("journal")).toBe(2);
    expect(captureRank("smtp_forward")).toBe(2);
    expect(captureRank("graph_sync")).toBe(1);
    expect(captureRank("imap_sync")).toBe(1);
    expect(captureRank("file_import")).toBe(0);
  });
});

describe("decideDuplicate", () => {
  const capture = (
    source: ArchiveSource,
    overrides: Partial<CaptureIdentity> = {},
  ): CaptureIdentity => ({
    source,
    itemHash: "hash-c",
    bodyHash: "body-1",
    messageKey: "m@example.com",
    ...overrides,
  });
  const existing = (
    id: string,
    source: ArchiveSource,
    overrides: Partial<ArchiveMatchCandidate> = {},
  ): ArchiveMatchCandidate => ({
    id,
    source,
    itemHash: "hash-e",
    bodyHash: "body-1",
    messageKey: "m@example.com",
    ...overrides,
  });

  it("is new without candidates", () => {
    expect(decideDuplicate(capture("graph_sync"), [])).toEqual({
      kind: "new",
      supersedes: null,
      conflict: false,
    });
  });

  // rank(capture) x rank(existing) with a body match
  const table: [ArchiveSource, ArchiveSource, "duplicate" | "supersedes"][] = [
    ["graph_sync", "journal", "duplicate"],
    ["imap_sync", "smtp_forward", "duplicate"],
    ["imap_sync", "imap_sync", "duplicate"],
    ["graph_sync", "graph_sync", "duplicate"],
    ["journal", "journal", "duplicate"],
    ["smtp_forward", "journal", "duplicate"],
    ["file_import", "imap_sync", "duplicate"],
    ["journal", "graph_sync", "supersedes"],
    ["smtp_forward", "imap_sync", "supersedes"],
    ["imap_sync", "file_import", "supersedes"],
    ["journal", "file_import", "supersedes"],
  ];
  for (const [newSource, oldSource, outcome] of table) {
    it(`${newSource} after ${oldSource}: ${outcome}`, () => {
      const decision = decideDuplicate(capture(newSource), [existing("e1", oldSource)]);
      expect(decision).toEqual(
        outcome === "duplicate"
          ? { kind: "duplicate", of: "e1" }
          : { kind: "new", supersedes: "e1", conflict: false },
      );
    });
  }

  it("matches on the exact bytes even without a Message-ID or body hash", () => {
    const decision = decideDuplicate(capture("imap_sync", { messageKey: null, bodyHash: null }), [
      existing("e1", "imap_sync", { itemHash: "hash-c", messageKey: null, bodyHash: null }),
    ]);
    expect(decision).toEqual({ kind: "duplicate", of: "e1" });
  });

  it("does not match by body hash without a Message-ID", () => {
    const decision = decideDuplicate(capture("imap_sync", { messageKey: null }), [
      existing("e1", "imap_sync", { messageKey: null }),
    ]);
    expect(decision).toEqual({ kind: "new", supersedes: null, conflict: false });
  });

  it("does not match by body hash an item from before 0.4.4 (no body hash)", () => {
    const decision = decideDuplicate(capture("graph_sync"), [
      existing("e1", "journal", { bodyHash: null }),
    ]);
    expect(decision).toEqual({ kind: "new", supersedes: null, conflict: true });
  });

  it("flags the same Message-ID with another body as a conflict and keeps both", () => {
    const decision = decideDuplicate(capture("imap_sync"), [
      existing("e1", "journal", { bodyHash: "body-2" }),
    ]);
    expect(decision).toEqual({ kind: "new", supersedes: null, conflict: true });
  });

  it("takes the strongest match, the oldest among equals", () => {
    const candidates = [
      existing("graph", "graph_sync"),
      existing("journal-1", "journal"),
      existing("journal-2", "journal"),
    ];
    expect(decideDuplicate(capture("imap_sync"), candidates)).toEqual({
      kind: "duplicate",
      of: "journal-1",
    });
    expect(decideDuplicate(capture("smtp_forward"), candidates)).toEqual({
      kind: "duplicate",
      of: "journal-1",
    });
  });

  it("keeps every capture under the keep policy, still naming the weaker one it supersedes", () => {
    expect(decideDuplicate(capture("journal"), [existing("e1", "journal")], "keep")).toEqual({
      kind: "new",
      supersedes: null,
      conflict: false,
    });
    expect(decideDuplicate(capture("journal"), [existing("e1", "graph_sync")], "keep")).toEqual({
      kind: "new",
      supersedes: "e1",
      conflict: false,
    });
  });
});
