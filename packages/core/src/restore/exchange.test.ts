import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ProtectedObjectRef } from "../engine/types.js";
import { must } from "../graph/testing/fake-graph.js";
import { ExchangeRestoreEngine, eventTransactionId, targetMailboxOf } from "./exchange.js";
import { FakeMailbox } from "./testing/fake-mailbox.js";
import {
  corruptStoredObject,
  createSnapshotFixture,
  type FixtureObject,
  mimeMessage,
  pseudoRandomBytes,
  restoreRequestFor,
  type SnapshotFixture,
} from "./testing/fixtures.js";

const USER = "anna@example.org";
const NOW = new Date(Date.UTC(2026, 8, 22, 14, 30));
const RESTORE_FOLDER = "Restow 2026-09-22 1430";

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** The looks after an unanswered POST, without the waits between them. */
const NO_WAITS = [0, 0, 0, 0, 0];

function engineFor(mailbox: FakeMailbox): ExchangeRestoreEngine {
  return new ExchangeRestoreEngine({
    graph: () => mailbox.graph.client(),
    unknownOutcomeLooksMs: NO_WAITS,
  });
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
    // The message is in the job's own record; the contact is found by name and address.
    expect(retry.items.filter((item) => item.status === "skipped").map((item) => item.id)).toEqual([
      "C1",
    ]);
    expect(retry.items.find((item) => item.id === "AAMk1")).toMatchObject({
      status: "restored",
      reason: "restored by an earlier attempt of this job",
    });
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

  it("restores two backed-up contacts with the same name and address, and recognises both on a retry", async () => {
    const benAtWork: FixtureObject = {
      ...ben,
      path: "contacts/Clients/Ben Example.0006.json",
      id: "C2",
      content: JSON.stringify({
        id: "old-2",
        displayName: "Ben Example",
        emailAddresses: [{ address: "ben@example.org", name: "Ben Example" }],
        companyName: "Example Corp",
      }),
    };
    fixture = await createSnapshotFixture({
      kind: "mailbox",
      externalId: USER,
      now: () => NOW,
      objects: [clientsFolder, ben, benAtWork],
    });
    const mailbox = new FakeMailbox();
    const request = restoreRequestFor(fixture, { mode: "rename" });

    const first = await engineFor(mailbox).run(fixture.ctx, request);
    expect(first.failures).toEqual([]);
    expect(first.restored).toBe(2);
    expect(first.skipped).toBe(0);
    expect(mailbox.contacts.size).toBe(2);

    // The retry finds both copies in its restore folder and adds neither again.
    const retry = await engineFor(mailbox).run(fixture.ctx, request);
    expect(retry.restored).toBe(0);
    expect(retry.skipped).toBe(2);
    expect(mailbox.contacts.size).toBe(2);
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

  it("re-creates an event's backed-up attachments, also one that needs an upload session", async () => {
    const agenda = Buffer.from("Agenda: 1. Budget 2. Roadmap");
    const slides = pseudoRandomBytes(3 * 1024 * 1024 + 99, 21);
    const planning: FixtureObject = {
      path: "calendar/Kalender/Planning.0010.json",
      type: "event",
      id: "EV10",
      metadata: { calendarName: "Kalender", isDefaultCalendar: "true", hasAttachments: "true" },
      content: JSON.stringify({
        event: {
          subject: "Planning",
          hasAttachments: true,
          start: { dateTime: "2026-03-02T10:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-03-02T11:00:00.0000000", timeZone: "UTC" },
        },
        exceptions: [],
      }),
    };
    // Shaped like the calendar backup writes them: the bytes, the event they belong to.
    const attachment = (id: string, name: string, content: Buffer, contentType: string) => ({
      path: `calendar/Kalender/Planning.0010.attachments/${name}`,
      type: "event-attachment",
      id,
      content,
      metadata: {
        eventItemId: "EV10",
        name,
        contentType,
        attachmentType: "#microsoft.graph.fileAttachment",
      },
    });
    fixture = await createSnapshotFixture({
      kind: "mailbox",
      externalId: USER,
      objects: [
        planning,
        attachment("EA1", "agenda.txt", agenda, "text/plain"),
        attachment("EA2", "slides.pptx", slides, "application/vnd.ms-powerpoint"),
      ],
    });
    const mailbox = new FakeMailbox();
    mailbox.failAttachmentFragmentsAt.push(12 * 320 * 1024);

    const report = await new ExchangeRestoreEngine({
      graph: () => mailbox.graph.client(),
      fragmentRetryDelayMs: 0,
      unknownOutcomeLooksMs: NO_WAITS,
    }).run(fixture.ctx, restoreRequestFor(fixture, { mode: "skip" }));

    expect(report.failures).toEqual([]);
    const event = must([...mailbox.events.values()].find((e) => e.body.subject === "Planning"));
    const stored = event.attachments.map((entry) => ({
      name: entry.name,
      sha256: sha256(Buffer.from(String(entry.contentBytes), "base64")),
    }));
    expect(stored).toEqual([
      { name: "agenda.txt", sha256: sha256(agenda) },
      { name: "slides.pptx", sha256: sha256(slides) },
    ]);
    expect(mailbox.graph.callsTo("POST", "/attachments/createUploadSession")).toHaveLength(1);
    const item = (id: string) => must(report.items.find((entry) => entry.id === id));
    expect(item("EV10")).toMatchObject({ status: "restored", verified: true });
    expect(item("EA1")).toMatchObject({ status: "restored", verified: true });
    expect(item("EA2")).toMatchObject({ status: "restored", verified: true });

    // Selected on its own, an attachment says it comes with its event.
    const alone = await engineFor(new FakeMailbox()).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "skip", selection: { objectIds: ["EA1"] } }),
    );
    expect(alone.items[0]).toMatchObject({ status: "skipped", code: "parent_not_restored" });
  });

  it("does not confirm an event whose attachments the backup does not hold", async () => {
    const withFiles: FixtureObject = {
      path: "calendar/Kalender/Review.0011.json",
      type: "event",
      id: "EV11",
      metadata: { calendarName: "Kalender", isDefaultCalendar: "true" },
      content: JSON.stringify({
        event: {
          subject: "Review",
          hasAttachments: true,
          start: { dateTime: "2026-03-03T10:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-03-03T11:00:00.0000000", timeZone: "UTC" },
        },
        exceptions: [],
      }),
    };
    fixture = await createSnapshotFixture({
      kind: "mailbox",
      externalId: USER,
      objects: [withFiles, dentist],
    });
    const mailbox = new FakeMailbox();

    const report = await engineFor(mailbox).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "skip" }),
    );

    expect(report.failures).toEqual([]);
    const review = must(report.items.find((entry) => entry.id === "EV11"));
    expect(review).toMatchObject({ status: "restored", code: "unverified", verified: false });
    expect(review.reason).toMatch(/had attachments, but they were not part of the backup/);
    // An event without attachments stays confirmed.
    expect(must(report.items.find((entry) => entry.id === "EV2")).verified).toBe(true);
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

  it("restores a JSON-fallback message as received mail: x- headers only, not a draft, with its dates", async () => {
    // The object exactly as the backup writes it when Graph refuses the MIME
    // export: getMessage with MESSAGE_SELECT, body and internetMessageHeaders.
    const backedUp = {
      "@odata.etag": 'W/"CQAAABYAAAA"',
      id: "AAMkAGI2THVSAAA=",
      internetMessageId: "<big-12@contoso.example>",
      conversationId: "AAQkAGI2conv",
      conversationIndex: "AQHbQ1",
      subject: "Quarterly figures",
      from: { emailAddress: { name: "Bob", address: "bob@contoso.example" } },
      sender: { emailAddress: { name: "Bob", address: "bob@contoso.example" } },
      toRecipients: [{ emailAddress: { name: "Anna", address: USER } }],
      ccRecipients: [],
      bccRecipients: [],
      replyTo: [],
      receivedDateTime: "2026-03-02T08:15:42Z",
      sentDateTime: "2026-03-02T08:15:30Z",
      createdDateTime: "2026-03-02T08:15:43Z",
      lastModifiedDateTime: "2026-03-02T09:00:00Z",
      isRead: true,
      isDraft: false,
      flag: { flagStatus: "notFlagged" },
      categories: [],
      importance: "normal",
      hasAttachments: false,
      parentFolderId: "AAMkInbox",
      body: { contentType: "html", content: "<p>Figures attached</p>" },
      internetMessageHeaders: [
        { name: "Received", value: "from EUR01-HE1.outbound.protection.outlook.com by ..." },
        { name: "DKIM-Signature", value: "v=1; a=rsa-sha256; d=contoso.example; s=selector1" },
        { name: "Message-ID", value: "<big-12@contoso.example>" },
        { name: "From", value: "Bob <bob@contoso.example>" },
        { name: "X-MS-Exchange-Organization-AuthAs", value: "Anonymous" },
        { name: "X-Mailer", value: "Contoso Mailer 4.2" },
        { name: "x-ticket-id", value: "T-4711" },
      ],
    };
    const quarterly: FixtureObject = {
      path: "mail/Posteingang/Quarterly figures.0012.json",
      type: "mail",
      id: "AAMk12",
      metadata: {
        subject: "Quarterly figures",
        receivedDateTime: "2026-03-02T08:15:42Z",
        isRead: "true",
        isDraft: "false",
        flagStatus: "notFlagged",
        categories: "[]",
        hasAttachments: "false",
        messageId: "<big-12@contoso.example>",
        folderPath: "Posteingang",
        wellKnownFolder: "inbox",
        format: "json",
        contentType: "application/json",
        attachmentCount: "0",
      },
      content: JSON.stringify(backedUp),
    };
    fixture = await createSnapshotFixture({
      kind: "mailbox",
      externalId: USER,
      objects: [quarterly],
    });
    const mailbox = new FakeMailbox();

    const report = await engineFor(mailbox).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "skip" }),
    );

    expect(report.failures).toEqual([]);
    expect(report.restored).toBe(1);
    const restored = must([...mailbox.messages.values()][0]);
    expect(restored.json?.internetMessageHeaders).toEqual([
      { name: "X-Mailer", value: "Contoso Mailer 4.2" },
      { name: "x-ticket-id", value: "T-4711" },
    ]);
    expect(restored.json?.singleValueExtendedProperties).toEqual([
      { id: "Integer 0x0E07", value: "1" },
      { id: "SystemTime 0x0E06", value: "2026-03-02T08:15:42.000Z" },
      { id: "SystemTime 0x0039", value: "2026-03-02T08:15:30.000Z" },
    ]);
    expect(restored.isDraft).toBe(false);
    expect(Date.parse(restored.receivedDateTime)).toBe(Date.parse("2026-03-02T08:15:42Z"));
    const item = must(report.items[0]);
    expect(item.verified).toBe(true);
    expect(item.reason).toMatch(/5 transport headers of the original/);
    expect(item.reason).not.toMatch(/draft/);
  });

  it("marks a JSON-fallback message unverified when Exchange keeps it a draft or drops its dates", async () => {
    const plain: FixtureObject = {
      path: "mail/Posteingang/Plain.0013.json",
      type: "mail",
      id: "AAMk13",
      metadata: {
        format: "json",
        isDraft: "false",
        folderPath: "Posteingang",
        wellKnownFolder: "inbox",
      },
      content: JSON.stringify({
        subject: "Plain",
        isDraft: false,
        receivedDateTime: "2026-03-02T08:15:42Z",
        body: { contentType: "text", content: "x" },
      }),
    };
    fixture = await createSnapshotFixture({ kind: "mailbox", externalId: USER, objects: [plain] });
    const mailbox = new FakeMailbox();
    // A Graph that ignores the extended properties on create.
    mailbox.ignoresExtendedProperties = true;

    const report = await engineFor(mailbox).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "skip" }),
    );

    const item = must(report.items[0]);
    expect(item.status).toBe("restored");
    expect(item.verified).toBe(false);
    expect(item.reason).toMatch(/created the restored message as a draft/);
    expect(item.reason).toMatch(/did not take the received date/);
  });

  it("marks a MIME import unverified when Exchange creates a received message as a draft", async () => {
    // A message without Date and From header: Graph imports it as a draft.
    const headless = [
      "Message-ID: <headless@example.org>",
      "Subject: Scanner",
      "MIME-Version: 1.0",
      "Content-Type: text/plain",
      "",
      "scan attached",
      "",
    ].join("\r\n");
    const object = (id: string, isDraft: string | undefined): FixtureObject => ({
      path: `mail/Posteingang/Scanner.${id}.eml`,
      type: "mail",
      id,
      content: headless,
      metadata: {
        messageId: "<headless@example.org>",
        folderPath: "Posteingang",
        wellKnownFolder: "inbox",
        format: "mime",
        ...(isDraft !== undefined ? { isDraft } : {}),
      },
    });
    fixture = await createSnapshotFixture({
      kind: "mailbox",
      externalId: USER,
      objects: [object("AAMk20", "false"), object("AAMk21", "true"), object("AAMk22", undefined)],
    });
    const mailbox = new FakeMailbox();

    const report = await engineFor(mailbox).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "skip" }),
    );

    expect(report.restored).toBe(3);
    const item = (id: string) => must(report.items.find((entry) => entry.id === id));
    expect(item("AAMk20")).toMatchObject({ status: "restored", verified: false });
    expect(item("AAMk20").reason).toMatch(/created the restored message as a draft/);
    // A draft that comes back as a draft is what it was.
    expect(item("AAMk21").verified).toBe(true);
    expect(item("AAMk21").reason ?? "").not.toMatch(/draft/);
    // Unknown draft state: said, not judged.
    expect(item("AAMk22").verified).toBe(true);
    expect(item("AAMk22").reason).toMatch(/shows the restored message as a draft/);
  });

  it("restores a MIME message larger than one Graph request with its attachments, not as a draft", async () => {
    const pdf = pseudoRandomBytes(6 * 1024 * 1024 + 4321, 7);
    const logo = pseudoRandomBytes(2048, 3);
    const forwarded = mimeMessage({ messageId: "<fwd-1@example.org>", subject: "Forwarded" });
    const base64Lines = (bytes: Buffer) => bytes.toString("base64").replace(/.{76}/g, "$&\r\n");
    const big = [
      "Message-ID: <report-6mb@example.org>",
      "Date: Mon, 02 Mar 2026 08:15:30 +0100",
      "From: Bob Example <bob@example.org>",
      "To: Anna Example <anna@example.org>",
      "Cc: Carla <carla@example.org>",
      "Subject: Monatsbericht",
      "X-Mailer: Contoso Mailer 4.2",
      "Received: from mx.example.org by mail.example.org",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="outer"',
      "",
      "--outer",
      'Content-Type: multipart/related; boundary="rel"',
      "",
      "--rel",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<p>Bericht anbei <img src="cid:logo@example.org"></p>',
      "--rel",
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base64",
      "Content-ID: <logo@example.org>",
      "Content-Disposition: inline",
      "",
      base64Lines(logo),
      "--rel--",
      "--outer",
      'Content-Type: application/pdf; name="Bericht.pdf"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="Bericht.pdf"',
      "",
      base64Lines(pdf),
      "--outer",
      "Content-Type: message/rfc822",
      'Content-Disposition: attachment; filename="Forwarded"',
      "",
      forwarded,
      "--outer--",
      "",
    ].join("\r\n");
    const object: FixtureObject = {
      path: "mail/Posteingang/Monatsbericht.0030.eml",
      type: "mail",
      id: "AAMk30",
      content: big,
      metadata: {
        messageId: "<report-6mb@example.org>",
        folderPath: "Posteingang",
        wellKnownFolder: "inbox",
        format: "mime",
        isRead: "true",
        isDraft: "false",
        receivedDateTime: "2026-03-02T07:15:42Z",
      },
    };
    const small: FixtureObject = {
      // 2 MB of MIME: its base64 fits one request.
      path: "mail/Posteingang/Klein.0031.eml",
      type: "mail",
      id: "AAMk31",
      content: [
        "Message-ID: <small-2mb@example.org>",
        "Date: Mon, 02 Mar 2026 08:15:30 +0100",
        "From: Bob Example <bob@example.org>",
        "Subject: Klein",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        "two megabytes",
        "--b",
        "Content-Type: application/octet-stream",
        "Content-Transfer-Encoding: base64",
        'Content-Disposition: attachment; filename="data.bin"',
        "",
        base64Lines(pseudoRandomBytes(1536 * 1024, 9)),
        "--b--",
        "",
      ].join("\r\n"),
      metadata: {
        messageId: "<small-2mb@example.org>",
        folderPath: "Posteingang",
        wellKnownFolder: "inbox",
        format: "mime",
        isDraft: "false",
      },
    };
    fixture = await createSnapshotFixture({
      kind: "mailbox",
      externalId: USER,
      objects: [object, small],
    });
    const mailbox = new FakeMailbox();
    // The PDF's second fragment is refused once with 502, as Exchange's gateway does.
    mailbox.failAttachmentFragmentsAt.push(12 * 320 * 1024);

    const report = await new ExchangeRestoreEngine({
      graph: () => mailbox.graph.client(),
      fragmentRetryDelayMs: 0,
      unknownOutcomeLooksMs: NO_WAITS,
    }).run(fixture.ctx, restoreRequestFor(fixture, { mode: "skip" }));

    expect(report.failures).toEqual([]);
    expect(report.restored).toBe(2);
    // No request body ever exceeded Graph's limit.
    for (const call of mailbox.graph.calls) {
      const length =
        typeof call.body === "string" ? call.body.length : (call.body?.byteLength ?? 0);
      expect(length, call.url).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
    const restored = (id: string) =>
      must(
        [...mailbox.messages.values()].find((m) => m.internetMessageId === id),
        id,
      );

    const report6 = restored("<report-6mb@example.org>");
    expect(report6.mime).toBeUndefined();
    expect(report6.isDraft).toBe(false);
    expect(Date.parse(report6.receivedDateTime)).toBe(Date.parse("2026-03-02T07:15:42Z"));
    expect(report6.json).toMatchObject({
      subject: "Monatsbericht",
      body: { contentType: "html", content: expect.stringContaining("cid:logo@example.org") },
      from: { emailAddress: { address: "bob@example.org", name: "Bob Example" } },
      toRecipients: [{ emailAddress: { address: "anna@example.org", name: "Anna Example" } }],
      ccRecipients: [{ emailAddress: { address: "carla@example.org", name: "Carla" } }],
      internetMessageHeaders: [{ name: "X-Mailer", value: "Contoso Mailer 4.2" }],
    });
    const attachments = report6.attachments.map((a) => ({
      name: a.name,
      contentType: a.contentType,
      isInline: a.isInline,
      contentId: a.contentId,
      sha256: sha256(Buffer.from(String(a.contentBytes), "base64")),
    }));
    expect(attachments).toEqual([
      {
        name: "attachment-1",
        contentType: "image/png",
        isInline: true,
        contentId: "logo@example.org",
        sha256: sha256(logo),
      },
      {
        name: "Bericht.pdf",
        contentType: "application/pdf",
        isInline: false,
        contentId: undefined,
        sha256: sha256(pdf),
      },
      {
        name: "Forwarded.eml",
        contentType: "message/rfc822",
        isInline: false,
        contentId: undefined,
        sha256: sha256(Buffer.from(forwarded)),
      },
    ]);
    // The PDF went through one upload session in fragments of at most 4 MiB; the refused
    // fragment was sent again after the session was asked, not the whole attachment.
    expect(mailbox.graph.callsTo("POST", "/attachments/createUploadSession")).toHaveLength(1);
    expect(
      mailbox.graph.calls
        .filter((call) => call.method === "PUT")
        .map((call) => call.headers["content-range"]),
    ).toEqual([
      `bytes 0-${12 * 320 * 1024 - 1}/${pdf.length}`,
      `bytes ${12 * 320 * 1024}-${pdf.length - 1}/${pdf.length}`,
      `bytes ${12 * 320 * 1024}-${pdf.length - 1}/${pdf.length}`,
    ]);
    expect(mailbox.cancelledUploads).toEqual([]);
    const item = must(report.items.find((entry) => entry.id === "AAMk30"));
    expect(item.verified).toBe(true);
    expect(item.reason).toMatch(/at most 4 MB in one request/);

    // A message below the limit is still imported as MIME, byte for byte.
    expect(restored("<small-2mb@example.org>").mime).toBe(must(small.content).toString());
  });

  it("reports the attachments of a large MIME message that Exchange refuses", async () => {
    const huge = pseudoRandomBytes(5 * 1024 * 1024, 11);
    const object: FixtureObject = {
      path: "mail/Posteingang/Huge.0032.eml",
      type: "mail",
      id: "AAMk32",
      content: [
        "Message-ID: <huge@example.org>",
        "Date: Mon, 02 Mar 2026 08:15:30 +0100",
        "From: Bob Example <bob@example.org>",
        "Subject: Huge",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        "see attachment",
        "--b",
        "Content-Type: application/octet-stream",
        "Content-Transfer-Encoding: base64",
        'Content-Disposition: attachment; filename="huge.bin"',
        "",
        huge.toString("base64"),
        "--b--",
        "",
      ].join("\r\n"),
      metadata: {
        messageId: "<huge@example.org>",
        format: "mime",
        folderPath: "Posteingang",
        wellKnownFolder: "inbox",
      },
    };
    fixture = await createSnapshotFixture({ kind: "mailbox", externalId: USER, objects: [object] });
    const mailbox = new FakeMailbox();
    mailbox.maxAttachmentBytes = 4 * 1024 * 1024;

    const report = await engineFor(mailbox).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "skip" }),
    );

    const item = must(report.items[0]);
    expect(item).toMatchObject({ status: "restored", verified: false });
    expect(item.reason).toMatch(/1 of 1 attachments could not be added \(huge\.bin: /);
  });

  describe("when Exchange carries out a POST but its answer is lost", () => {
    /** A client that never sends a POST twice on its own, as the Graph client does for an unknown outcome. */
    const onceEngine = (mailbox: FakeMailbox) =>
      new ExchangeRestoreEngine({
        graph: () => mailbox.graph.client({ maxRetries: 0 }),
        unknownOutcomeLooksMs: NO_WAITS,
      });

    it("keeps the message the unanswered create made instead of creating a second one", async () => {
      fixture = await createSnapshotFixture({
        kind: "mailbox",
        externalId: USER,
        objects: [kickoff, offer],
      });
      for (const after of ["504", "reset"] as const) {
        const mailbox = new FakeMailbox();
        // The Inbox already holds an older copy of the Kickoff mail: never taken for the new one.
        const older = mailbox.addMessage({
          parentFolderId: "wk-inbox",
          internetMessageId: "<one@example.org>",
        });
        mailbox.failAfterCommit("POST", /\/mailFolders\/[^/]+\/messages$/, after, 2);

        const report = await onceEngine(mailbox).run(
          fixture.ctx,
          restoreRequestFor(fixture, { mode: "rename" }),
        );

        expect(report.failures, after).toEqual([]);
        expect(report.restored, after).toBe(2);
        const restored = [...mailbox.messages.values()].filter((m) => m.id !== older.id);
        expect(restored.map((m) => m.internetMessageId).sort(), after).toEqual([
          "<one@example.org>",
          "<two@example.org>",
        ]);
        for (const item of report.items) {
          expect(item.targetRef, after).not.toBe(older.id);
          // Found, not confirmed: restored, without the green of a confirmed item.
          expect(item, after).toMatchObject({
            status: "restored",
            code: "restored",
            verified: false,
          });
          expect(item.reason, after).toMatch(/did not answer the create.*not created twice/);
        }
        // Flags were applied to the message that was found.
        const kick = must(restored.find((m) => m.internetMessageId === "<one@example.org>"));
        expect(kick.patches).toEqual([
          {
            isRead: false,
            flag: { flagStatus: "flagged" },
            categories: ["Red"],
            importance: "high",
          },
        ]);
      }
    });

    it("keeps looking for a message the mailbox was still importing when the gateway gave up", async () => {
      fixture = await createSnapshotFixture({
        kind: "mailbox",
        externalId: USER,
        objects: [kickoff],
      });
      const mailbox = new FakeMailbox();
      // The import commits, but shows in no list for three more requests (a throttled mailbox).
      mailbox.failAfterCommit("POST", /\/mailFolders\/[^/]+\/messages$/, "504", 1, {
        visibleAfter: 3,
      });

      const report = await onceEngine(mailbox).run(
        fixture.ctx,
        restoreRequestFor(fixture, { mode: "rename" }),
      );

      expect(report.failures).toEqual([]);
      expect([...mailbox.messages.values()]).toHaveLength(1);
      expect(mailbox.graph.callsTo("POST", "/messages")).toHaveLength(1);
      const item = must(report.items.find((entry) => entry.id === "AAMk1"));
      expect(item).toMatchObject({ status: "restored", verified: false });
      expect(item.reason).toMatch(/found by its Message-ID and kept, not created twice/);
    });

    it("never confirms a message sent once more when the first create still made its copy", async () => {
      fixture = await createSnapshotFixture({
        kind: "mailbox",
        externalId: USER,
        objects: [kickoff],
      });
      const mailbox = new FakeMailbox();
      // Hidden during all five looks, there by the time the folder is looked at after the resend.
      mailbox.failAfterCommit("POST", /\/mailFolders\/[^/]+\/messages$/, "504", 1, {
        visibleAfter: 6,
      });

      const report = await onceEngine(mailbox).run(
        fixture.ctx,
        restoreRequestFor(fixture, { mode: "rename" }),
      );

      expect(mailbox.graph.callsTo("POST", "/messages")).toHaveLength(2);
      expect([...mailbox.messages.values()]).toHaveLength(2);
      const item = must(report.items.find((entry) => entry.id === "AAMk1"));
      expect(item).toMatchObject({ status: "restored", verified: false });
      expect(item.reason).toMatch(/the folder holds 2 copies of this message/);
    });

    it("keeps looking for an attachment and a folder the mailbox was still making", async () => {
      const withAttachment: FixtureObject = {
        path: "mail/Posteingang/Projekte/Plan.0042.json",
        type: "mail",
        id: "AAMk42",
        metadata: {
          format: "json",
          messageId: "<plan-42@example.org>",
          folderPath: "Posteingang/Projekte",
          wellKnownFolder: "inbox",
          isDraft: "false",
        },
        content: JSON.stringify({
          subject: "Plan",
          internetMessageId: "<plan-42@example.org>",
          isDraft: false,
        }),
      };
      fixture = await createSnapshotFixture({
        kind: "mailbox",
        externalId: USER,
        objects: [
          withAttachment,
          {
            path: "mail/Posteingang/Projekte/Plan.0042.attachments/plan.txt.aa",
            type: "attachment",
            id: "AAMk42/a1",
            metadata: {
              messagePath: withAttachment.path,
              name: "plan.txt",
              contentType: "text/plain",
            },
            content: "the plan",
          },
        ],
      });
      const mailbox = new FakeMailbox();
      mailbox.failAfterCommit("POST", /\/attachments$/, "504", 1, { visibleAfter: 3 });
      // The restore folder is made, but listed only after the create was sent once more,
      // which Exchange then refuses with 409.
      mailbox.failAfterCommit("POST", /\/mailFolders$/, "504", 1, { visibleAfter: 2 });

      const report = await onceEngine(mailbox).run(
        fixture.ctx,
        restoreRequestFor(fixture, { mode: "rename", requestedAt: NOW }),
      );

      expect(report.failures).toEqual([]);
      expect(
        [...mailbox.folders.values()].filter((f) => f.displayName === RESTORE_FOLDER),
      ).toHaveLength(1);
      const message = must([...mailbox.messages.values()][0]);
      expect(mailbox.folderPath(message.parentFolderId)).toEqual([
        RESTORE_FOLDER,
        "Posteingang",
        "Projekte",
      ]);
      expect(message.attachments).toHaveLength(1);
      expect(mailbox.graph.callsTo("POST", "/attachments")).toHaveLength(1);
    });

    it("keeps looking for an event attachment, and never confirms one that arrived twice", async () => {
      const event: FixtureObject = {
        path: "calendar/Kalender/Review.0011.json",
        type: "event",
        id: "EV11",
        metadata: { calendarName: "Kalender", isDefaultCalendar: "true", hasAttachments: "true" },
        content: JSON.stringify({
          event: {
            subject: "Review",
            hasAttachments: true,
            start: { dateTime: "2026-03-03T10:00:00.0000000", timeZone: "UTC" },
            end: { dateTime: "2026-03-03T11:00:00.0000000", timeZone: "UTC" },
          },
          exceptions: [],
        }),
      };
      fixture = await createSnapshotFixture({
        kind: "mailbox",
        externalId: USER,
        objects: [
          event,
          {
            path: "calendar/Kalender/Review.0011.attachments/notes.txt",
            type: "event-attachment",
            id: "EA11",
            content: "notes",
            metadata: {
              eventItemId: "EV11",
              name: "notes.txt",
              contentType: "text/plain",
              attachmentType: "#microsoft.graph.fileAttachment",
            },
          },
        ],
      });
      for (const [visibleAfter, twice] of [
        [3, false],
        [6, true],
      ] as const) {
        const mailbox = new FakeMailbox();
        mailbox.failAfterCommit("POST", /\/events\/[^/]+\/attachments$/, "504", 1, {
          visibleAfter,
        });
        const report = await onceEngine(mailbox).run(
          fixture.ctx,
          restoreRequestFor(fixture, { mode: "skip" }),
        );
        const restored = must([...mailbox.events.values()][0]);
        expect(restored.attachments).toHaveLength(twice ? 2 : 1);
        const attachment = must(report.items.find((item) => item.id === "EA11"));
        const owner = must(report.items.find((item) => item.id === "EV11"));
        expect(attachment.verified).toBe(!twice);
        expect(owner.verified).toBe(!twice);
        if (twice) {
          expect(owner.reason).toMatch(/1 attachments are on the restored event twice/);
          expect(attachment.reason).toMatch(/holds this attachment twice/);
        }
      }
    });

    it("never sends a message without Message-ID twice", async () => {
      const anonymous: FixtureObject = {
        ...offer,
        path: "mail/Gesendete Elemente/Anonymous.0040.eml",
        id: "AAMk40",
        content:
          "Subject: no id\r\nFrom: a@example.org\r\nDate: Thu, 15 Jan 2026 10:30:00 +0000\r\n\r\nbody\r\n",
        metadata: {
          folderPath: "Gesendete Elemente",
          wellKnownFolder: "sentitems",
          format: "mime",
        },
      };
      fixture = await createSnapshotFixture({
        kind: "mailbox",
        externalId: USER,
        objects: [anonymous],
      });
      const mailbox = new FakeMailbox();
      mailbox.failAfterCommit("POST", /\/messages$/);

      const report = await onceEngine(mailbox).run(fixture.ctx, restoreRequestFor(fixture));

      expect(mailbox.messages.size).toBe(1);
      expect(report.items[0]?.status).toBe("failed");
      expect(report.items[0]?.reason).toMatch(/not sent again so that no second copy is made/);
    });

    it("takes the folder an unanswered POST created, also when the resend gets 409", async () => {
      fixture = await createSnapshotFixture({
        kind: "mailbox",
        externalId: USER,
        objects: [kickoff],
      });
      // The Graph client of today resends after the 504 and Exchange answers 409.
      const resent = new FakeMailbox();
      resent.failAfterCommit("POST", /\/childFolders$|\/mailFolders$/);
      const first = await engineFor(resent).run(
        fixture.ctx,
        restoreRequestFor(fixture, { mode: "rename", requestedAt: NOW }),
      );
      // Without a resend: the folder is looked up again.
      const once = new FakeMailbox();
      once.failAfterCommit("POST", /\/childFolders$|\/mailFolders$/, "504", 3);
      const second = await onceEngine(once).run(
        fixture.ctx,
        restoreRequestFor(fixture, { mode: "rename", requestedAt: NOW }),
      );

      for (const [report, mailbox] of [
        [first, resent],
        [second, once],
      ] as const) {
        expect(report.failures).toEqual([]);
        expect(report.restored).toBe(1);
        const message = must([...mailbox.messages.values()][0]);
        expect(mailbox.folderPath(message.parentFolderId)).toEqual([
          RESTORE_FOLDER,
          "Posteingang",
          "Projekte",
        ]);
        expect(
          [...mailbox.folders.values()].filter((f) => f.displayName === RESTORE_FOLDER),
        ).toHaveLength(1);
      }
    });

    it("sends an unanswered event once more with the same transactionId", async () => {
      fixture = await createSnapshotFixture({
        kind: "mailbox",
        externalId: USER,
        objects: [dentist],
      });
      const mailbox = new FakeMailbox();
      mailbox.failAfterCommit("POST", /\/events$/);

      const report = await onceEngine(mailbox).run(
        fixture.ctx,
        restoreRequestFor(fixture, { mode: "skip" }),
      );

      expect(report.failures).toEqual([]);
      expect(mailbox.events.size).toBe(1);
      const posts = mailbox.graph.callsTo("POST", "/events");
      expect(posts).toHaveLength(2);
      const ids = posts.map((post) => (post.json as { transactionId: string }).transactionId);
      expect(ids[0]).toBe(ids[1]);
    });

    it("keeps the contact and the attachment an unanswered POST made", async () => {
      const withAttachment: FixtureObject = {
        path: "mail/Posteingang/Plan.0041.json",
        type: "mail",
        id: "AAMk41",
        metadata: {
          format: "json",
          messageId: "<plan@example.org>",
          folderPath: "Posteingang",
          wellKnownFolder: "inbox",
          isDraft: "false",
        },
        content: JSON.stringify({
          subject: "Plan",
          internetMessageId: "<plan@example.org>",
          isDraft: false,
        }),
      };
      fixture = await createSnapshotFixture({
        kind: "mailbox",
        externalId: USER,
        objects: [
          withAttachment,
          {
            path: "mail/Posteingang/Plan.0041.attachments/plan.txt.aa",
            type: "attachment",
            id: "AAMk41/a1",
            metadata: {
              messagePath: withAttachment.path,
              name: "plan.txt",
              contentType: "text/plain",
            },
            content: "the plan",
          },
          clientsFolder,
          ben,
        ],
      });
      const mailbox = new FakeMailbox();
      // An older Ben in the folder is never mistaken for the one this run made.
      const clients = mailbox.addContactFolder("Clients", null);
      const olderBen = mailbox.addContact(clients.id, {
        displayName: "Ben Example",
        emailAddresses: [{ address: "ben@example.org" }],
      });
      mailbox.failAfterCommit("POST", /\/attachments$/);
      mailbox.failAfterCommit("POST", /\/contacts$/);

      const report = await onceEngine(mailbox).run(
        fixture.ctx,
        restoreRequestFor(fixture, { mode: "rename" }),
      );

      expect(report.failures).toEqual([]);
      const message = must([...mailbox.messages.values()][0]);
      expect(message.attachments).toHaveLength(1);
      expect(mailbox.contacts.size).toBe(2);
      const contact = must(report.items.find((item) => item.id === "C1"));
      expect(contact.status).toBe("restored");
      expect(contact.targetRef).not.toBe(olderBen.id);
      expect(contact).toMatchObject({ code: "restored", verified: false });
      expect(contact.reason).toMatch(/found by its name and address/);
    });
  });

  it("finishes a message an interrupted attempt created without all its attachments", async () => {
    const report: FixtureObject = {
      path: "mail/Posteingang/Report.0050.json",
      type: "mail",
      id: "AAMk50",
      metadata: {
        format: "json",
        messageId: "<report-50@example.org>",
        folderPath: "Posteingang",
        wellKnownFolder: "inbox",
        isDraft: "false",
        isRead: "true",
      },
      content: JSON.stringify({
        subject: "Report",
        internetMessageId: "<report-50@example.org>",
        isDraft: false,
        receivedDateTime: "2026-03-02T08:15:42Z",
      }),
    };
    const attachment = (name: string, content: string): FixtureObject => ({
      path: `mail/Posteingang/Report.0050.attachments/${name}.aa`,
      type: "attachment",
      id: `AAMk50/${name}`,
      metadata: { messagePath: report.path, name, contentType: "text/plain" },
      content,
    });
    fixture = await createSnapshotFixture({
      kind: "mailbox",
      externalId: USER,
      now: () => NOW,
      objects: [report, attachment("a.txt", "first"), attachment("b.txt", "second")],
    });
    for (const keepRecord of [true, false]) {
      const mailbox = new FakeMailbox();
      mailbox.interruptAt("POST", /\/attachments$/, 2);
      const request = restoreRequestFor(fixture, { mode: "rename" });
      await expect(engineFor(mailbox).run(fixture.ctx, request)).rejects.toThrow(/stopped/);
      expect(must([...mailbox.messages.values()][0]).attachments).toHaveLength(1);
      if (!keepRecord) {
        await fixture.ctx.cursor.clear();
      }

      const retry = await engineFor(mailbox).run(fixture.ctx, request);

      expect(retry.failures, String(keepRecord)).toEqual([]);
      expect(mailbox.messages.size, String(keepRecord)).toBe(1);
      const message = must([...mailbox.messages.values()][0]);
      expect(
        message.attachments.map((a) => a.name),
        String(keepRecord),
      ).toEqual(["a.txt", "b.txt"]);
      const item = must(retry.items.find((entry) => entry.id === "AAMk50"));
      expect(item, String(keepRecord)).toMatchObject({ status: "restored", verified: false });
      expect(item.reason, String(keepRecord)).toMatch(
        keepRecord
          ? /earlier attempt of this job created the message/
          : /found in the restore folder/,
      );
      expect(retry.items.find((entry) => entry.id === "AAMk50/a.txt")?.reason).toMatch(
        /added by an earlier attempt/,
      );
      // The finished message is done: a third attempt restores nothing again.
      const third = await engineFor(mailbox).run(fixture.ctx, request);
      expect(third.items.find((entry) => entry.id === "AAMk50")?.reason).toBe(
        "restored by an earlier attempt of this job",
      );
      expect(message.attachments).toHaveLength(2);
      await fixture.ctx.cursor.clear();
    }
  });

  it("does not create a message without Message-ID again on a retry it already restored", async () => {
    const anonymous: FixtureObject = {
      path: "mail/Archiv/Scan.0051.eml",
      type: "mail",
      id: "AAMk51",
      content:
        "Subject: Scan\r\nFrom: scanner@example.org\r\nDate: Thu, 15 Jan 2026 10:30:00 +0000\r\n\r\npage\r\n",
      metadata: {
        folderPath: "Archiv",
        format: "mime",
        isDraft: "false",
      },
    };
    fixture = await createSnapshotFixture({
      kind: "mailbox",
      externalId: USER,
      now: () => NOW,
      objects: [anonymous, kickoff],
    });
    const mailbox = new FakeMailbox();
    // The attempt stops when it creates the second message, after the first was restored.
    mailbox.interruptAt("POST", /\/messages$/, 2);
    const request = restoreRequestFor(fixture, { mode: "rename" });
    await expect(engineFor(mailbox).run(fixture.ctx, request)).rejects.toThrow(/stopped/);
    expect(mailbox.messages.size).toBe(1);

    const retry = await engineFor(mailbox).run(fixture.ctx, request);

    expect(retry.failures).toEqual([]);
    expect(mailbox.messages.size).toBe(2);
    expect(retry.items.find((item) => item.id === "AAMk51")?.reason).toBe(
      "restored by an earlier attempt of this job",
    );
  });

  it("restores an IMAP backup into Microsoft 365 by meaning: SPECIAL-USE, unescaped names, flags", async () => {
    const sentFolder: FixtureObject = {
      path: "mail/Gesendet",
      type: "folder",
      id: "imap:Gesendet:7",
      content: "",
      metadata: { mailbox: "Gesendet", delimiter: ".", uidValidity: "7", specialUse: "\\Sent" },
    };
    const imapMessage = (
      mailbox: string,
      path: string,
      uid: number,
      flags: string,
    ): FixtureObject => ({
      path,
      type: "message",
      id: `imap:${mailbox}:7:${uid}`,
      content: mimeMessage({ messageId: `<imap-${uid}@example.org>`, subject: `IMAP ${uid}` }),
      metadata: {
        mailbox,
        delimiter: ".",
        uid: String(uid),
        uidValidity: "7",
        flags,
        messageId: `<imap-${uid}@example.org>`,
      },
    });
    fixture = await createSnapshotFixture({
      kind: "imap",
      externalId: "anna",
      objects: [
        sentFolder,
        imapMessage("Gesendet", "mail/Gesendet/1.eml", 1, "\\Seen"),
        imapMessage("Kunden.A/B 100%", "mail/Kunden/A%2FB 100%25/2.eml", 2, "\\Flagged"),
      ],
    });
    const mailbox = new FakeMailbox();

    const report = await engineFor(mailbox).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "skip", target: { type: "other", ref: USER } }),
    );

    expect(report.failures).toEqual([]);
    const sent = must([...mailbox.messages.values()].find((m) => m.subject === "IMAP 1"));
    expect(sent.parentFolderId).toBe("wk-sentitems");
    expect(sent.patches).toEqual([{ isRead: true, flag: { flagStatus: "notFlagged" } }]);
    const client = must([...mailbox.messages.values()].find((m) => m.subject === "IMAP 2"));
    expect(mailbox.folderPath(client.parentFolderId)).toEqual(["Kunden", "A/B 100%"]);
    expect(client.patches).toEqual([{ isRead: false, flag: { flagStatus: "flagged" } }]);
  });

  it("restores a per-label Gmail backup once per message, its labels as categories", async () => {
    const gmail = (
      mailbox: string,
      uid: number,
      id: string,
      specialUse?: string,
      flags = "\\Seen",
    ): FixtureObject => ({
      path: `mail/${mailbox}/${uid}.eml`,
      type: "message",
      id: `imap:${mailbox}:9:${uid}`,
      content: mimeMessage({ messageId: `<${id}@example.org>`, subject: `Gmail ${id}` }),
      metadata: {
        mailbox,
        delimiter: "/",
        uid: String(uid),
        uidValidity: "9",
        flags,
        messageId: `<${id}@example.org>`,
        ...(specialUse ? { specialUse } : {}),
      },
    });
    const folder = (mailbox: string, specialUse?: string): FixtureObject => ({
      path: `mail/${mailbox}`,
      type: "folder",
      id: `imap:${mailbox}:9`,
      content: "",
      metadata: {
        mailbox,
        delimiter: "/",
        uidValidity: "9",
        ...(specialUse ? { specialUse } : {}),
      },
    });
    fixture = await createSnapshotFixture({
      kind: "imap",
      externalId: "anna@gmail.example",
      objects: [
        folder("[Gmail]/All Mail", "\\All"),
        folder("[Gmail]/Important", "\\Important"),
        gmail("INBOX", 1, "a", "\\Inbox"),
        gmail("[Gmail]/All Mail", 11, "a", "\\All"),
        gmail("Kunden", 21, "a"),
        gmail("[Gmail]/Important", 31, "a", "\\Important"),
        gmail("[Gmail]/All Mail", 12, "b", "\\All"),
        gmail("[Gmail]/Sent Mail", 41, "c", "\\Sent"),
        gmail("[Gmail]/All Mail", 13, "c", "\\All"),
      ],
    });
    const mailbox = new FakeMailbox();
    mailbox.addFolder("Archive", null, "wk-archive");

    const report = await engineFor(mailbox).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "skip", target: { type: "other", ref: USER } }),
    );

    expect(report.failures).toEqual([]);
    // Three messages, three creates: not one per label plus one for All Mail.
    expect(mailbox.messages.size).toBe(3);
    expect(report.restored).toBe(3);
    const a = must([...mailbox.messages.values()].find((m) => m.subject === "Gmail a"));
    expect(a.parentFolderId).toBe("wk-inbox");
    expect(a.patches).toEqual([
      { isRead: true, flag: { flagStatus: "notFlagged" }, categories: ["Kunden", "Important"] },
    ]);
    const b = must([...mailbox.messages.values()].find((m) => m.subject === "Gmail b"));
    expect(b.parentFolderId).toBe("wk-archive");
    const c = must([...mailbox.messages.values()].find((m) => m.subject === "Gmail c"));
    expect(c.parentFolderId).toBe("wk-sentitems");
    const item = (path: string) => must(report.items.find((entry) => entry.path === path));
    expect(item("mail/INBOX/1.eml").reason).toMatch(
      /Gmail labels kept as categories: Kunden, Important/,
    );
    expect(item("mail/Kunden/21.eml")).toMatchObject({ status: "skipped", code: "exists" });
    expect(item("mail/Kunden/21.eml").reason).toMatch(
      /label "Kunden" is kept as the category "Kunden"/,
    );
    expect(item("mail/[Gmail]/Important").reason).toMatch(/is a label, not a folder/);
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
    const recorded = await engineFor(retried).run(fixture.ctx, request);
    expect(recorded.restored).toBe(2);
    expect(retried.messages.size).toBe(2);
    // Without the job's record (an attempt that ended before it was saved), by Message-ID.
    await fixture.ctx.cursor.clear();
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
    await fixture.ctx.cursor.clear();
    const legacyRetry = await engineFor(replayed).run(fixture.ctx, legacyRequest);
    expect(legacyRetry.skipped).toBe(2);
    expect(
      legacyRetry.items.every((skipped) => skipped.reason?.includes('ran as "rename" instead')),
    ).toBe(true);

    await fixture.ctx.cursor.clear();
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
