import { describe, expect, it } from "vitest";

import { checkTargetDir } from "./restore-dialog";

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
