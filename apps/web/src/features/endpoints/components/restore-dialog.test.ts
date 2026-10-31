import { describe, expect, it } from "vitest";

import { checkTargetDir, displaySnapshotPath } from "./restore-dialog";

/**
 * The target folder of a restore onto a machine is checked in the browser by
 * the rules the API applies (restoreTargetSchema), so a Windows path or a
 * path the agent would refuse never reaches the server (U-5, K-6).
 */
describe("checkTargetDir", () => {
  it("accepts an empty field (the agent picks a new folder) and a plain absolute path", () => {
    expect(checkTargetDir("")).toBeNull();
    expect(checkTargetDir("   ")).toBeNull();
    expect(checkTargetDir("/srv/restore-2026")).toBeNull();
    expect(checkTargetDir(" /srv/restore ")).toBeNull();
  });

  it("refuses Windows and relative paths as not absolute", () => {
    expect(checkTargetDir("C:\\Restore")).toBe("notAbsolute");
    expect(checkTargetDir("D:/Restore")).toBe("notAbsolute");
    expect(checkTargetDir("restore/here")).toBe("notAbsolute");
  });

  it("refuses the root and paths the agent would not take as written", () => {
    expect(checkTargetDir("/")).toBe("root");
    expect(checkTargetDir("/srv/restore/")).toBe("notPlain");
    expect(checkTargetDir("/srv//restore")).toBe("notPlain");
    expect(checkTargetDir("/srv/../etc")).toBe("notPlain");
    expect(checkTargetDir("/srv/./restore")).toBe("notPlain");
  });

  it("refuses control characters and overlong paths", () => {
    expect(checkTargetDir("/srv/re\nstore")).toBe("controlCharacters");
    expect(checkTargetDir(`/${"a".repeat(5000)}`)).toBe("tooLong");
  });
});

describe("checkTargetDir on a Windows machine", () => {
  it("accepts a local folder below a drive", () => {
    expect(checkTargetDir("D:\\Wiederherstellung", "windows")).toBeNull();
    expect(checkTargetDir(" c:\\Restore\\2026 ", "windows")).toBeNull();
    expect(checkTargetDir("C:\\WindowsBackup", "windows")).toBeNull();
  });

  it("refuses what the agent would refuse", () => {
    const cases: [string, string][] = [
      ["/srv/restore", "notAbsolute"],
      ["C:\\", "root"],
      ["\\\\nas\\share", "networkPath"],
      ["C:\\a/b", "forwardSlash"],
      ["C:\\a\\\\b", "notPlain"],
      ["C:\\a\\..\\b", "notPlain"],
      ["C:\\a:b", "invalidCharacter"],
      ["C:\\a.\\b", "trailingDotOrSpace"],
      ["C:\\x\\NUL.txt", "reservedName"],
      ["C:\\Windows\\R", "systemFolder"],
      ["c:\\program files\\R", "systemFolder"],
      ["C:\\ProgramData\\Restow", "systemFolder"],
      ["E:\\System Volume Information\\x", "systemFolder"],
    ];
    for (const [value, problem] of cases) {
      expect(checkTargetDir(value, "windows"), value).toBe(problem);
    }
  });

  it("shows snapshot paths the way Windows writes them", () => {
    expect(displaySnapshotPath("/C/Users/anna/a.txt", "windows")).toBe("C:\\Users\\anna\\a.txt");
    expect(displaySnapshotPath("/D", "windows")).toBe("D:\\");
    expect(displaySnapshotPath("/C/Users/anna", "linux")).toBe("/C/Users/anna");
    expect(displaySnapshotPath("/srv/x", "windows")).toBe("/srv/x");
  });
});
