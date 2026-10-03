import { describe, expect, it } from "vitest";

import { buildImportPayload, isSingleLoginEntry, parseBareEntries } from "./accounts-dialog";

describe("isSingleLoginEntry", () => {
  it("accepts a bare login with no other column", () => {
    expect(isSingleLoginEntry("alice@example.com")).toBe(true);
  });

  it("accepts the documented one-line login;name and login,name,email forms", () => {
    expect(isSingleLoginEntry("buchhaltung@example.com;Buchhaltung")).toBe(true);
    expect(isSingleLoginEntry("alice@example.com;Alice Smith")).toBe(true);
    expect(isSingleLoginEntry("alice,Alice Smith,alice@example.com")).toBe(true);
    expect(isSingleLoginEntry("alice\tAlice Smith")).toBe(true);
  });

  it("ignores surrounding blank lines and whitespace", () => {
    expect(isSingleLoginEntry("\n  alice@example.com;Alice  \n\n")).toBe(true);
  });

  it("rejects more than one line", () => {
    expect(isSingleLoginEntry("alice@example.com\nbob@example.com")).toBe(false);
  });

  it("rejects a line with more than the three positional columns", () => {
    expect(isSingleLoginEntry("alice,Alice Smith,alice@example.com,extra")).toBe(false);
  });

  it("rejects a line that names a recognised CSV header column", () => {
    expect(isSingleLoginEntry("login,name,email")).toBe(false);
    expect(isSingleLoginEntry("login;password")).toBe(false);
  });
});

describe("parseBareEntries", () => {
  it("returns one entry per line with login, name and address", () => {
    expect(parseBareEntries("anna@example.com\nbuero;Büro;buero@example.com\n")).toEqual([
      { login: "anna@example.com", displayName: "", email: "" },
      { login: "buero", displayName: "Büro", email: "buero@example.com" },
    ]);
  });

  it("returns null for an empty box and for CSV-shaped text", () => {
    expect(parseBareEntries("  \n")).toBeNull();
    expect(parseBareEntries("login,password\nanna,secret")).toBeNull();
    expect(parseBareEntries("a,b,c,d")).toBeNull();
  });
});

describe("buildImportPayload", () => {
  const text = "anna@example.com\nbob@example.com;Bob";
  const entries = parseBareEntries(text);

  it("sends the box untouched when nothing was entered per mailbox", () => {
    expect(buildImportPayload(text, entries, {})).toBe(text);
    expect(
      buildImportPayload(text, entries, { "anna@example.com": { password: "", username: " " } }),
    ).toBe(text);
  });

  it("sends CSV text as typed when the box is not bare entries", () => {
    const csv = "login,password\nanna,secret";
    expect(buildImportPayload(csv, null, { anna: { password: "x", username: "" } })).toBe(csv);
  });

  it("builds a header CSV with a password column for every entry", () => {
    expect(
      buildImportPayload(text, entries, {
        "anna@example.com": { password: 'p,"w"', username: "" },
      }),
    ).toBe('login,name,email,password\nanna@example.com,,,"p,""w"""\nbob@example.com,Bob,,');
  });

  it("uses a username as the login and keeps the mailbox as the address", () => {
    expect(
      buildImportPayload(text, entries, {
        "bob@example.com": { password: "pw", username: " bob.login " },
      }),
    ).toBe("login,name,email,password\nanna@example.com,,,\nbob.login,Bob,bob@example.com,pw");
  });
});
