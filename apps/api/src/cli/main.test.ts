import { describe, expect, it } from "vitest";
import {
  firstLine,
  formatAdmins,
  formatRecovery,
  parseCommand,
  USAGE,
  UsageError,
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

describe("parseCommand: restore-mode", () => {
  it("parses on, status, check, import-keys and off", () => {
    expect(parseCommand(["restore-mode", "on", "--reason", "rollback", "--yes"])).toEqual({
      kind: "restore-mode-on",
      reason: "rollback",
      yes: true,
    });
    expect(parseCommand(["restore-mode", "status", "--json"])).toEqual({
      kind: "restore-mode-status",
      json: true,
    });
    expect(parseCommand(["restore-mode", "check"])).toEqual({ kind: "restore-mode-check" });
    expect(
      parseCommand([
        "restore-mode",
        "import-keys",
        "--tenant=5a0c7c1e-8d2b-4c3a-9f1e-2b3c4d5e6f70",
      ]),
    ).toEqual({
      kind: "restore-mode-import-keys",
      tenantId: "5a0c7c1e-8d2b-4c3a-9f1e-2b3c4d5e6f70",
      yes: false,
    });
    expect(
      parseCommand([
        "restore-mode",
        "off",
        "--email",
        "owner@example.com",
        "--checked",
        "Compared the restore points with the tickets.",
        "--accept-unreachable",
        "t1/copy",
        "--accept-unreachable=t2/copy",
      ]),
    ).toEqual({
      kind: "restore-mode-off",
      email: "owner@example.com",
      checked: "Compared the restore points with the tickets.",
      storageOnlyData: "keep",
      acceptUnreachable: ["t1/copy", "t2/copy"],
      yes: false,
    });
  });

  it("refuses an incomplete restore-mode command line", () => {
    for (const args of [
      ["restore-mode"],
      ["restore-mode", "pause"],
      ["restore-mode", "on"],
      ["restore-mode", "on", "--reason"],
      ["restore-mode", "check", "--force"],
      ["restore-mode", "import-keys", "--tenant", "contoso"],
      ["restore-mode", "off", "--checked", "Compared the restore points with the tickets."],
      ["restore-mode", "off", "--email", "owner@example.com", "--checked", "too short"],
      [
        "restore-mode",
        "off",
        "--email",
        "owner@example.com",
        "--checked",
        "Compared the restore points with the tickets.",
        "--storage-only-data",
        "delete",
      ],
    ]) {
      expect(() => parseCommand(args), args.join(" ")).toThrow(UsageError);
    }
  });

  it("documents the restore-mode commands", () => {
    for (const text of [
      "restore-mode status",
      "restore-mode on --reason",
      "restore-mode check",
      "restore-mode import-keys",
      "restore-mode off --email <owner> --checked <text>",
      "docker compose run --rm --no-deps --entrypoint restow api restore-mode on",
    ]) {
      expect(USAGE).toContain(text);
    }
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
