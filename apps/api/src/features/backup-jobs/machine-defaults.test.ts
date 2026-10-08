import { describe, expect, it } from "vitest";

import { machineJobDefaults } from "./read.js";

const ZONE = "Europe/Berlin";

describe("what a new machine job starts with", () => {
  it("is a Linux server's folders and 22:00 without chosen machines", () => {
    const defaults = machineJobDefaults([], ZONE);
    expect(defaults.paths).toContain("/etc");
    expect(defaults.schedule).toMatchObject({ kind: "daily", timeOfDay: "22:00" });
    expect(defaults.basis).toBeNull();
  });

  it("backs up a Mac client's /Users when it connects, not /etc at 22:00", () => {
    const defaults = machineJobDefaults([{ os: "darwin", profile: "client" }], ZONE);
    expect(defaults.paths).toEqual(["/Users"]);
    expect(defaults.schedule).toMatchObject({ kind: "on_connect", intervalMinutes: 240 });
    expect(defaults.basis).toEqual({ os: ["darwin"], profiles: ["client"], mixed: false });
  });

  it("takes the union of the folders for a mixed choice and says it is mixed", () => {
    const defaults = machineJobDefaults(
      [
        { os: "linux", profile: "server" },
        { os: "darwin", profile: "client" },
        { os: "linux", profile: "server" },
      ],
      ZONE,
    );
    expect(defaults.paths).toContain("/var/lib");
    expect(defaults.paths).toContain("/Users");
    expect(new Set(defaults.paths).size).toBe(defaults.paths.length);
    // A server among them: the server's daily time.
    expect(defaults.schedule.kind).toBe("daily");
    expect(defaults.basis?.mixed).toBe(true);
  });

  it("gives Windows clients their user folders", () => {
    const defaults = machineJobDefaults([{ os: "windows", profile: "client" }], ZONE);
    expect(defaults.paths).toEqual(["C:\\Users"]);
  });
});
