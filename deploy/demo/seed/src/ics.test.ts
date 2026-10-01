import { describe, expect, it } from "vitest";
import { buildIcs } from "./ics.js";

const EVENT = {
  uid: "evt-1@restow-demo.example.org",
  summary: "Quarterly planning",
  description: "Discuss Q3 goals",
  location: "Meeting room 1",
  start: new Date("2024-05-01T10:00:00.000Z"),
  end: new Date("2024-05-01T11:00:00.000Z"),
  organizer: { name: "Info", email: "info@example.org" },
  attendee: { name: "Anna Muster", email: "anna.muster@example.com" },
};

describe("buildIcs", () => {
  it("produces a well-formed single-event calendar with CRLF line endings", () => {
    const ics = buildIcs(EVENT, new Date("2024-04-01T00:00:00.000Z"));
    const lines = ics.split("\r\n");
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines.at(-2)).toBe("END:VCALENDAR");
    expect(ics).toContain("\r\n");
    expect(ics.includes("\n") && !ics.includes("\r\n")).toBe(false);
  });

  it("formats start and end as UTC basic-format timestamps", () => {
    const ics = buildIcs(EVENT, new Date("2024-04-01T00:00:00.000Z"));
    expect(ics).toContain("DTSTART:20240501T100000Z");
    expect(ics).toContain("DTEND:20240501T110000Z");
    expect(ics).toContain("DTSTAMP:20240401T000000Z");
  });

  it("carries the organizer and attendee as mailto URIs", () => {
    const ics = buildIcs(EVENT);
    expect(ics).toContain("ORGANIZER;CN=Info:mailto:info@example.org");
    expect(ics).toContain("ATTENDEE;CN=Anna Muster;RSVP=TRUE:mailto:anna.muster@example.com");
  });

  it("escapes commas, semicolons and newlines in text fields", () => {
    const ics = buildIcs({
      ...EVENT,
      summary: "Planning; Q3, review\nfollow-up",
    });
    expect(ics).toContain("SUMMARY:Planning\\; Q3\\, review\\nfollow-up");
  });

  it("omits optional fields when absent", () => {
    const { description: _description, location: _location, ...withoutOptional } = EVENT;
    const ics = buildIcs(withoutOptional);
    expect(ics).not.toContain("DESCRIPTION:");
    expect(ics).not.toContain("LOCATION:");
  });

  it("is deterministic given the same 'now'", () => {
    const now = new Date("2024-04-01T00:00:00.000Z");
    expect(buildIcs(EVENT, now)).toBe(buildIcs(EVENT, now));
  });
});
