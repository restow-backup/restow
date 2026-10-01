/**
 * A minimal, valid iCalendar (RFC 5545) VEVENT, built by hand (no library,
 * no new dependency) for the demo mail generator's meeting invitations.
 */

export interface CalendarEvent {
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  organizer: { name: string; email: string };
  attendee?: { name: string; email: string };
}

/** `YYYYMMDDTHHMMSSZ`, the UTC form RFC 5545 uses. */
function icsDate(date: Date): string {
  const [datePart] = date.toISOString().replace(/[-:]/g, "").split(".");
  return `${datePart}Z`;
}

/** Escape the characters RFC 5545 §3.3.11 reserves in TEXT values. */
function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** Build a single-event .ics file (CRLF line endings, as the format requires). */
export function buildIcs(event: CalendarEvent, now: Date = new Date()): string {
  const lines: (string | null)[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Restow Demo//Synthetic Mail Generator//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(event.start)}`,
    `DTEND:${icsDate(event.end)}`,
    `SUMMARY:${escapeIcsText(event.summary)}`,
    event.description ? `DESCRIPTION:${escapeIcsText(event.description)}` : null,
    event.location ? `LOCATION:${escapeIcsText(event.location)}` : null,
    `ORGANIZER;CN=${event.organizer.name}:mailto:${event.organizer.email}`,
    event.attendee
      ? `ATTENDEE;CN=${event.attendee.name};RSVP=TRUE:mailto:${event.attendee.email}`
      : null,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.filter((line): line is string => line !== null).join("\r\n")}\r\n`;
}
