import { describe, expect, it } from "vitest";
import { endpointGroupName, languageOf, mailJobName, scheduleLabel, uniqueName } from "./names.js";

describe("names the system gives jobs", () => {
  it("follows the language of the tenant, the installation's default without one", () => {
    expect(languageOf({ language: "en" })).toBe("en");
    expect(languageOf({ language: "de" })).toBe("de");
    expect(languageOf({ language: null })).toBe("de");
    expect(mailJobName("en")).toBe("Mail backup");
    expect(mailJobName("de")).toBe("Mail-Sicherung");
  });

  it("reads a schedule the way the people of the tenant do", () => {
    const daily = { kind: "daily", timeOfDay: "02:00", timeZone: "Europe/Berlin" } as const;
    expect(scheduleLabel("en", daily)).toBe("daily 02:00");
    expect(scheduleLabel("de", daily)).toBe("täglich 02:00");
    expect(scheduleLabel("en", { kind: "interval", intervalMinutes: 240, timeZone: "UTC" })).toBe(
      "every 4 h",
    );
    expect(scheduleLabel("en", { kind: "interval", intervalMinutes: 90, timeZone: "UTC" })).toBe(
      "every 90 min",
    );
    expect(scheduleLabel("de", { kind: "on_connect", intervalMinutes: 240, timeZone: "UTC" })).toBe(
      "bei Verbindung, höchstens alle 4 Std",
    );
    expect(scheduleLabel("en", { kind: "on_connect", timeZone: "UTC" })).toBe("on connect");
  });

  it("names a group of machines after its system, profile and schedule", () => {
    const daily = { kind: "daily", timeOfDay: "02:00", timeZone: "Europe/Berlin" } as const;
    expect(endpointGroupName("de", "linux", "server", daily)).toBe("Linux-Server · täglich 02:00");
    expect(
      endpointGroupName("en", "darwin", "client", { kind: "on_connect", timeZone: "UTC" }),
    ).toBe("macOS clients · on connect");
    // A system this release does not know falls back to the Linux wording rather than a raw key.
    expect(endpointGroupName("en", "freebsd", "server", daily)).toBe("Linux servers · daily 02:00");
  });

  it("makes a name unique by counting up, ignoring case", () => {
    expect(uniqueName("en", "Mail backup", new Set())).toBe("Mail backup");
    expect(uniqueName("en", "Mail backup", new Set(["mail BACKUP"]))).toBe("Mail backup (2)");
    expect(uniqueName("en", "Mail backup", new Set(["Mail backup", "Mail backup (2)"]))).toBe(
      "Mail backup (3)",
    );
  });
});
