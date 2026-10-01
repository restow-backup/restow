import { describe, expect, it } from "vitest";
import {
  decodeFlags,
  encodeFlags,
  escapeComponent,
  folderComponents,
  folderObjectPath,
  messageObjectId,
  messageObjectPath,
  objectUid,
  parseMessageObjectId,
  unescapeComponent,
} from "./paths.js";

describe("object paths", () => {
  it("builds folder and message paths from hierarchy components", () => {
    const components = folderComponents({ name: "Restow", parent: ["Projects", "2026"] });
    expect(folderObjectPath(components)).toBe("mail/Projects/2026/Restow");
    expect(messageObjectPath(components, 42)).toBe("mail/Projects/2026/Restow/42.eml");
  });

  it("escapes slashes and percent signs inside a component reversibly", () => {
    const name = "Q1/Q2 100%";
    expect(escapeComponent(name)).toBe("Q1%2FQ2 100%25");
    expect(unescapeComponent(escapeComponent(name))).toBe(name);
    expect(folderObjectPath(["a/b", "c"])).toBe("mail/a%2Fb/c");
  });
});

describe("object ids", () => {
  it("round-trips folder paths that contain colons", () => {
    const id = messageObjectId("Archive:2025/Q1", "1700000000", 7);
    expect(id).toBe("imap:Archive:2025/Q1:1700000000:7");
    expect(parseMessageObjectId(id)).toEqual({
      folderPath: "Archive:2025/Q1",
      uidValidity: "1700000000",
      uid: 7,
    });
  });

  it("rejects ids that are not IMAP message ids", () => {
    expect(parseMessageObjectId("graph:abc")).toBeNull();
    expect(parseMessageObjectId("imap:INBOX")).toBeNull();
    expect(parseMessageObjectId("imap:INBOX:x:1")).toBeNull();
    expect(parseMessageObjectId("imap:INBOX:1000:0")).toBeNull();
  });
});

describe("flags", () => {
  it("encodes sorted and unique, decodes to a list", () => {
    expect(encodeFlags(["\\Seen", "\\Answered", "\\Seen"])).toBe("\\Answered \\Seen");
    expect(decodeFlags("\\Answered \\Seen")).toEqual(["\\Answered", "\\Seen"]);
    expect(decodeFlags("")).toEqual([]);
    expect(decodeFlags(undefined)).toEqual([]);
  });
});

describe("objectUid", () => {
  it("reads a valid uid and rejects everything else", () => {
    const base = { path: "p", size: 0, mtime: 0, chunks: [] };
    expect(objectUid({ ...base, metadata: { uid: "12" } })).toBe(12);
    expect(objectUid({ ...base, metadata: { uid: "abc" } })).toBeNull();
    expect(objectUid({ ...base, metadata: { uid: "0" } })).toBeNull();
    expect(objectUid(base)).toBeNull();
  });
});
