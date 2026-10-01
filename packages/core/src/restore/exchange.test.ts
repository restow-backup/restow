import { afterEach, describe, expect, it } from "vitest";
import type { ProtectedObjectRef } from "../engine/types.js";
import { must } from "../graph/testing/fake-graph.js";
import { ExchangeRestoreEngine, eventTransactionId, targetMailboxOf } from "./exchange.js";
import { FakeMailbox } from "./testing/fake-mailbox.js";
import {
  type FixtureObject,
  type SnapshotFixture,
  corruptStoredObject,
  createSnapshotFixture,
  mimeMessage,
  restoreRequestFor,
} from "./testing/fixtures.js";

const USER = "anna@example.org";
const NOW = new Date(Date.UTC(2026, 8, 22, 14, 30));
const RESTORE_FOLDER = "Restow 2026-09-22 1430";

function engineFor(mailbox: FakeMailbox): ExchangeRestoreEngine {
  return new ExchangeRestoreEngine({ graph: () => mailbox.graph.client() });
}

/** Position of the first call from `from` on matching `method` and a path pattern, or -1. */
function callIndex(mailbox: FakeMailbox, method: string, path: RegExp, from = 0): number {
  return mailbox.graph.calls.findIndex(
    (call, index) =>
      index >= from && call.method === method && path.test(new URL(call.url).pathname),
  );
}

// Objects shaped exactly like the Exchange backup writes them (backup/exchange).

const roots: FixtureObject[] = ["mail", "calendar", "contacts"].map((path) => ({
  path,
  type: "folder",
  content: "",
  metadata: { folderKind: "root" },
}));

const inboxFolder: FixtureObject = {
  path: "mail/Posteingang",
  type: "folder",
  id: "F-inbox",
  content: "",
  metadata: {
    folderKind: "mail",
    folderPath: "Posteingang",
    wellKnownFolder: "inbox",
    wellKnownName: "inbox",
    displayName: "Posteingang",
  },
};

const projectsFolder: FixtureObject = {
  path: "mail/Posteingang/Projekte",
  type: "folder",
  id: "F-projects",
  content: "",
  metadata: {
    folderKind: "mail",
    folderPath: "Posteingang/Projekte",
    wellKnownFolder: "inbox",
    displayName: "Projekte",
  },
};

const emptyFolder: FixtureObject = {
  path: "mail/Archiv 2025",
  type: "folder",
  id: "F-archive",
  content: "",
  metadata: { folderKind: "mail", folderPath: "Archiv 2025", displayName: "Archiv 2025" },
};

const kickoff: FixtureObject = {
  path: "mail/Posteingang/Projekte/Kickoff.0001.eml",
  type: "mail",
  id: "AAMk1",
  content: mimeMessage({ messageId: "<one@example.org>", subject: "Kickoff" }),
  metadata: {
    messageId: "<one@example.org>",
    folderPath: "Posteingang/Projekte",
    wellKnownFolder: "inbox",
    format: "mime",
    isRead: "false",
    flagStatus: "flagged",
    categories: '["Red"]',
    importance: "high",
  },
};

const offer: FixtureObject = {
  path: "mail/Gesendete Elemente/Offer.0002.eml",
  type: "mail",
  id: "AAMk2",
  content: mimeMessage({ messageId: "<two@example.org>", subject: "Offer" }),
  metadata: {
    messageId: "<two@example.org>",
    folderPath: "Gesendete Elemente",
    wellKnownFolder: "sentitems",
    format: "mime",
    isRead: "true",
    flagStatus: "notFlagged",
    categories: "[]",
  },
};

const defaultCalendar: FixtureObject = {
  path: "calendar/Kalender",
  type: "folder",
  id: "cal-src-1",
  content: "",
  metadata: {
    folderKind: "calendar",
    calendarId: "cal-src-1",
    calendarName: "Kalender",
    isDefaultCalendar: "true",
    folderPath: "Kalender",
  },
};

const teamCalendar: FixtureObject = {
  path: "calendar/Team",
  type: "folder",
  id: "cal-src-2",
  content: "",
  metadata: {
    folderKind: "calendar",
    calendarId: "cal-src-2",
    calendarName: "Team",
    isDefaultCalendar: "false",
    folderPath: "Team",
  },
};

