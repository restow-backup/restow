import { describe, expect, it } from "vitest";
import {
  USAGE,
  UsageError,
  firstLine,
  formatAdmins,
  formatRecovery,
  parseCommand,
} from "./main.js";

describe("parseCommand", () => {
  it("shows the help without arguments and on request", () => {
    expect(parseCommand([])).toEqual({ kind: "help" });
    expect(parseCommand(["help"])).toEqual({ kind: "help" });
    expect(parseCommand(["--help"])).toEqual({ kind: "help" });
  });

  it("parses admin list", () => {
    expect(parseCommand(["admin", "list"])).toEqual({ kind: "list" });
  });

  it("parses admin recover with its options in any order", () => {
    expect(parseCommand(["admin", "recover", "--email", "owner@example.com"])).toEqual({
      kind: "recover",
      email: "owner@example.com",
      passwordStdin: false,
      yes: false,
    });
    expect(
      parseCommand(["admin", "recover", "--yes", "--password-stdin", "--email=owner@example.com"]),
    ).toEqual({
      kind: "recover",
      email: "owner@example.com",
      passwordStdin: true,
      yes: true,
    });
  });

  it("refuses what it does not know, and recover without an address", () => {
    for (const args of [
      ["setup"],
      ["admin"],
      ["admin", "delete"],
      ["admin", "list", "--all"],
      ["admin", "recover"],
      ["admin", "recover", "--email"],
      ["admin", "recover", "--email", "owner"],
      ["admin", "recover", "--email", "owner@example.com", "--password", "secret"],
      ["admin", "recover", "--email", "owner@example.com", "--keep-passkeys"],
    ]) {
      expect(() => parseCommand(args), args.join(" ")).toThrow(UsageError);
    }
  });

  it("documents every command it parses", () => {
    expect(USAGE).toContain("admin list");
    expect(USAGE).toContain("admin recover --email <address>");
    expect(USAGE).toContain("docker compose exec api restow");
  });
});

describe("firstLine", () => {
  it("takes the password from the first line of standard input only", () => {
    expect(firstLine("correct-horse-battery\nsecond line\n")).toBe("correct-horse-battery");
    expect(firstLine("correct-horse-battery\r\n")).toBe("correct-horse-battery");
    expect(firstLine("")).toBe("");
  });
});

describe("formatAdmins", () => {
  it("lists the administrators as a table", () => {
    const text = formatAdmins([
      {
        email: "owner@example.com",
        name: "Owner",
        teamRole: "owner",
        password: true,
        authenticatorApp: true,
        passkeys: 2,
        disabled: false,
      },
      {
        email: "tech@example.com",
        name: "Tech",
        teamRole: "technician",
        password: true,
        authenticatorApp: false,
        passkeys: 0,
        disabled: true,
      },
    ]);
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^EMAIL\s+NAME\s+ROLE\s+PASSWORD\s+AUTHENTICATOR\s+PASSKEYS\s+STATE$/);
    expect(lines[1]).toMatch(/^owner@example\.com\s+Owner\s+owner\s+yes\s+yes\s+2\s+active$/);
    expect(lines[2]).toMatch(/^tech@example\.com\s+Tech\s+technician\s+yes\s+no\s+0\s+disabled$/);
  });

  it("says so when there is no administrator yet", () => {
    expect(formatAdmins([])).toContain("no administrator yet");
  });
});

describe("formatRecovery", () => {
  it("says what changed and what the owner does next, without any secret", () => {
    const text = formatRecovery(
      {
        userId: "u1",
        email: "owner@example.com",
        passwordCreated: false,
        authenticatorRemoved: true,
        passkeysRemoved: 2,
        sessionsEnded: 3,
      },
      "https://restow.example.com/login",
    );
    expect(text).toContain("password replaced");
    expect(text).toContain("authenticator app removed");
    expect(text).toContain("2 passkey(s) removed");
    expect(text).toContain("3 session(s) ended");
    expect(text).toContain("Sign in at https://restow.example.com/login with owner@example.com");
    expect(text).toContain("set up an authenticator app");
  });
});
