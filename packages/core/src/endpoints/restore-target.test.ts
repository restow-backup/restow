import { describe, expect, it } from "vitest";
import {
  isAgentStatePath,
  isKeyFilePath,
  plainSnapshotPath,
  restoreSelectionIssue,
  restoreTargetIssue,
  selectionCovers,
} from "./restore-target.js";

describe("restoreTargetIssue", () => {
  it("keeps the Unix rules", () => {
    expect(restoreTargetIssue("linux", "/srv/restore")).toBeNull();
    expect(restoreTargetIssue("darwin", "/Users/a/R")).toBeNull();
    expect(restoreTargetIssue("linux", "/")).toBe("root");
    expect(restoreTargetIssue("linux", "srv")).toBe("not_absolute");
    expect(restoreTargetIssue("linux", "/srv/../etc")).toBe("not_plain");
    expect(restoreTargetIssue("linux", "/srv//x")).toBe("not_plain");
    expect(restoreTargetIssue("linux", "/srv/x/")).toBe("not_plain");
    expect(restoreTargetIssue("linux", "/srv/\nx")).toBe("control_characters");
    expect(restoreTargetIssue("linux", "D:\\R")).toBe("not_absolute");
  });

  it("takes local Windows drive paths below the root", () => {
    expect(restoreTargetIssue("windows", "D:\\Wiederherstellung")).toBeNull();
    expect(restoreTargetIssue("windows", "c:\\Restow-Restore-1\\Ä ü")).toBeNull();
    expect(restoreTargetIssue("windows", "D:\\R.d\\x")).toBeNull();
  });

  it("refuses what Windows would read differently or what is no local folder", () => {
    const cases: [string, string][] = [
      ["\\\\nas\\share\\x", "network_path"],
      ["\\\\?\\C:\\x", "network_path"],
      ["C:x", "not_absolute"],
      ["/srv", "not_absolute"],
      ["C:\\", "root"],
      ["C:\\a/b", "forward_slash"],
      ["C:\\a\\\\b", "not_plain"],
      ["C:\\a\\", "not_plain"],
      ["C:\\a\\..\\b", "not_plain"],
      ["C:\\a:stream", "invalid_character"],
      ["C:\\a*b", "invalid_character"],
      ["C:\\a.\\b", "trailing_dot_or_space"],
      ["C:\\a \\b", "trailing_dot_or_space"],
      ["C:\\nul", "reserved_name"],
      ["C:\\x\\COM1.txt", "reserved_name"],
      ["C:\\Windows\\R", "system_folder"],
      ["c:\\windows", "system_folder"],
      ["C:\\Program Files (x86)\\R", "system_folder"],
      ["C:\\ProgramData\\Restow\\x", "system_folder"],
      ["D:\\System Volume Information\\x", "system_folder"],
    ];
    for (const [value, issue] of cases) {
      expect(restoreTargetIssue("windows", value), value).toBe(issue);
    }
    // Not blocked: a folder that only starts with the same letters.
    expect(restoreTargetIssue("windows", "C:\\WindowsBackup")).toBeNull();
    expect(restoreTargetIssue("windows", "C:\\ProgramData\\RestowOld")).toBeNull();
  });
});

describe("files a restore does not hand out", () => {
  const keyFiles = ["/etc/luks-keys/data.key"];

  it("knows the agent's state file on every system, with its temporary copies", () => {
    for (const path of [
      "/etc/restow-agent/state.json",
      "/etc/restow-agent/.state-123456.tmp",
      "/etc/restow-pve/state.json",
      "/etc/restow-pve/.state.json.abc",
      "/private/etc/restow-agent/state.json",
      "/System/Volumes/Data/private/etc/restow-agent/state.json",
      "/C/ProgramData/Restow/state/state.json",
      "/c/programdata/restow/state/.state-1.tmp",
      "/etc//restow-agent/./state.json",
    ]) {
      expect(isAgentStatePath(path), path).toBe(true);
    }
    for (const path of [
      "/etc/restow-agent",
      "/etc/restow-agent/agent.json",
      "/etc/restow-agent/state.json.bak",
      "/etc/restow-agent/sub/.state-1.tmp",
      "/home/anna/state.json",
    ]) {
      expect(isAgentStatePath(path), path).toBe(false);
    }
  });

  it("locks the state file for everybody and key files for the restore role", () => {
    const restore = { role: "restore" as const, keyFiles };
    const admin = { role: "admin" as const, keyFiles };
    expect(restoreSelectionIssue("/etc/restow-agent/state.json", restore)).toBe("agent_state");
    expect(restoreSelectionIssue("/etc/restow-agent/state.json", admin)).toBe("agent_state");
    expect(restoreSelectionIssue("/etc/luks-keys/data.key", restore)).toBe("key_file");
    expect(restoreSelectionIssue("/etc/luks-keys//data.key", restore)).toBe("key_file");
    expect(restoreSelectionIssue("/etc/luks-keys/data.key", admin)).toBeNull();
    expect(restoreSelectionIssue("/etc/luks-keys", restore)).toBeNull();
    expect(restoreSelectionIssue("/etc/hosts", restore)).toBeNull();
    expect(isKeyFilePath("/etc/luks-keys/data.key", keyFiles)).toBe(true);
    expect(isKeyFilePath("/etc/luks-keys/other.key", keyFiles)).toBe(false);
  });

  it("says whether a folder takes a locked file along", () => {
    expect(selectionCovers("/", keyFiles)).toBe(true);
    expect(selectionCovers("/etc", keyFiles)).toBe(true);
    expect(selectionCovers("/etc/luks-keys/", keyFiles)).toBe(true);
    expect(selectionCovers("/etc/luks-keys/data.key", keyFiles)).toBe(true);
    expect(selectionCovers("/etc/luks", keyFiles)).toBe(false);
    expect(selectionCovers("/home", keyFiles)).toBe(false);
    expect(selectionCovers("/home", [])).toBe(false);
    expect(plainSnapshotPath("a//b/./c/")).toBe("/a/b/c");
  });
});
