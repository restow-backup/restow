import { describe, expect, it } from "vitest";
import { createFakeGraph, must } from "../testing/fake-graph.js";
import fixture from "../testing/fixtures/calendar.json" with { type: "json" };
import {
  createEvent,
  defaultInstanceWindow,
  findOccurrenceByOriginalStart,
  listCalendarBackupItems,
  listCalendars,
  sameInstant,
  toCreatableEvent,
  windowForSeries,
} from "./calendar.js";
import { collect } from "./common.js";
import {
  createContact,
  ensureContactFolderPath,
  listContactFolderTree,
  listContacts,
  toCreatableContact,
} from "./contacts.js";

const USER = "user-1";

describe("calendar", () => {
  it("lists calendars and backs up singles plus series masters with their exceptions", async () => {
    const graph = createFakeGraph([
      {
        url: (u) => u.pathname.endsWith("/calendars"),
        respond: { status: 200, json: fixture.calendars },
      },
      {
        url: (u) => u.pathname.endsWith("/calendars/cal-default/events"),
        respond: { status: 200, json: fixture.events },
      },
      {
        url: (u) => u.pathname.endsWith("/events/evt-master/instances"),
        respond: { status: 200, json: fixture.instances },
      },
    ]);
    const client = graph.client();
    const calendars = await collect(listCalendars(client, USER));
    expect(calendars.map((c) => c.name)).toEqual(["Calendar", "Team"]);

    const items = await collect(
      listCalendarBackupItems(client, USER, "cal-default", {
        start: "2026-09-01T00:00:00Z",
        end: "2026-10-01T00:00:00Z",
      }),
    );
    expect(items.map((i) => [i.event.id, i.exceptions.map((e) => e.id)])).toEqual([
      ["evt-single", []],
      ["evt-master", ["evt-exc-1"]],
    ]);
    const instances = new URL(must(graph.callsTo("GET", "/instances")[0]).url);
    expect(instances.searchParams.get("startDateTime")).toBe("2026-09-01T00:00:00Z");
    expect(instances.searchParams.get("endDateTime")).toBe("2026-10-01T00:00:00Z");
    const eventCalls = graph.calls.filter(
      (c) => c.url.includes("/events") || c.url.includes("/instances"),
    );
    expect(eventCalls.length).toBeGreaterThan(0);
    expect(eventCalls.every((c) => c.headers.prefer === 'outlook.timezone="UTC"')).toBe(true);
  });

  it("clips the instance window to the series range", () => {
    const master = fixture.events.value[1] as never;
    expect(
      windowForSeries(master, { start: "2025-01-01T00:00:00Z", end: "2027-06-01T00:00:00Z" }),
    ).toEqual({
      start: "2026-01-05T00:00:00Z",
      end: "2026-12-28T23:59:59Z",
    });
    expect(
      windowForSeries(master, { start: "2027-01-01T00:00:00Z", end: "2027-06-01T00:00:00Z" }),
    ).toBeNull();
    const window = defaultInstanceWindow(new Date("2026-09-22T00:00:00Z"));
    expect(window.start).toBe("2025-09-22T00:00:00.000Z");
    expect(window.end).toBe("2028-09-22T00:00:00.000Z");
  });

  it("strips read-only properties and drops attendees by default so no invitations go out", async () => {
    const single = fixture.events.value[0] as never;
    const creatable = toCreatableEvent(single);
    expect(creatable).toEqual({
      subject: "Dentist",
      start: { dateTime: "2026-09-10T08:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-09-10T09:00:00.0000000", timeZone: "UTC" },
    });
    expect(toCreatableEvent(single, { keepAttendees: true }).attendees).toHaveLength(1);

    const graph = createFakeGraph([
      {
        method: "POST",
        url: (u) => u.pathname.endsWith("/calendars/cal-default/events"),
        respond: { status: 201, json: { id: "evt-new" } },
      },
    ]);
    const created = await createEvent(graph.client(), USER, "cal-default", creatable);
    expect(created.id).toBe("evt-new");
    expect(must(graph.calls[0]).json).toEqual(creatable);
  });

  it("finds the occurrence matching an exception's originalStart", async () => {
    const graph = createFakeGraph([
      {
        url: (u) => u.pathname.endsWith("/events/evt-master/instances"),
        respond: { status: 200, json: fixture.instances },
      },
    ]);
    const occurrence = await findOccurrenceByOriginalStart(
      graph.client(),
      USER,
      "evt-master",
      "2026-09-14T10:00:00.0000000",
    );
    expect(occurrence?.id).toBe("evt-exc-1");
    expect(sameInstant("2026-09-14T10:00:00.0000000", "2026-09-14T10:00:00Z")).toBe(true);
    expect(sameInstant("2026-09-14T10:00:00Z", "2026-09-14T11:00:00Z")).toBe(false);
  });
});

describe("contacts", () => {
  it("lists the default folder first, then user folders with paths, and contacts per folder", async () => {
    const graph = createFakeGraph([
      {
        url: (u) => u.pathname.endsWith("/contactFolders"),
        respond: { status: 200, json: fixture.contactFolders },
      },
      {
        url: (u) => u.pathname.endsWith("/contactFolders/cf-suppliers/childFolders"),
        respond: { status: 200, json: { value: [] } },
      },
      {
        url: (u) => u.pathname.endsWith("/contactFolders/cf-suppliers/contacts"),
        respond: { status: 200, json: fixture.contacts },
      },
      {
        url: (u) => u.pathname.endsWith(`/users/${USER}/contacts`),
        respond: { status: 200, json: { value: [] } },
      },
    ]);
    const client = graph.client();
    const tree = await listContactFolderTree(client, USER);
    expect(tree.map((f) => [f.id, f.path.join("/")])).toEqual([
      [null, ""],
      ["cf-suppliers", "Suppliers"],
    ]);
    expect(await collect(listContacts(client, USER, null))).toEqual([]);
    const contacts = await collect(listContacts(client, USER, "cf-suppliers"));
    expect(contacts.map((c) => c.displayName)).toEqual(["Carol Contact"]);
  });

  it("re-creates a contact without read-only properties, into an ensured folder path", async () => {
    const graph = createFakeGraph([
      {
        url: (u) =>
          u.pathname.endsWith("/contactFolders") &&
          u.searchParams.get("$filter") === "displayName eq 'Suppliers'",
        respond: { status: 200, json: { value: [] } },
      },
      {
        method: "POST",
        url: (u) => u.pathname.endsWith("/contactFolders"),
        respond: { status: 201, json: { id: "cf-new" } },
      },
      {
        method: "POST",
        url: (u) => u.pathname.endsWith("/contactFolders/cf-new/contacts"),
        respond: { status: 201, json: { id: "ct-new" } },
      },
    ]);
    const client = graph.client();
    const folderId = await ensureContactFolderPath(client, USER, "Suppliers");
    expect(folderId).toBe("cf-new");
    expect(await ensureContactFolderPath(client, USER, "")).toBeNull();

    const creatable = toCreatableContact(fixture.contacts.value[0] as never);
    expect(creatable).toEqual({
      displayName: "Carol Contact",
      emailAddresses: [{ address: "carol@supplier.example", name: "Carol Contact" }],
    });
    const created = await createContact(client, USER, folderId, creatable);
    expect(created.id).toBe("ct-new");
  });
});