const weekly: FixtureObject = {
  path: "calendar/Team/Weekly.0003.json",
  type: "event",
  id: "EV1",
  metadata: {
    calendarId: "cal-src-2",
    calendarName: "Team",
    isDefaultCalendar: "false",
    folderPath: "Team",
    format: "json",
  },
  content: JSON.stringify({
    event: {
      id: "old-id",
      iCalUId: "uid-team-1",
      subject: "Weekly",
      start: { dateTime: "2026-01-05T09:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-01-05T09:30:00.0000000", timeZone: "UTC" },
      type: "seriesMaster",
      recurrence: { pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday"] } },
      attendees: [{ emailAddress: { address: "ben@example.org" } }],
      organizer: { emailAddress: { address: USER } },
    },
    exceptions: [
      {
        subject: "Weekly (moved)",
        originalStart: "2026-01-12T09:00:00Z",
        start: { dateTime: "2026-01-12T10:00:00.0000000", timeZone: "UTC" },
        end: { dateTime: "2026-01-12T10:30:00.0000000", timeZone: "UTC" },
        type: "exception",
      },
    ],
  }),
};

const dentist: FixtureObject = {
  path: "calendar/Kalender/Dentist.0004.json",
  type: "event",
  id: "EV2",
  metadata: {
    calendarId: "cal-src-1",
    calendarName: "Kalender",
    isDefaultCalendar: "true",
    folderPath: "Kalender",
    format: "json",
  },
  content: JSON.stringify({
    event: {
      subject: "Dentist",
      start: { dateTime: "2026-02-01T08:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-02-01T09:00:00.0000000", timeZone: "UTC" },
    },
    exceptions: [],
  }),
};

const defaultContacts: FixtureObject = {
  path: "contacts",
  type: "folder",
  content: "",
  metadata: { folderKind: "contacts", folderPath: "", isDefault: "true", displayName: "Kontakte" },
};

const clientsFolder: FixtureObject = {
  path: "contacts/Clients",
  type: "folder",
  id: "CF1",
  content: "",
  metadata: {
    folderKind: "contacts",
    folderPath: "Clients",
    isDefault: "false",
    displayName: "Clients",
  },
};

const ben: FixtureObject = {
  path: "contacts/Clients/Ben Example.0005.json",
  type: "contact",
  id: "C1",
  metadata: { folderPath: "Clients", format: "json" },
  content: JSON.stringify({
    id: "old",
    displayName: "Ben Example",
    emailAddresses: [{ address: "ben@example.org", name: "Ben Example" }],
    changeKey: "x",
  }),
};

const fullMailbox = [
  ...roots,
  inboxFolder,
  projectsFolder,
  emptyFolder,
  kickoff,
  offer,
  defaultCalendar,
  teamCalendar,
  weekly,
  dentist,
  defaultContacts,
  clientsFolder,
  ben,
];

describe("ExchangeRestoreEngine", () => {
  let fixture: SnapshotFixture;

  afterEach(async () => {
    await fixture?.cleanup();
  });

  it("restores a whole mailbox below a dated folder in rename mode, empty folders included", async () => {
    fixture = await createSnapshotFixture({
      kind: "mailbox",
      externalId: USER,
      now: () => NOW,
      objects: fullMailbox,
    });
    const mailbox = new FakeMailbox();
    mailbox.occurrences.set("Weekly", [
      { id: "occ-1", originalStart: "2026-01-12T09:00:00.0000000Z", type: "occurrence" },
    ]);
    const request = restoreRequestFor(fixture);

    const report = await engineFor(mailbox).run(fixture.ctx, request);

    expect(report.failures).toEqual([]);
    expect(report.restored).toBe(5);
    expect(report.skipped).toBe(0);
    expect(report.unverified).toBe(0);
    // Posteingang, Projekte, Archiv 2025, the two restore calendars and Clients.
    expect(report.folders).toBe(6);
    expect(fixture.ctx.progress.snapshot()).toMatchObject({ total: 11, done: 11, failed: 0 });
    // Structural folders (roots, the default contacts folder) are not items.
    expect(report.items.map((item) => item.path)).not.toContain("mail");

    const messages = [...mailbox.messages.values()];
    const restoredKickoff = must(messages.find((m) => m.internetMessageId === "<one@example.org>"));
    const restoredOffer = must(messages.find((m) => m.internetMessageId === "<two@example.org>"));
    expect(mailbox.folderPath(restoredKickoff.parentFolderId)).toEqual([
      RESTORE_FOLDER,
      "Posteingang",
      "Projekte",
    ]);
    expect(mailbox.folderPath(restoredOffer.parentFolderId)).toEqual([
      RESTORE_FOLDER,
      "Gesendete Elemente",
    ]);
    expect([...mailbox.folders.values()].some((f) => f.displayName === "Archiv 2025")).toBe(true);
    expect(restoredKickoff.mime).toBe(kickoff.content);
    expect(restoredKickoff.patches).toEqual([
      { isRead: false, flag: { flagStatus: "flagged" }, categories: ["Red"], importance: "high" },
    ]);
    expect(restoredOffer.patches).toEqual([
      { isRead: true, flag: { flagStatus: "notFlagged" }, categories: [] },
    ]);

    expect([...mailbox.calendars.values()].map((c) => c.name)).toEqual([
      "Calendar",
      RESTORE_FOLDER,
      `${RESTORE_FOLDER} (Team)`,
    ]);
    const events = [...mailbox.events.values()];
    expect(events).toHaveLength(2);
    const restoredWeekly = must(events.find((e) => e.body.subject === "Weekly"));
    expect(mailbox.calendars.get(restoredWeekly.calendarId)?.name).toBe(`${RESTORE_FOLDER} (Team)`);
    expect(restoredWeekly.body).not.toHaveProperty("attendees");
    expect(restoredWeekly.body).not.toHaveProperty("id");
    expect(restoredWeekly.body).not.toHaveProperty("iCalUId");
    expect(restoredWeekly.body.transactionId).toBe(
      eventTransactionId(request.restoreJobId, must(fixture.objects.find((o) => o.id === "EV1"))),
    );
    expect(restoredWeekly.patches).toEqual([
      expect.objectContaining({ occurrence: "occ-1", subject: "Weekly (moved)" }),
    ]);
    const weeklyItem = must(report.items.find((item) => item.id === "EV1"));
    expect(weeklyItem).toMatchObject({ status: "restored", verified: true, code: "restored" });
    expect(weeklyItem.reason).toMatch(/attendees were not invited again/);
    const restoredDentist = must(events.find((e) => e.body.subject === "Dentist"));
    expect(mailbox.calendars.get(restoredDentist.calendarId)?.name).toBe(RESTORE_FOLDER);

    const contacts = [...mailbox.contacts.values()];
    expect(contacts).toHaveLength(1);
    expect(mailbox.contactFolderPath(must(contacts[0]).folderId)).toEqual([
      RESTORE_FOLDER,
      "Clients",
    ]);
    expect(must(contacts[0]).body).not.toHaveProperty("changeKey");
  });

  it("finds original folders by meaning in place and skips existing duplicates", async () => {
    fixture = await createSnapshotFixture({
      kind: "mailbox",
      externalId: USER,
      now: () => NOW,
      objects: [inboxFolder, projectsFolder, kickoff, offer, dentist, defaultCalendar],
    });
    const mailbox = new FakeMailbox();
    const existing = mailbox.addMessage({
      parentFolderId: "wk-sentitems",
      internetMessageId: "<two@example.org>",
    });

    const report = await engineFor(mailbox).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "skip" }),
    );

    expect(report.failures).toEqual([]);
    expect(report.restored).toBe(2);
    expect(report.skipped).toBe(1);
    const skipped = must(report.items.find((item) => item.status === "skipped"));
    expect(skipped).toMatchObject({ id: "AAMk2", targetRef: existing.id, code: "exists" });
    expect(skipped.reason).toMatch(/already exists in the target folder/);

    const created = must([...mailbox.messages.values()].find((m) => m.id !== existing.id));
    // "Posteingang" was not created: the path was anchored on the target's Inbox.
    expect(mailbox.folderPath(created.parentFolderId)).toEqual(["Inbox", "Projekte"]);
    expect(mailbox.folders.get(created.parentFolderId)?.parentFolderId).toBe("wk-inbox");
    expect([...mailbox.folders.values()].some((f) => f.displayName === "Posteingang")).toBe(false);
    expect(mailbox.messages.get(existing.id)).toBeDefined();
    // The default calendar is found as the default calendar, not by its German name.
    expect(must([...mailbox.events.values()][0]).calendarId).toBe("cal-default");
    expect(mailbox.calendars.size).toBe(1);
  });

  it("refuses to delete: a job queued with the discontinued mode 'replace' runs as 'rename' instead", async () => {
    fixture = await createSnapshotFixture({
      kind: "mailbox",
      externalId: USER,
      now: () => NOW,
      objects: [offer],
    });
    const mailbox = new FakeMailbox();
    const stale = mailbox.addMessage({
      parentFolderId: "wk-sentitems",
      internetMessageId: "<two@example.org>",
    });

    const report = await engineFor(mailbox).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "replace" }),
    );

    expect(report.restored).toBe(1);
    expect(report.items[0]?.reason).toMatch(
      /queued with the mode "replace".*ran as "rename" instead/,
    );
    // Nothing is ever deleted, patched or moved on the pre-existing message.
    expect(mailbox.graph.calls.filter((call) => call.method === "DELETE")).toEqual([]);
    expect(
      mailbox.graph.calls.filter(
        (call) =>
          call.url.includes(`/messages/${stale.id}`) &&
          (call.method === "PATCH" || new URL(call.url).pathname.endsWith("/move")),
      ),
    ).toEqual([]);
    expect(mailbox.messages.has(stale.id)).toBe(true);
    const fresh = must([...mailbox.messages.values()].find((m) => m.id !== stale.id));
    // Lands alongside the original, following the rename convention.
    expect(mailbox.folderPath(fresh.parentFolderId)).toEqual([
      RESTORE_FOLDER,
      "Gesendete Elemente",
    ]);
    expect(fresh.internetMessageId).toBe("<two@example.org>");
  });

  it("says a legacy 'replace' job ran as 'rename' even when an item fails to restore", async () => {
    fixture = await createSnapshotFixture({ kind: "mailbox", externalId: USER, objects: [offer] });
    const refusing = new FakeMailbox();
    refusing.maxMimeBytes = 10;
    const kept = refusing.addMessage({
      parentFolderId: "wk-sentitems",
      internetMessageId: "<two@example.org>",
    });

    const report = await engineFor(refusing).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "replace" }),
    );

    // The failure code still reflects the real cause (a Graph refusal), not
    // a generic one, even though the reason text was rewritten twice (once
    // for the "too large" explanation, once for the legacy-mode note).
    expect(report.items[0]).toMatchObject({ status: "failed", code: "target_rejected" });
    expect(report.items[0]?.reason).toMatch(
      /queued with the mode "replace".*ran as "rename" instead/,
    );
    expect(refusing.messages.has(kept.id)).toBe(true);
    expect(refusing.graph.callsTo("DELETE", "/messages/")).toEqual([]);
  });

  it("keeps the message a folder had when the backup cannot be read or Exchange refuses it", async () => {
    fixture = await createSnapshotFixture({ kind: "mailbox", externalId: USER, objects: [offer] });
    const rename = restoreRequestFor(fixture, { mode: "rename" });

    const refusing = new FakeMailbox();
    refusing.maxMimeBytes = 10;
    const keptOnRefusal = refusing.addMessage({
      parentFolderId: "wk-sentitems",
      internetMessageId: "<two@example.org>",
    });
    const refused = await engineFor(refusing).run(fixture.ctx, rename);
    expect(refused.items[0]).toMatchObject({ status: "failed", code: "target_rejected" });
    expect(refusing.messages.has(keptOnRefusal.id)).toBe(true);
    expect(refusing.graph.callsTo("DELETE", "/messages/")).toEqual([]);

    await corruptStoredObject(fixture, must(fixture.objects[0]));
    const mailbox = new FakeMailbox();
    const keptOnCorruption = mailbox.addMessage({
      parentFolderId: "wk-sentitems",
      internetMessageId: "<two@example.org>",
    });
    const corrupt = await engineFor(mailbox).run(fixture.ctx, rename);
    expect(corrupt.items[0]).toMatchObject({ status: "failed", code: "integrity" });
    expect([...mailbox.messages.keys()]).toEqual([keptOnCorruption.id]);
    expect(callIndex(mailbox, "POST", /\/messages$/)).toBe(-1);
    expect(mailbox.graph.callsTo("DELETE", "/messages/")).toEqual([]);
  });

  it("never deletes an existing event or contact, in rename mode or for a legacy 'replace' job", async () => {
    fixture = await createSnapshotFixture({
      kind: "mailbox",
      externalId: USER,
      now: () => NOW,
      objects: [teamCalendar, weekly, clientsFolder, ben],
    });
    const mailbox = new FakeMailbox();
    const team = { id: "cal-team", name: "Team", isDefaultCalendar: false };
    mailbox.calendars.set(team.id, team);
    const oldSeries = mailbox.addEvent(team.id, { subject: "Weekly (old)" }, "uid-team-1");
    const oldContact = mailbox.addContact(mailbox.addContactFolder("Clients", null).id, {
      displayName: "Ben Example",
      emailAddresses: [{ address: "ben@example.org" }],
    });
    mailbox.occurrences.set("Weekly", [
      { id: "occ-1", originalStart: "2026-01-12T09:00:00.0000000Z", type: "occurrence" },
    ]);

    const report = await engineFor(mailbox).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "replace" }),
    );

    expect(report.failures).toEqual([]);
    // The originals are still there; nothing was deleted, patched or moved.
    expect(mailbox.events.has(oldSeries.id)).toBe(true);
    expect(mailbox.contacts.has(oldContact.id)).toBe(true);
    expect(mailbox.graph.calls.filter((call) => call.method === "DELETE")).toEqual([]);
    const touchesExisting = (call: { method: string; url: string }): boolean =>
      (call.method === "PATCH" || /\/move$/.test(new URL(call.url).pathname)) &&
      [oldSeries.id, oldContact.id].some((id) => call.url.includes(id));
    expect(mailbox.graph.calls.filter(touchesExisting)).toEqual([]);
    const eventItem = must(report.items.find((item) => item.id === "EV1"));
    expect(eventItem).toMatchObject({ status: "restored", code: "restored" });
    expect(eventItem.reason).toMatch(/queued with the mode "replace".*ran as "rename" instead/);
    const contactItem = must(report.items.find((item) => item.id === "C1"));
    expect(contactItem).toMatchObject({ status: "restored" });
    expect(contactItem.reason).toMatch(/queued with the mode "replace".*ran as "rename" instead/);
    // Both restored copies land below the restore folder, next to the originals.
    const restoredEvent = must([...mailbox.events.values()].find((e) => e.id !== oldSeries.id));
    expect(mailbox.calendars.get(restoredEvent.calendarId)?.name).toBe(`${RESTORE_FOLDER} (Team)`);
    const restoredContact = must(
      [...mailbox.contacts.values()].find((c) => c.id !== oldContact.id),
    );
    expect(mailbox.contactFolderPath(restoredContact.folderId)).toEqual([
      RESTORE_FOLDER,
      "Clients",
    ]);
  });

  it("lands a retried rename-mode job in the folders of its first attempt", async () => {
    let clock = NOW;
    fixture = await createSnapshotFixture({
      kind: "mailbox",
      externalId: USER,
      now: () => clock,
      objects: [inboxFolder, projectsFolder, kickoff, defaultCalendar, dentist, clientsFolder, ben],
    });
    const mailbox = new FakeMailbox();
    const request = restoreRequestFor(fixture, { requestedAt: NOW });

    const first = await engineFor(mailbox).run(fixture.ctx, request);
    expect(first.failures).toEqual([]);
    clock = new Date(NOW.getTime() + 12 * 60_000);
    const retry = await engineFor(mailbox).run(fixture.ctx, request);

    expect(retry.failures).toEqual([]);
    expect(retry.items.filter((item) => item.status === "skipped").map((item) => item.id)).toEqual([
      "AAMk1",
      "C1",
    ]);
    expect(mailbox.messages.size).toBe(1);
    expect(mailbox.contacts.size).toBe(1);
    expect(mailbox.events.size).toBe(1);
    const restoreFolders = [...mailbox.folders.values()].filter((folder) =>
      folder.displayName.startsWith("Restow "),
    );
    expect(restoreFolders.map((folder) => folder.displayName)).toEqual([RESTORE_FOLDER]);
    expect([...mailbox.calendars.values()].map((calendar) => calendar.name)).toEqual([
      "Calendar",
      RESTORE_FOLDER,
    ]);
  });

  it("restores into another mailbox and dedups events by iCalUId and contacts by name and address", async () => {
    fixture = await createSnapshotFixture({
      kind: "mailbox",
      externalId: USER,
      objects: [teamCalendar, weekly, dentist, clientsFolder, ben],
    });
    const mailbox = new FakeMailbox();
    const team = { id: "cal-team", name: "Team", isDefaultCalendar: false };
    mailbox.calendars.set(team.id, team);
    mailbox.addEvent(team.id, { subject: "Weekly (still there)" }, "uid-team-1");
    mailbox.addContact(mailbox.addContactFolder("Clients", null).id, {
      displayName: "ben example",
      emailAddresses: [{ address: "BEN@example.org" }],
    });

    const report = await engineFor(mailbox).run(
      fixture.ctx,
      restoreRequestFor(fixture, {
        mode: "skip",
        target: { type: "other", ref: "carla@example.org" },
      }),
    );

    expect(report.restored).toBe(1);
    expect(report.skipped).toBe(2);
    expect(report.folders).toBe(2);
    expect(report.items.filter((item) => item.status === "skipped").map((item) => item.id)).toEqual(
      ["EV1", "C1"],
    );
    expect(mailbox.graph.calls.every((call) => call.url.includes("carla%40example.org"))).toBe(
      true,
    );
    const restoredDentist = must(
      [...mailbox.events.values()].find((e) => e.body.subject === "Dentist"),
    );
    expect(restoredDentist.calendarId).toBe("cal-default");
    expect(mailbox.calendars.size).toBe(2);
  });

  it("never creates the same event twice for one restore job, but does for a new job", async () => {
    fixture = await createSnapshotFixture({
      kind: "mailbox",
      externalId: USER,
      now: () => NOW,
      objects: [dentist],
    });
    const mailbox = new FakeMailbox();
    // A legacy job queued with the discontinued mode "replace" still dedups
    // its own retries by transactionId, exactly as "rename" does.
    const request = restoreRequestFor(fixture, { mode: "replace" });
    await engineFor(mailbox).run(fixture.ctx, request);
    await engineFor(mailbox).run(fixture.ctx, request);
    expect(mailbox.events.size).toBe(1);
    await engineFor(mailbox).run(fixture.ctx, restoreRequestFor(fixture, { mode: "replace" }));
    expect(mailbox.events.size).toBe(2);
  });

  it("restores JSON-format messages with their attachments and isolates failures per item", async () => {
    const bigOne: FixtureObject = {
      path: "mail/Posteingang/Big one.0009.json",
      type: "mail",
      id: "AAMk9",
      metadata: {
        format: "json",
        messageId: "<nine@example.org>",
        folderPath: "Posteingang",
        wellKnownFolder: "inbox",
        referenceAttachments: '["Budget.xlsx"]',
      },
      content: JSON.stringify({
        id: "old",
        subject: "Big one",
        internetMessageId: "<nine@example.org>",
        body: { contentType: "text", content: "See attachment" },
        hasAttachments: true,
        parentFolderId: "old-folder",
      }),
    };
    fixture = await createSnapshotFixture({
      kind: "mailbox",
      externalId: USER,
      objects: [
        bigOne,
        {
          path: "mail/Posteingang/Big one.0009.attachments/plan.txt.aa",
          type: "attachment",
          id: "AAMk9/a1",
          metadata: {
            messagePath: bigOne.path,
            messageItemId: "AAMk9",
            name: "plan.txt",
            contentType: "text/plain",
            attachmentType: "#microsoft.graph.fileAttachment",
          },
          content: "the plan",
        },
        {
          path: "mail/Posteingang/Big one.0009.attachments/Forwarded.bb",
          type: "attachment",
          id: "AAMk9/a2",
          metadata: {
            messagePath: bigOne.path,
            name: "Forwarded",
            attachmentType: "#microsoft.graph.itemAttachment",
          },
          content: mimeMessage({ messageId: "<fwd@example.org>", subject: "Forwarded" }),
        },
        {
          path: "mail/Posteingang/Other.0010.attachments/lonely.pdf.cc",
          type: "attachment",
          id: "AAMk10/a1",
          metadata: { messagePath: "mail/Posteingang/Other.0010.json", name: "lonely.pdf" },
          content: "%PDF",
        },
        {
          path: "calendar/Team/Broken.0011.json",
          type: "event",
          id: "EVX",
          content: "this is not json",
        },
        { path: "Documents/stray.txt", type: "file", id: "F", content: "does not belong here" },
      ],
    });
    const mailbox = new FakeMailbox();

    const report = await engineFor(mailbox).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "skip" }),
    );

    expect(report.restored).toBe(3);
    expect(report.skipped).toBe(1);
    expect(report.failures.map((f) => f.itemRef)).toEqual(["EVX", "F"]);
    expect(report.failures[0]?.reason).toMatch(/not valid event/);
    expect(report.items.find((item) => item.id === "F")?.code).toBe("wrong_target");
    expect(report.items.find((item) => item.id === "AAMk10/a1")).toMatchObject({
      status: "skipped",
      code: "parent_not_restored",
    });

    const message = must([...mailbox.messages.values()][0]);
    expect(message.parentFolderId).toBe("wk-inbox");
    expect(message.json).toEqual({
      subject: "Big one",
      internetMessageId: "<nine@example.org>",
      body: { contentType: "text", content: "See attachment" },
    });
    expect(message.attachments).toEqual([
      expect.objectContaining({ name: "Forwarded.eml", contentType: "message/rfc822" }),
      expect.objectContaining({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: "plan.txt",
        contentType: "text/plain",
        contentBytes: Buffer.from("the plan").toString("base64"),
      }),
    ]);
    const messageItem = must(report.items.find((item) => item.id === "AAMk9"));
    expect(messageItem.verified).toBe(true);
    expect(messageItem.reason).toMatch(/shows it as a draft/);
    expect(messageItem.reason).toMatch(/Budget\.xlsx/);
    expect(fixture.ctx.progress.snapshot()).toMatchObject({ total: 6, done: 4, failed: 2 });
  });

  it("explains a message Graph refuses as too large", async () => {
    fixture = await createSnapshotFixture({
      kind: "mailbox",
      externalId: USER,
      objects: [kickoff],
    });
    const mailbox = new FakeMailbox();
    mailbox.maxMimeBytes = 10;

    const report = await engineFor(mailbox).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "skip" }),
    );

    expect(report.restored).toBe(0);
    expect(report.items[0]).toMatchObject({ status: "failed", code: "target_rejected" });
    expect(report.failures[0]?.reason).toMatch(/too large .* restore it as a download/);
  });

  it("restores two messages sharing a Message-ID in every mode and never deletes its own copies", async () => {
    // The direct copy of a mail and the copy a mailing list delivered.
    const shared = "<list-post-1@example.org>";
    const twin = (id: string, subject: string): FixtureObject => ({
      path: `mail/Posteingang/${subject}.${id}.eml`,
      type: "mail",
      id,
      content: mimeMessage({ messageId: shared, subject }),
      metadata: {
        messageId: shared,
        folderPath: "Posteingang",
        wellKnownFolder: "inbox",
        format: "mime",
        isRead: "true",
        flagStatus: "notFlagged",
        categories: "[]",
      },
    });
    fixture = await createSnapshotFixture({
      kind: "mailbox",
      externalId: USER,
      now: () => NOW,
      objects: [twin("AAMk7", "Direct"), twin("AAMk8", "List")],
    });

    for (const mode of ["skip", "rename", "replace"] as const) {
      const mailbox = new FakeMailbox();
      const report = await engineFor(mailbox).run(
        fixture.ctx,
        restoreRequestFor(fixture, { mode }),
      );
      expect(report.failures, mode).toEqual([]);
      expect(report.restored, mode).toBe(2);
      expect(report.skipped, mode).toBe(0);
      expect(mailbox.messages.size, mode).toBe(2);
      expect(mailbox.graph.callsTo("DELETE", "/messages/"), mode).toEqual([]);
      for (const restored of report.items) {
        expect(mailbox.messages.has(restored.targetRef ?? ""), mode).toBe(true);
      }
    }

    // A legacy "replace" job never touches the copy the Inbox already had:
    // both twins land below the restore folder instead, and nothing is deleted.
    const replacing = new FakeMailbox();
    const stale = replacing.addMessage({ parentFolderId: "wk-inbox", internetMessageId: shared });
    const replaced = await engineFor(replacing).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "replace" }),
    );
    expect(replaced.restored).toBe(2);
    expect(replaced.items.every((item) => item.reason?.includes('ran as "rename" instead'))).toBe(
      true,
    );
    expect(replacing.messages.has(stale.id)).toBe(true);
    expect(replacing.messages.size).toBe(3);
    expect(replacing.graph.callsTo("DELETE", "/messages/")).toEqual([]);
    expect(
      [...replacing.messages.values()]
        .filter((m) => m.id !== stale.id)
        .map((m) => replacing.folderPath(m.parentFolderId)),
    ).toEqual([
      [RESTORE_FOLDER, "Posteingang"],
      [RESTORE_FOLDER, "Posteingang"],
    ]);

    // Rename, retried: each copy the restore folder holds stands for one message.
    const retried = new FakeMailbox();
    const request = restoreRequestFor(fixture, { mode: "rename" });
    await engineFor(retried).run(fixture.ctx, request);
    const retry = await engineFor(retried).run(fixture.ctx, request);
    expect(retry.skipped).toBe(2);
    expect(retried.messages.size).toBe(2);
    expect(new Set(retry.items.map((skipped) => skipped.targetRef)).size).toBe(2);

    // A legacy "replace" job dedups its own retries exactly like "rename"
    // does, and the skip still says the job ran as "rename" instead — not
    // only the messages a legacy job actually restores.
    const replayed = new FakeMailbox();
    const legacyRequest = restoreRequestFor(fixture, { mode: "replace" });
    await engineFor(replayed).run(fixture.ctx, legacyRequest);
    const legacyRetry = await engineFor(replayed).run(fixture.ctx, legacyRequest);
    expect(legacyRetry.skipped).toBe(2);
    expect(
      legacyRetry.items.every((skipped) => skipped.reason?.includes('ran as "rename" instead')),
    ).toBe(true);

    const partial = new FakeMailbox();
    const restoreFolder = partial.addFolder(RESTORE_FOLDER, null);
    const inbox = partial.addFolder("Posteingang", restoreFolder.id);
    const earlier = partial.addMessage({ parentFolderId: inbox.id, internetMessageId: shared });
    const resumed = await engineFor(partial).run(fixture.ctx, request);
    expect(resumed.skipped).toBe(1);
    expect(resumed.restored).toBe(1);
    expect(resumed.items.find((i) => i.status === "skipped")?.targetRef).toBe(earlier.id);
    expect([...partial.messages.values()].map((m) => m.parentFolderId)).toEqual([
      inbox.id,
      inbox.id,
    ]);
  });

  it("names the target mailbox from the request", () => {
    const protectedObject: ProtectedObjectRef = {
      id: "p",
      tenantId: "t",
      sourceId: "s",
      kind: "mailbox",
      externalId: USER,
      displayName: null,
      userId: null,
    };
    const base = restoreRequestFor({ protectedObject, snapshotId: "snap" });
    expect(targetMailboxOf(base)).toBe(USER);
    expect(targetMailboxOf({ ...base, target: { type: "other", ref: " x@example.org " } })).toBe(
      "x@example.org",
    );
    expect(() => targetMailboxOf({ ...base, target: { type: "other", ref: null } })).toThrow(
      /target mailbox/,
    );
    expect(() => targetMailboxOf({ ...base, target: { type: "download", ref: null } })).toThrow(
      /download/,
    );
  });
});
