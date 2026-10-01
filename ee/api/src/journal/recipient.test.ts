import { describe, expect, it } from "vitest";
import { base32, generateJournalToken, parseJournalToken } from "./recipient.js";

describe("parseJournalToken", () => {
  it("extracts the token from a journal+<token>@host address", () => {
    expect(parseJournalToken("journal+abc123@archive.example.com")).toBe("abc123");
  });

  it("is case-insensitive on the local part prefix", () => {
    expect(parseJournalToken("Journal+abc123@archive.example.com")).toBe("abc123");
  });

  it("returns null for a non-journal address", () => {
    expect(parseJournalToken("someone@example.com")).toBeNull();
  });

  it("returns null when the token is empty", () => {
    expect(parseJournalToken("journal+@archive.example.com")).toBeNull();
  });
});

describe("generateJournalToken", () => {
  it("generates distinct tokens of 32 lowercase letters and digits", () => {
    const a = generateJournalToken();
    const b = generateJournalToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-z2-7]{32}$/);
  });

  it("survives the case folding of a mail address", () => {
    const token = generateJournalToken();
    expect(parseJournalToken(`Journal+${token.toUpperCase()}@Archive.Example.com`)).toBe(token);
    expect(parseJournalToken(`journal+${token}@archive.example.com`)).toBe(token);
  });

  it("encodes bytes as base32 (RFC 4648 test vector, lowercase)", () => {
    expect(base32(new TextEncoder().encode("foobar"))).toBe("mzxw6ytboi");
    expect(base32(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]))).toBe("77777777");
  });
});
