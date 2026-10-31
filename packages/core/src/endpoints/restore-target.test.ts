import { describe, expect, it } from "vitest";
import { restoreTargetIssue } from "./restore-target.js";

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
