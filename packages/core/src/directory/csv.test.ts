import { describe, expect, it } from "vitest";
import {
  detectDelimiter,
  normalizeAccounts,
  parseCsvRecords,
  parseImapAccountsCsv,
} from "./csv.js";

describe("csv helpers", () => {
  it("detects the delimiter from the first line", () => {
    expect(detectDelimiter("a,b,c\n")).toBe(",");
    expect(detectDelimiter("\n\na;b;c")).toBe(";");
    expect(detectDelimiter("login\tname\n")).toBe("\t");
    expect(detectDelimiter("single")).toBe(",");
  });

  it("splits quoted fields with delimiters, doubled quotes and line breaks", () => {
    expect(
      parseCsvRecords('alice@x.y,"Example, Alice","say ""hi"""\r\n\r\nbob,"two\nlines"\n', ","),
    ).toEqual([
      { line: 1, fields: ["alice@x.y", "Example, Alice", 'say "hi"'] },
      { line: 3, fields: ["bob", "two\nlines"] },
    ]);
  });
});

describe("normalizeAccounts", () => {
  it("defaults the address to an address-like login and reports issues", () => {
    const { accounts, issues } = normalizeAccounts([
      { line: null, login: "alice@example.test", displayName: " Alice " },
      { line: null, login: "ALICE@example.test" },
      { line: null, login: "bob", email: "bob@example.test" },
      { line: null, login: "carol", email: "nope" },
      { line: null, login: "   " },
      { line: null, login: "dave" },
    ]);
    expect(accounts).toEqual([
      { login: "alice@example.test", email: "alice@example.test", displayName: "Alice" },
      { login: "bob", email: "bob@example.test", displayName: null },
      { login: "dave", email: "dave", displayName: null },
    ]);
    expect(issues).toEqual([
      { line: null, reason: "duplicate_login", value: "ALICE@example.test" },
      { line: null, reason: "invalid_email", value: "nope" },
      { line: null, reason: "missing_login", value: null },
    ]);
  });

  it("is idempotent", () => {
    const once = normalizeAccounts([
      { line: 1, login: "dave" },
      { line: 2, login: "erin@example.test", displayName: "Erin" },
    ]);
    const twice = normalizeAccounts(once.accounts.map((account) => ({ line: null, ...account })));
    expect(twice).toEqual({ accounts: once.accounts, issues: [] });
  });

  it("never trims a password, unlike the login, address and display name", () => {
    // Regression: a password is not a name, and leading or trailing
    // whitespace can be part of it; silently stripping it would seal a
    // password that no longer matches what the mailbox expects.
    const { accounts } = normalizeAccounts([
      { line: null, login: "alice", password: " s3cret with spaces " },
    ]);
    expect(accounts[0]?.password).toBe(" s3cret with spaces ");
  });

  it("treats an empty or whitespace-only password cell as no password at all", () => {
    const { accounts } = normalizeAccounts([
      { line: null, login: "alice", password: "" },
      { line: null, login: "bob", password: "   " },
    ]);
    expect(accounts[0]?.password).toBeUndefined();
    expect(accounts[1]?.password).toBeUndefined();
  });
});

describe("parseImapAccountsCsv", () => {
  it("reads a header in any order and any spelling", () => {
    const preview = parseImapAccountsCsv(
      `${String.fromCharCode(0xfeff)}Display Name;Login;E-Mail\nAlice;alice;alice@example.test\n;bob;\n`,
    );
    expect(preview.hasHeader).toBe(true);
    expect(preview.delimiter).toBe(";");
    expect(preview.accounts).toEqual([
      { login: "alice", email: "alice@example.test", displayName: "Alice" },
      { login: "bob", email: "bob", displayName: null },
    ]);
    expect(preview.issues).toEqual([]);
  });

  it("falls back to positional columns without a header", () => {
    const preview = parseImapAccountsCsv("alice@example.test\tAlice\nbob@example.test\n");
    expect(preview.hasHeader).toBe(false);
    expect(preview.delimiter).toBe("\t");
    expect(preview.accounts).toEqual([
      { login: "alice@example.test", email: "alice@example.test", displayName: "Alice" },
      { login: "bob@example.test", email: "bob@example.test", displayName: null },
    ]);
  });

  it("reports missing logins, duplicates and bad addresses with line numbers", () => {
    const preview = parseImapAccountsCsv(
      "login,email\nalice,alice@example.test\n\n,x@y.z\nALICE,other@example.test\ncarol,not an address\n",
    );
    expect(preview.accounts.map((a) => a.login)).toEqual(["alice"]);
    expect(preview.issues).toEqual([
      { line: 4, reason: "missing_login", value: null },
      { line: 5, reason: "duplicate_login", value: "ALICE" },
      { line: 6, reason: "invalid_email", value: "not an address" },
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(parseImapAccountsCsv("")).toEqual({
      accounts: [],
      issues: [],
      hasHeader: false,
      delimiter: ",",
    });
  });

  it("reads an optional password column, any of its spellings, without trimming it", () => {
    // Every other column is trimmed, but a password cell keeps its exact
    // whitespace: leading or trailing spaces can be part of the real password,
    // and trimming them would seal a password that no longer matches the
    // mailbox. Only a cell that is empty or whitespace-only counts as no password.
    const preview = parseImapAccountsCsv("login,password\nalice,s3cret \nbob,\ncarol,  \n");
    expect(preview.accounts).toEqual([
      { login: "alice", email: "alice", displayName: null, password: "s3cret " },
      { login: "bob", email: "bob", displayName: null },
      { login: "carol", email: "carol", displayName: null },
    ]);
    expect(parseImapAccountsCsv("login,pass\nalice,x\n").accounts[0]?.password).toBe("x");
    expect(parseImapAccountsCsv("login,pwd\nalice,x\n").accounts[0]?.password).toBe("x");
  });

  it("never reads a password from the positional (no-header) form", () => {
    // Three positional columns are login, display name, email - never a password.
    const preview = parseImapAccountsCsv("alice@example.test,Alice,alice@other.test\n");
    expect(preview.accounts[0]).toEqual({
      login: "alice@example.test",
      email: "alice@other.test",
      displayName: "Alice",
    });
  });
});
