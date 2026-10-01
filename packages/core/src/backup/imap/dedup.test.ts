import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ManifestObject } from "../../manifest.js";
import { MessageDedupIndex, type StoredContent } from "./dedup.js";

function contentOf(source: Buffer, chunks: string[] = ["c1", "c2"]): StoredContent {
  return {
    size: source.length,
    sha256: createHash("sha256").update(source).digest("hex"),
    chunks,
  };
}

function messageObject(
  source: Buffer,
  metadata: Record<string, string>,
  overrides: Partial<ManifestObject> = {},
): ManifestObject {
  const content = contentOf(source, ["a1"]);
  return {
    path: "mail/INBOX/1.eml",
    type: "message",
    size: content.size,
    sha256: content.sha256,
    mtime: 0,
    chunks: [...content.chunks],
    metadata,
    ...overrides,
  };
}

const original = Buffer.from("Message-ID: <a@test>\r\nSubject: hi\r\n\r\nbody\r\n");

describe("MessageDedupIndex", () => {
  it("finds a stored message by Message-ID and identical bytes", () => {
    const index = new MessageDedupIndex();
    const stored = contentOf(original);
    index.remember("<a@test>", stored);
    expect(index.find("<a@test>", Buffer.from(original))).toBe(stored);
  });

  it("never trusts the Message-ID alone", () => {
    const index = new MessageDedupIndex();
    index.remember("<a@test>", contentOf(original));
    const rewritten = Buffer.from(original.toString().replace("body", "BODY"));
    expect(rewritten.length).toBe(original.length);
    expect(index.find("<a@test>", rewritten)).toBeNull();
    expect(index.find("<other@test>", original)).toBeNull();
  });

  it("does not match without a Message-ID", () => {
    const index = new MessageDedupIndex();
    index.remember(null, contentOf(original));
    expect(index.size).toBe(0);
    expect(index.find(null, original)).toBeNull();
  });

  it("keeps every distinct version that shares a Message-ID", () => {
    const index = new MessageDedupIndex();
    const second = Buffer.concat([original, Buffer.from("X-Extra: 1\r\n")]);
    const first = contentOf(original, ["one"]);
    const other = contentOf(second, ["two"]);
    index.remember("<a@test>", first);
    index.remember("<a@test>", other);
    index.remember("<a@test>", contentOf(original, ["duplicate"]));
    expect(index.find("<a@test>", original)).toBe(first);
    expect(index.find("<a@test>", second)).toBe(other);
  });

  it("indexes IMAP message objects of a manifest and ignores everything else", () => {
    const index = MessageDedupIndex.fromObjects([
      messageObject(original, { mailbox: "INBOX", messageId: "<a@test>" }),
      messageObject(original, { messageId: "<graph@test>" }),
      messageObject(
        original,
        { mailbox: "INBOX", messageId: "<nohash@test>" },
        { sha256: undefined },
      ),
      messageObject(original, { mailbox: "INBOX", messageId: "<folder@test>" }, { type: "folder" }),
    ]);
    expect(index.size).toBe(1);
    expect(index.find("<a@test>", original)?.chunks).toEqual(["a1"]);
  });
});
