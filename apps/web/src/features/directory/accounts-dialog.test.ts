import { describe, expect, it } from "vitest";

import { isSingleLoginEntry } from "./accounts-dialog";

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
